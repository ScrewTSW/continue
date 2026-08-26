# Attack plan: javascript-obfuscator (string-array obfuscation)

**Status: UNTESTED.** Fingerprint is reliable; procedure is reasoned from the
tool's known output, not verified. Correct this file once you have run it.

## Fingerprint

The signature is a large array of strings near the top, plus a shuffle/decode
function and indexed lookups replacing every literal:

```bash
head -c 2000 bundle.js                       # look for a big string array
grep -oE "_0x[0-9a-f]{4,6}" bundle.js | sort -u | head   # hex identifiers
```

Hallmarks:

- `var _0x1a2b=['...','...','...',...]` — hundreds of entries
- an IIFE that rotates the array by a numeric constant
- a decoder `_0x4f2a(idx, key)`, sometimes base64 or RC4
- literals replaced by `_0x4f2a(0x1)` calls throughout

Authoritative check — webcrack reports it explicitly:

```bash
npx --yes webcrack bundle.js -o wc-out 2>&1 | grep -i "string array"
```

`String Array: yes` confirms this stack. (`no` is what plain esbuild/webpack
minification reports.)

## Why this is fundamentally different

**Step 3 of the parent skill does not work here.** String-hunting is the core
technique everywhere else, and this stack is built specifically to defeat it.
Every literal has been moved into the array and replaced by a call, so
`grep -i "sandbox"` returns nothing even when the string is present.

**Decoding is therefore mandatory, not optional** — the inverse of the esbuild
plan, where beautifying is merely a convenience.

## Procedure sketch

1. Confirm via webcrack's `String Array: yes`.
2. Let webcrack decode — it resolves the array, applies the rotation, and
   inlines literals back to call sites. This is its primary purpose.
3. **Verify decoding actually happened** before trusting anything:
   ```bash
   grep -c "_0x" wc-out/deobfuscated.js    # should drop sharply
   grep -c -i "TERM" wc-out/deobfuscated.js  # strings should now be greppable
   ```
   If `_0x` counts stay high, decoding failed — likely a custom or nested
   variant. Do not proceed as if the output were clean.
4. Only after literals are restored, apply the parent skill's Step 3.
5. `node --check` as always.

## Additional obstacles this stack may add

javascript-obfuscator ships several defenses beyond string arrays. webcrack
handles some directly (`self-defending`, `debug-protection` appear in its
transform list):

- **self-defending** — code that corrupts itself if reformatted. Beautifying
  _first_ can destroy the file. Decode before prettifying.
- **debug protection** — `debugger` traps in a loop.
- **control-flow flattening** — a dispatch loop over a state variable. Hardest
  to undo; may survive webcrack, leaving logic readable but structurally alien.
- **dead code injection** — plausible-looking unreachable branches. Do not
  assume every branch present is real.

## Open questions to resolve when tested

- Does webcrack fully undo control-flow flattening, or only partially?
- How to detect dead-code injection so it is not reported as real behavior?
- Is the beautify order (decode → prettier) actually required by self-defending
  code, or does webcrack neutralize it first?
- What is the runtime cost on a multi-megabyte obfuscated bundle? (esbuild
  reference was ~10s; decoding is likely far slower.)
