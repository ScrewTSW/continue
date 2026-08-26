# Attack plan: esbuild `--minify`

**Status: tested.** Verified against a 2,650,012-byte VSCode extension bundle
(`anthropic.claude-code-2.1.220`), 2026-08.

## Fingerprint

All of these together:

```bash
head -c 300 bundle.js          # prologue below
grep -c "^// " bundle.js       # 0
grep -c "sourceMappingURL" bundle.js   # 0
grep -c "__webpack_require__" bundle.js # 0
```

The esbuild prologue is distinctive — a destructured `Object` capture followed by
short helper arrows:

```js
var H0e = Object.create;
var {
    getPrototypeOf: G0e,
    defineProperty: bg,
    getOwnPropertyNames: XG,
    getOwnPropertyDescriptor: W0e,
  } = Object,
  YG = Object.prototype.hasOwnProperty;
```

A `__EXT_BUNDLE_URL` / `pathToFileURL(__filename)` preamble indicates a VSCode
extension host bundle specifically.

## What is recoverable

| Asset                | Recoverable    | Notes                                                                |
| -------------------- | -------------- | -------------------------------------------------------------------- |
| String literals      | **Yes, fully** | Error text, config keys, schema `.describe()` strings, package names |
| Control flow         | **Yes**        | webcrack undoes comma-sequences, ternaries, `void 0`                 |
| Module boundaries    | **No**         | `--minify` strips `// node_modules/...` comments                     |
| Identifier names     | **No**         | Permanently mangled; no sourcemap                                    |
| Cross-module meaning | **No**         | Export stubs may have no read site in this bundle                    |

**Consequence: strings are the entire navigation surface.** Plan around them.

## Procedure

### 1. Triage by string, before any transform

Highest-yield step; frequently ends the task.

```bash
grep -c -i "TERM" orig.js                 # count first, always
grep -n -i "TERM" orig.js | head -20      # then locate
```

Enumerate the vocabulary when you do not yet know the term:

```bash
grep -oE '"[a-z0-9@/_-]{4,40}"' orig.js | sort | uniq -c | sort -rn | head -30
```

Dense repeats reveal vendored libraries — e.g. thousands of `"iana"` implies
mime-db; `invalid_type` / `too_small` / `unrecognized_keys` implies Zod, which in
turn means schema `.describe()` strings are present and are the richest
documentation in the file.

Identify the bundle itself:

```bash
grep -oE '"@[a-z0-9-]+/[a-z0-9-]+"' orig.js | sort -u | head
```

### 2. Beautify only if you need line numbers

```bash
npx --yes webcrack orig.js -o wc-out      # ~10s on 2.65MB, 74k changes
cp wc-out/deobfuscated.js pass2.js
npx --yes prettier@3 --write pass2.js --log-level warn
node --check pass2.js && echo VALID
```

Measured: 907 → 154,720 → 166,985 lines. Longest line 156,328 → 1,524 chars
(the residual long lines are embedded help text, not code). 500-line chunk ≈ 2,872 tokens.

webcrack reports `String Array: no` for esbuild output — that detector targets
javascript-obfuscator and finding nothing here is expected, not a failure.

### 3. Read bounded windows

```bash
grep -n "sandbox" pass2.js | head
sed -n '139700,139780p' pass2.js
```

## Gotchas specific to this stack

**Module duplication.** webcrack emitted two near-identical copies of several
modules on the reference bundle (hits at both ~49xxx and ~127xxx). Grep counts
double. Confirm a definition is unique before calling it _the_ definition.

**Zod schemas are the documentation.** When the bundle uses Zod, `.describe()`
strings often state the security model, defaults, and trust tiers in prose. Far
higher yield than reading the validation code.

**Export stubs dead-end.** `CLAUDE_CODE_SANDBOXED: () => I5e` resolving to
`var Nkt = b.bool();` with no read site means the consumer is another process.
Stop chasing; note it and move on.

**Declared ≠ enforced.** This bundle carried a full sandbox config schema while
enforcement lived in a separate CLI binary. Report which you verified.

## Worked example

Question: _how does the sandbox configuration work?_

```bash
grep -c -i "sandbox" orig.js        # 33 — small enough to enumerate
grep -n -i "sandbox" orig.js | head -20
```

33 hits clustered in one region → beautify → `grep -n "sandbox" pass2.js` →
`sed -n` windows over the Zod schema at 139574–139766. Answer obtained reading
~600 lines of a 166,985-line file, ~32k tokens total including exploration.
