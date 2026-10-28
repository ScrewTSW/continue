// Per-binding reference counts via Babel scope info (not regex).
// Keyed by declaration pos, matching extract_identifiers.mjs's `pos`, so the
// output joins straight onto an identifiers.json from the humanify skill.
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
  const require = createRequire(babelFrom.endsWith("/") ? babelFrom : babelFrom + "/");
  parser = require("@babel/parser");
  traverse = require("@babel/traverse").default;
} catch {
  console.error(
    `Could not load @babel/parser + @babel/traverse from ${babelFrom}\n` +
      `Install the humanify-deobfuscate skill and run 'npm install' in its\n` +
      `scripts/ dir, or set BABEL_FROM to a dir with those deps installed.`,
  );
  process.exit(1);
}

const file = process.argv[2];
const out = process.argv[3];
if (!file || !out) {
  console.error("usage: node refcount.mjs <input.js> <out.json> [--min-refs N] [--top-level-only]");
  process.exit(1);
}
const minRefs = process.argv.includes("--min-refs")
  ? Number(process.argv[process.argv.indexOf("--min-refs") + 1])
  : 0;
const topLevelOnly = process.argv.includes("--top-level-only");
const code = readFileSync(file, "utf8");
const ast = parser.parse(code, {
  sourceType: "unambiguous",
  allowReturnOutsideFunction: true,
  errorRecovery: true,
  plugins: ["jsx"],
});

const rows = [];
traverse(ast, {
  Scope({ scope }) {
    for (const name of Object.keys(scope.bindings)) {
      const b = scope.bindings[name];
      const pos = b.identifier.start;
      if (pos == null) continue;
      rows.push({
        pos,
        name,
        kind: b.kind,
        refs: b.references,
        constant: b.constant,
        line: b.identifier.loc?.start.line ?? null,
        // scope depth: 0 = program/top-level
        depth: (() => { let d = 0, s = scope; while (s.parent) { d++; s = s.parent; } return d; })(),
        fnParent: scope.block.type,
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
  r <= 1 ? "1" : r <= 3 ? "2-3" : r <= 10 ? "4-10" : r <= 50 ? "11-50" : r <= 200 ? "51-200" : "200+";
const hist = {};
for (const r of kept) hist[bucket(r.refs)] = (hist[bucket(r.refs)] ?? 0) + 1;

console.log(`bindings: ${total} total, ${kept.length} kept -> ${out}`);
console.log("refs/binding:", ["1", "2-3", "4-10", "11-50", "51-200", "200+"]
  .map((b) => `${b}:${hist[b] ?? 0}`).join("  "));
if (kept.length) {
  console.log("\ntop candidates:");
  for (const r of kept.slice(0, 25)) {
    console.log(
      `  ${r.name.padEnd(8)} refs=${String(r.refs).padEnd(6)} ${r.kind.padEnd(8)} depth=${String(r.depth).padEnd(3)} line=${r.line}`,
    );
  }
}
