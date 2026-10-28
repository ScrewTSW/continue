// Per-binding reference counts via Babel scope info (not regex).
// Keyed by declaration `pos`, matching extract_identifiers.mjs's `pos`, so the
// output joins straight onto an identifiers.json from the humanify skill.
//
// `pos` is Babel's node.start: a UTF-16 code-unit index into the source, NOT a
// UTF-8 byte offset. They coincide only while the preceding text is all ASCII.
// Use it as an opaque join key for the rename map; do not feed it to byte-
// oriented tools (`dd`, `tail -c`, `grep -ob` output) without converting.
//
// Why not grep: a by-name count is contaminated by strings/prose/object keys
// (`the`, `get`, `of` rank at the top of a real bundle) and conflates
// same-named bindings in different scopes. See stacks/semantic-renaming.md
// step 2b.
//
// Usage:
//   node refcount.mjs <input.js> <out.json> [--min-refs N] [--top-level-only]
//
// Borrows Babel from the humanify-deobfuscate skill, which has it installed.
// Override with BABEL_FROM=/path/to/a/dir/containing/node_modules/
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const babelFrom =
  process.env.BABEL_FROM ??
  join(homedir(), ".claude/skills/humanify-deobfuscate/scripts/");
let parser, traverse;
try {
  const require = createRequire(
    babelFrom.endsWith("/") ? babelFrom : babelFrom + "/",
  );
  parser = require("@babel/parser");
  traverse = require("@babel/traverse").default;
} catch {
  console.error(
    `Could not load @babel/parser + @babel/traverse from ${babelFrom}\n` +
      `Install the humanify-deobfuscate skill and run 'npm ci' in its\n` +
      `scripts/ dir, or set BABEL_FROM to a dir with those deps installed.`,
  );
  process.exit(1);
}

const file = process.argv[2];
const out = process.argv[3];
if (!file || !out) {
  console.error(
    "usage: node refcount.mjs <input.js> <out.json> [--min-refs N] [--top-level-only]",
  );
  process.exit(1);
}
let minRefs = 0;
if (process.argv.includes("--min-refs")) {
  const raw = process.argv[process.argv.indexOf("--min-refs") + 1];
  // Reject rather than coerce: Number(undefined) and Number("abc") are both
  // NaN, and `NaN > 0` is false, so a typo would silently disable filtering
  // and dump every binding instead of failing.
  if (!/^\d+$/.test(raw ?? "")) {
    console.error(
      `--min-refs needs a non-negative integer, got: ${raw ?? "(nothing)"}`,
    );
    process.exit(1);
  }
  minRefs = Number(raw);
}
const topLevelOnly = process.argv.includes("--top-level-only");
const code = readFileSync(file, "utf8");
let ast;
try {
  ast = parser.parse(code, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    // Tolerate the odd recoverable oddity in machine-generated code, but do
    // not silently rank bindings from a half-parsed AST - a truncated bundle
    // would yield plausible-looking counts. Errors are checked below, and
    // unrecoverable ones throw here.
    errorRecovery: true,
    plugins: ["jsx"],
  });
} catch (e) {
  const at = e.loc ? ` at line ${e.loc.line}, column ${e.loc.column}` : "";
  console.error(`could not parse ${file}${at}: ${e.message}`);
  console.error("run the beautify pass first, or check the file is complete.");
  process.exit(1);
}

if (ast.errors?.length) {
  console.error(
    `parser reported ${ast.errors.length} error(s); counts would be unreliable:`,
  );
  for (const e of ast.errors.slice(0, 5)) {
    console.error(
      `  ${e.reasonCode ?? "error"} at line ${e.loc?.line}, column ${e.loc?.column}`,
    );
  }
  console.error("fix the input (or re-run the beautify pass) before ranking.");
  process.exit(1);
}

// One row per binding. Babel registers some declarations (notably classes) in
// BOTH the enclosing scope and the declaration's own inner scope, so the same
// binding object is reachable twice during traversal — once at each depth.
// Deduplicate by binding identity, and take depth from the binding's own
// scope so it does not depend on which visit happened to see it first.
const seen = new Set();
const rows = [];
const depthOf = (scope) => {
  let d = 0;
  for (let s = scope; s.parent; s = s.parent) d++;
  return d;
};
traverse(ast, {
  Scope({ scope }) {
    for (const name of Object.keys(scope.bindings)) {
      const b = scope.bindings[name];
      const pos = b.identifier.start;
      if (pos == null || seen.has(b)) continue;
      seen.add(b);
      rows.push({
        pos,
        name,
        kind: b.kind,
        refs: b.references,
        constant: b.constant,
        line: b.identifier.loc?.start.line ?? null,
        // 0 = program/top-level. From b.scope, not the traversed scope.
        depth: depthOf(b.scope),
        fnParent: b.scope.block.type,
      });
    }
  },
});

const total = rows.length;
let kept = rows;
if (topLevelOnly) kept = kept.filter((r) => r.depth === 0);
if (minRefs > 0) kept = kept.filter((r) => r.refs >= minRefs);
kept.sort((a, b) => b.refs - a.refs);

writeFileSync(out, JSON.stringify(kept, null, 2));

const bucket = (r) =>
  r <= 1
    ? "1"
    : r <= 3
      ? "2-3"
      : r <= 10
        ? "4-10"
        : r <= 50
          ? "11-50"
          : r <= 200
            ? "51-200"
            : "200+";
const hist = {};
for (const r of kept) hist[bucket(r.refs)] = (hist[bucket(r.refs)] ?? 0) + 1;

console.log(`bindings: ${total} total, ${kept.length} kept -> ${out}`);
console.log(
  "refs/binding:",
  ["1", "2-3", "4-10", "11-50", "51-200", "200+"]
    .map((b) => `${b}:${hist[b] ?? 0}`)
    .join("  "),
);
if (kept.length) {
  console.log("\ntop candidates:");
  for (const r of kept.slice(0, 25)) {
    console.log(
      `  ${r.name.padEnd(8)} refs=${String(r.refs).padEnd(6)} ${r.kind.padEnd(8)} depth=${String(r.depth).padEnd(3)} line=${r.line}`,
    );
  }
}
