---
name: deminifying-javascript-bundles
description: Use when reading, auditing, or reverse-engineering a minified, bundled, or obfuscated JavaScript file — VSCode extension bundles, webview bundles, dist output, vendor.js, or any single-file build with very long lines — especially when a read attempt hung, was killed, or blew the context window, or when verifying a change landed in built output
license: Apache-2.0
---

# De-minifying JavaScript Bundles

## Overview

A minified bundle is a context-window hazard before it is a comprehension problem. A 2.65 MB bundle is roughly 1.25 million tokens: reading it whole is impossible at any context size, and _attempting_ it destroys the session — the tool call never returns, so nothing is rendered and the model cannot even see why it failed.

**Core principle: never let the bundle into context. Extract from it.**

The goal is not a readable copy of the whole file. The goal is answering a specific question while reading only kilobytes.

## The Iron Law

**NEVER read, cat, or head a minified bundle directly.**

Not with `head -300`. Not "just to check the format". Not "the first few lines are probably fine".

`head -N` counts **lines**, and minified bundles have almost none. A real measured case: 2,650,012 bytes in **907 lines**, longest line **156,328 characters**. `head -300` there returns most of the file. Any line-based limit is meaningless on minified JS.

Use `wc`, `awk 'length($0)'`, `grep -c`, and byte-bounded slices instead. Every command in this skill is safe on a multi-megabyte single-line file.

## Step 1: Preflight — do I have the tools?

Check before planning, because the answer changes the plan. A missing toolchain means falling back to grep-only extraction, which works but yields no line numbers.

```bash
node --version && npm --version          # need node for every tool below
timeout 10 npm ping                      # registry reachable? npx needs it
ls ~/.npm/_npx 2>/dev/null | head        # cached packages if offline
```

| Result                                                     | Plan                                         |
| ---------------------------------------------------------- | -------------------------------------------- |
| node + registry                                            | Full pipeline (Step 5). Best outcome.        |
| node, no registry, but `~/.npm/_npx` has webcrack/prettier | Full pipeline offline via `npx --no-install` |
| node, no registry, no cache                                | Grep-only (Step 4). Still effective.         |
| no node                                                    | Grep-only. Python `str.find` for slicing.    |

Do not `npm install -g`. Use `npx --yes <tool>` — no environment mutation.

## Step 2: Pick the right bundle first

**A package usually ships more than one bundle, and the entry point is rarely the
one you want.** Confirm the target holds the code you are hunting before spending
a beautify cycle on it.

```bash
find "$PKG" -name "*.js" -size +100k | head       # every large bundle
du -sh "$PKG"/*                                   # where the weight actually is
```

For a VSCode extension, `extension.js` is the **extension host** bundle —
activation, commands, and node APIs. Any React/webview UI lives in a _separate_
bundle it points at. Cheap discriminator:

```bash
grep -c "useState\|createElement" bundle.js   # ~0 = no UI here, wrong file
```

If that returns near zero and you are looking for UI, find the real one:

```bash
grep -n "joinPath\|asWebviewUri" extension.js | grep -o '"[a-z]*", *"[a-z.]*js"'
```

Measured cost of skipping this step: a full webcrack+prettier cycle on a 2.65 MB
`extension.js` that contained no UI at all (`useState: 0`, `createElement: 2`).
The meter being hunted was in a separate 4.8 MB `webview/index.js`. One `grep -c`
would have redirected the entire effort.

## Step 3: Measure and fingerprint

Never modify the original. Work on a copy, always.

```bash
cp bundle.js /tmp/work/orig.js && cd /tmp/work

wc -lc orig.js                                        # bytes and lines
awk '{if(length($0)>m)m=length($0)}END{print m}' orig.js   # longest line
python3 -c "import os;print(int(os.path.getsize('orig.js')/3.2))"  # ~tokens
```

If est. tokens > half your context, the whole-file read is off the table — which is the normal case.

Then fingerprint the stack. These markers are cheap and mutually exclusive:

```bash
grep -c "^// "                orig.js   # esbuild module boundaries (0 = --minify)
grep -c "__webpack_require__" orig.js   # webpack
grep -c "sourceMappingURL"    orig.js   # sourcemap = jackpot, skip everything
grep -c "_interopRequireDefault" orig.js  # babel/rollup CJS interop
```

| Fingerprint                                                                | Attack plan                                                                             |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `sourceMappingURL` present, `.map` file exists                             | **Stop.** Recover original source from the sourcemap. Everything else is wasted effort. |
| `var X=Object.create;var{getPrototypeOf:...}=Object` prologue, zero `^// ` | [stacks/esbuild-minify.md](stacks/esbuild-minify.md) — **tested**                       |
| `__webpack_require__`, numeric module map                                  | [stacks/webpack.md](stacks/webpack.md) — untested                                       |
| Large string array + index-shuffle function at top                         | [stacks/javascript-obfuscator.md](stacks/javascript-obfuscator.md) — untested           |
| Long lines, none of the above                                              | Generic: Step 4, then Step 5                                                            |

## Step 4: Extract without beautifying

**This is the highest-yield step, and it often ends the task.** Do it before beautifying.

**Hunt string literals, not identifiers.** Minification destroys identifiers permanently (`Nkt`, `USt`, `pNt`) but preserves every string: error messages, config keys, URLs, package names, schema descriptions. Strings are the only durable semantic surface.

```bash
grep -c -i "sandbox" orig.js                    # count FIRST — always
grep -n -i "sandbox" orig.js | head -20         # locate, bounded
grep -oE '"[a-z0-9@/_-]{4,40}"' orig.js | sort | uniq -c | sort -rn | head -30
```

**Always bound a grep on a multi-megabyte file** — `| head`, `| wc -l`, or `-c`. An unbounded `grep -n` over a 4 MB file can dump enough to threaten the context limit by itself.

### Hazard: catastrophic regex backtracking

Do **not** use variable-width context patterns on very long lines:

```bash
grep -oE '.{200}sandbox.{400}' orig.js    # HANGS — must be killed
```

On a 156 KB line this backtracks pathologically. Extract context with Python instead:

```python
s = open('orig.js').read()
i = 0
while (i := s.find('sandbox', i)) != -1:
    print(f"--- @{i} ---\n{s[max(0,i-200):i+400]}")
    i += 1
```

`grep -F` (fixed-string) and `grep -c` are safe. Variable-width `-oE` context windows are not.

## Step 5: Multi-pass beautify

Beautify when you need **line numbers to cite**, repeated navigation, or control-flow reading. Each pass recovers something the next cannot.

```bash
# Pass 1 — webcrack: unminify, restore control flow, split modules if metadata survived
npx --yes webcrack orig.js -o wc-out

# Pass 2 — prettier: consistent formatting, break residual long lines
cp wc-out/deobfuscated.js pass2.js
npx --yes prettier@3 --write pass2.js --log-level warn

# Pass 3 — VERIFY. Non-negotiable.
node --check pass2.js && echo VALID || echo BROKEN
```

Measured on the reference bundle (2.65 MB esbuild): 907 lines → 154,720 (webcrack, ~10s, 74k changes) → 166,985 (prettier), `node --check` valid. A 500-line chunk is ~2,872 tokens — safely readable.

**Order matters.** webcrack rewrites the AST (comma-sequences → statements, ternaries → `if`/`else`, `void 0` → `undefined`); prettier only formats. Prettier first wastes the AST work.

### What beautifying does and does not buy

Measured head-to-head, same question, same bundle, minified vs. beautified:

|                      | Minified          | Beautified |
| -------------------- | ----------------- | ---------- |
| Tokens used          | 33,339            | 31,935     |
| Wall clock           | 220s              | 112s       |
| Backtracking hazard  | hit, killed       | none       |
| Citable line numbers | no (byte offsets) | yes        |

**Beautifying does not meaningfully reduce token cost.** It buys addressability, speed, and hazard removal. If you only need one fact, Step 4 alone is often enough — beautifying is a supporting move, not the main one.

**Known cost:** webcrack may duplicate modules. On the reference bundle it emitted two near-identical copies of several modules, so grep hit counts doubled. Line growth is partly inflation, not pure recovery. Verify a hit is unique before treating it as the only definition.

## Step 6: Read in bounded chunks

Never read the beautified file whole either — it is _larger_ than the original.

```bash
grep -n "sandbox" pass2.js | head          # find the line
sed -n '139700,139780p' pass2.js           # read a window
```

Keep windows to ~100–500 lines. Widen only on a specific hit.

## Verifying a change reached built output

The same techniques confirm your own build shipped what you think it did. Never
trust an installer's success message — grep the bundle.

**Search for constants, not source patterns.** Minification rewrites syntax but
preserves numeric and string literals verbatim. A template literal like
`` `M ${x} A ${r} ${r} 0 ...` `` leaves **no** searchable `"A 5 5 0"` in the
output — that check returns zero on a correct build. The constants inside the
expression (`170*(1-`, `70+30*`) survive and do confirm it.

**Pair a positive check with a negative one.** New string present proves the code
exists; old string _absent_ proves the bundle actually got replaced rather than a
stale artifact being reinstalled.

```bash
unzip -o -q built.vsix "extension/gui/assets/index.js" -d /tmp/check
grep -c -F "new string"  /tmp/check/extension/gui/assets/index.js   # want >0
grep -c -F "old string"  /tmp/check/extension/gui/assets/index.js   # want 0
```

## Quick Reference

| Task                 | Command                                                          |
| -------------------- | ---------------------------------------------------------------- |
| Size in tokens       | `python3 -c "import os;print(int(os.path.getsize('f.js')/3.2))"` |
| Longest line         | `awk '{if(length($0)>m)m=length($0)}END{print m}' f.js`          |
| Count before dumping | `grep -c -i TERM f.js`                                           |
| Safe context extract | Python `str.find` + slice                                        |
| Beautify             | `npx --yes webcrack f.js -o out` then `prettier@3 --write`       |
| Verify               | `node --check out.js`                                            |

## Common Mistakes

| Mistake                                 | Reality                                                                |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `head -300` on a bundle                 | Counts lines. 300 lines can be 2 MB. Blows context.                    |
| `grep -oE '.{200}X.{400}'`              | Catastrophic backtracking on long lines. Use Python.                   |
| Unbounded `grep -n`                     | Can dump megabytes. Always `-c` first, then `\| head`.                 |
| Chasing mangled identifiers             | `Nkt`/`USt` are dead ends. Hunt strings.                               |
| Beautifying first                       | Step 4 often answers the question at a fraction of the cost.           |
| Trusting line-count growth              | webcrack can duplicate modules. Growth ≠ pure recovery.                |
| Skipping `node --check`                 | A broken transform silently produces plausible nonsense.               |
| Editing the original                    | Always copy first.                                                     |
| Assuming module boundaries survive      | `--minify` strips `// node_modules/...`. Verify with `grep -c "^// "`. |
| Assuming the entry point is the UI      | `extension.js` is the host bundle. Check `grep -c "useState"` first.   |
| Grepping built output by source pattern | Template literals leave no literal to match. Search constants.         |

## Scope Limits

De-minification recovers _syntax_, never _meaning_:

- **Identifiers are gone forever.** No tool recovers original names without a sourcemap.
- **Cross-module meaning does not survive.** Mangled-name chasing hits a wall fast; an export stub may have no read site in the bundle at all because the consumer is a different process.
- **A bundle may not implement what it declares.** It can carry a config schema while enforcement lives in a separate binary. Do not report a documented guarantee as a verified one — say which you checked.
