# Attack plan: webpack

**Status: UNTESTED.** Fingerprint is reliable; the procedure below is reasoned
from webpack's structure, not verified on a real bundle. Treat as a starting
hypothesis and correct this file once you have run it.

## Fingerprint

```bash
grep -c "__webpack_require__" bundle.js   # >0
grep -c "webpackJsonp" bundle.js          # >0 on older (webpack <4) builds
grep -oE "webpackChunk[a-zA-Z_]*" bundle.js | sort -u | head
```

## Why this differs from esbuild

webpack keeps an explicit **module registry** — an object or array keyed by
module id, each value a function. That structure survives minification, because
it is runtime-load-bearing rather than cosmetic.

**This is the key difference: module boundaries are recoverable here.** Unlike
esbuild `--minify`, splitting into per-module files is realistic, and webcrack
targets exactly this.

```bash
npx --yes webcrack@2.16.0 bundle.js -o wc-out
find wc-out -type f | head -30      # expect MANY files, not one
```

If `wc-out` contains one file, module extraction did not fire — fall back to the
generic path in the parent skill.

## Expected differences from the esbuild plan

| Aspect           | esbuild `--minify` | webpack (expected)                          |
| ---------------- | ------------------ | ------------------------------------------- |
| Module split     | impossible         | **likely** — registry survives              |
| Per-module files | 1                  | many                                        |
| Path hints       | none               | often, via module ids or `webpackChunkName` |
| Navigation       | strings only       | strings **and** module structure            |

## Procedure sketch

1. Fingerprint, confirm the registry exists.
2. Run webcrack **first** — module splitting is the whole win; do it before any
   string triage, since it turns one huge file into many readable ones.
3. Inspect the file tree for names before grepping content.
4. If split succeeded, read individual modules directly; the parent skill's
   chunking rules may not even be needed.
5. If split failed, fall back to string-hunting per the parent skill.

## Open questions to resolve when tested

- Does webcrack recover meaningful filenames, or only numeric ids?
- Do `webpackChunkName` comments survive production minification?
- Is `node --check` still the right verification for a multi-file output, or is
  a per-file loop needed?
- Does the module-duplication artifact seen with esbuild occur here too?
