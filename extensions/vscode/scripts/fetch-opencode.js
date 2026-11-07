const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const crypto = require("crypto");

const { ProxyAgent } = require("undici");
const { rimrafSync } = require("rimraf");

const MANIFEST_PATH = path.join(__dirname, "..", "opencode-manifest.json");
const CACHE_DIR = path.join(__dirname, "..", "build", "opencode-cache");
const OUTPUT_DIR = path.join(__dirname, "..", "bin", "opencode");

/**
 * Map a VS Code packaging target to its manifest key.
 *
 * The manifest uses VS Code's own target taxonomy (win32, linux, alpine,
 * darwin), so alpine keeps its musl-specific asset instead of collapsing
 * into linux like prepackage.js does for the Node native modules. OpenCode
 * publishes no 32-bit ARM build, so armhf falls back to the arm64 asset —
 * same compromise prepackage.js makes for onnxruntime/sqlite.
 *
 * @param {string} rawTarget platform specific target, e.g. "alpine-x64"
 * @returns {string} manifest target key
 */
function resolveManifestTarget(rawTarget) {
  let [os, arch] = rawTarget.split("-");
  if (!os || !arch) {
    throw new Error(
      `Invalid target: ${JSON.stringify(rawTarget)}. Expected "<platform>-<arch>", e.g. "linux-x64"`,
    );
  }
  if (arch === "armhf") {
    console.warn(
      `[warn] No 32-bit ARM build of opencode exists; using the arm64 binary for ${rawTarget}`,
    );
    arch = "arm64";
  }
  return `${os}-${arch}`;
}

/**
 * Compute the sha256 hex digest of a file.
 * @param {string} filePath
 * @returns {string}
 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Download a file using the fetch API, honoring proxy env vars.
 * @param {string} url
 * @param {string} outputPath
 */
async function downloadFile(url, outputPath) {
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY;
  const agent = proxy ? new ProxyAgent(proxy) : undefined;

  const response = await fetch(url, {
    redirect: "follow",
    dispatcher: agent,
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}, status ${response.status}`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(buffer));
}

/**
 * Fetch the digest GitHub computed for a release asset and check it against
 * the manifest. The manifest is committed to the repo, so this cross-check
 * is what catches a tampered or re-uploaded release artifact: a matching
 * local pin plus a matching remote digest means both sides agree.
 *
 * @param {string} repository e.g. "sst/opencode"
 * @param {string} version e.g. "1.19.5"
 * @param {string} assetName
 * @param {string} expectedSha256 hex digest pinned in the manifest
 */
async function verifyAgainstGitHub(
  repository,
  version,
  assetName,
  expectedSha256,
) {
  const url = `https://api.github.com/repos/${repository}/releases/tags/v${version}`;
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(
      `Failed to look up release ${url}, status ${response.status}. ` +
        "Cannot verify the opencode asset against the release; refusing to continue",
    );
  }

  const release = await response.json();
  const asset = (release.assets || []).find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(
      `Asset ${assetName} not found in release v${version} of ${repository}; it may have been yanked`,
    );
  }
  if (asset.digest !== `sha256:${expectedSha256}`) {
    throw new Error(
      `Digest mismatch for ${assetName}: release says ${asset.digest}, manifest pins sha256:${expectedSha256}`,
    );
  }
}

/**
 * Extract an archive and return the path to the binary it contains.
 * Archives published by opencode place the binary at the root.
 *
 * @param {string} archivePath
 * @param {string} binaryName
 * @param {boolean} isWindowsTarget
 * @returns {string} path to the extracted binary
 */
function extractBinary(archivePath, binaryName, isWindowsTarget) {
  const extractDir = `${archivePath}.extracted`;
  rimrafSync(extractDir);
  fs.mkdirSync(extractDir, { recursive: true });

  const exe = isWindowsTarget ? ".exe" : "";
  // Pick the zip extractor by host, not by archive type: Git Bash on
  // windows-latest does not ship unzip, but Windows ships bsdtar, which
  // reads zip archives. Linux and macOS hosts have unzip.
  const cmd = archivePath.endsWith(".zip")
    ? process.platform === "win32"
      ? `tar -xf "${archivePath}" -C "${extractDir}"`
      : `unzip -o "${archivePath}" -d "${extractDir}"`
    : `tar -xzf "${archivePath}" -C "${extractDir}"`;
  try {
    execSync(cmd, { stdio: "pipe" });
  } catch (err) {
    throw new Error(`Failed to extract ${archivePath}: ${err.message}`);
  }

  const expected = path.join(extractDir, binaryName + exe);
  if (fs.existsSync(expected)) {
    return expected;
  }
  // Fall back to a shallow search in case the archive layout changes.
  for (const entry of fs.readdirSync(extractDir, { recursive: true })) {
    const candidate = path.join(extractDir, String(entry));
    if (
      fs.statSync(candidate).isFile() &&
      path.basename(candidate) === binaryName + exe
    ) {
      return candidate;
    }
  }
  throw new Error(`Binary ${binaryName + exe} not found in ${archivePath}`);
}

/**
 * Download the opencode binary for a target, verifying checksums from both
 * the manifest and the upstream release, and stage it in bin/opencode/.
 *
 * @param {string} rawTarget platform specific target, e.g. "linux-x64"
 */
async function fetchOpenCode(rawTarget) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
  const { repository, version, binaryName, targets } = manifest;

  const manifestTarget = resolveManifestTarget(rawTarget);
  const target = targets[manifestTarget];
  if (!target) {
    throw new Error(
      `No opencode asset pinned for target ${manifestTarget}. ` +
        `Pinned targets: ${Object.keys(targets).join(", ")}`,
    );
  }

  console.log(
    `[info] Fetching opencode ${version} for ${manifestTarget} (${target.asset})`,
  );

  await verifyAgainstGitHub(repository, version, target.asset, target.sha256);

  // Cache the archive so repeated builds don't re-download ~80MB.
  const archivePath = path.join(CACHE_DIR, target.asset);
  if (fs.existsSync(archivePath)) {
    const cached = await sha256File(archivePath);
    if (cached !== target.sha256) {
      console.log("[info] Cached archive is stale, re-downloading");
      fs.rmSync(archivePath);
    }
  }
  if (!fs.existsSync(archivePath)) {
    const url = `https://github.com/${repository}/releases/download/v${version}/${target.asset}`;
    await downloadFile(url, archivePath);
  }

  const actual = await sha256File(archivePath);
  if (actual !== target.sha256) {
    throw new Error(
      `Checksum mismatch for ${target.asset}: expected ${target.sha256}, got ${actual}`,
    );
  }

  const isWindowsTarget = manifestTarget.startsWith("win32");
  const binaryPath = extractBinary(archivePath, binaryName, isWindowsTarget);

  rimrafSync(OUTPUT_DIR);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const dest = path.join(
    OUTPUT_DIR,
    binaryName + (isWindowsTarget ? ".exe" : ""),
  );
  fs.copyFileSync(binaryPath, dest);
  fs.rmSync(`${archivePath}.extracted`, { recursive: true, force: true });
  if (!isWindowsTarget) {
    fs.chmodSync(dest, 0o755);
  }

  console.log(`[info] Staged opencode ${version} at bin/opencode/`);
  return dest;
}

module.exports = { fetchOpenCode, resolveManifestTarget };

// Standalone usage: node scripts/fetch-opencode.js --target linux-x64
if (require.main === module) {
  const args = process.argv.slice(2);
  let rawTarget;
  if (args[0] === "--target") {
    rawTarget = args[1];
  }
  if (!rawTarget) {
    rawTarget = `${process.platform === "win32" ? "win32" : process.platform}-${process.arch === "x64" ? "x64" : "arm64"}`;
    console.log(`[info] No --target given, using host target ${rawTarget}`);
  }

  fetchOpenCode(rawTarget).catch((error) => {
    console.error(`[error] ${error.message}`);
    process.exit(1);
  });
}
