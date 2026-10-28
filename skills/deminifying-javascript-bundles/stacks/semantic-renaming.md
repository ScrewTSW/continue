# Attack plan: semantic renaming with humanify

**Status: tested on esbuild `--minify` output**, across two passes against
`anthropic.claude-code-2.1.220`'s `webview/index.js` (7,513,675 bytes
deminified/prettified, 306,299 lines, single module scope, zero top-level
`export` statements), 2026-10.

- **Pass 1** — a component and its direct dependencies: 17 target bindings
  extracted, 15 renamed in one `apply_renames.mjs` pass, 0 skipped,
  `node --check` valid.
- **Pass 2** — the two highest-reference symbols in the bundle (React's JSX
  runtime aliases): 3 renamed, 0 skipped, 1,160 + 487 reference sites
  rewritten, `node --check` valid.

Cross-verified in both passes: every renamed symbol appeared consistently at
every call site checked, including sites far outside the targeted region
(confirms the scope-safe rename holds bundle-wide, not just locally). After
pass 2 the file was 246,059 lines — Babel's codegen reflows the whole file on
every apply, see "Gotchas" below.

Beautifying (webcrack+prettier, [esbuild-minify.md](esbuild-minify.md))
recovers syntax. It does not recover names — identifiers stay permanently
mangled (`Nkt`, `USt`, `pNt`). This step is for when mangled names themselves
are blocking the work: writing new code that calls into the bundle, explaining
a component to someone else, or extracting a component into its own file.
Skip it if you only need to answer one fact — string-grepping
([esbuild-minify.md](esbuild-minify.md) Step 1) is usually cheaper for that.

## Tool

[humanify](https://github.com/jehna/humanify)'s technique, via the
`humanify-deobfuscate` Claude Code skill
(`npx skills add ajsb85/humanify-deobfuscate -g`,
[ajsb85/humanify-skill](https://github.com/ajsb85/humanify-skill)) — a
from-scratch, no-API-key, fully local reimplementation. It splits the problem
in two: an AST tool (Babel-based, in `scripts/`) extracts every renameable
binding plus its surrounding source as context, and owns applying the rename
(`scope.rename`, so every reference moves together and shadowed same-named
bindings in other scopes are left alone); the namer (you, or a subagent)
reads the context and picks a name. Naming is judgment; renaming is
mechanical AST surgery — never hand-edit or find-and-replace identifiers,
that corrupts shadowed bindings silently.

The skill's own docs describe a webpack/browserify "split_bundle.mjs" module
mode for bundles with many small modules. **That mode does not apply to
esbuild `--minify` output** — there are no module boundaries to split on
(confirmed: `grep -c "^// "` returns 0, same fingerprint check as
[esbuild-minify.md](esbuild-minify.md)). Use the direct
`extract_identifiers.mjs` → name → `apply_renames.mjs` path instead, scoped
by filtering `identifiers.json` to a target symbol list rather than by
`split_bundle.mjs`'s module index.

## Procedure

### 1. Setup (once)

```bash
npx --yes skills add ajsb85/humanify-deobfuscate -g
cd ~/.claude/skills/humanify-deobfuscate/scripts && npm install
```

Installs `@babel/parser`, `@babel/traverse`, `@babel/generator` into
`node_modules/` **inside that skill's directory** — local, not `-g`, so it is
consistent with the parent skill's no-global-install rule (see
[../SKILL.md](../SKILL.md) Step 1, which lists these as Step-6-only deps).
No API key and no network calls at extraction/apply time: naming is done by
whichever model is driving the session, in-context, not via an external LLM
call.

Verify before relying on it — a failed `skills add` or a skipped `npm install`
surfaces much later as a confusing crash mid-pipeline. The scripts take no
`--help` flag (they treat any argument as a filename), so smoke-test on a
throwaway file instead; this exercises both the scripts and the Babel install:

```bash
printf 'function aa(x){return x*2}\n' > /tmp/h-smoke.js
node ~/.claude/skills/humanify-deobfuscate/scripts/extract_identifiers.mjs \
  /tmp/h-smoke.js | head -8        # expect "count": 2 and a pos/name/context
rm /tmp/h-smoke.js
```

This skill's own `scripts/refcount.mjs` reuses that Babel install. If Babel
already exists elsewhere, skip the install and set
`BABEL_FROM=/path/to/dir/with/node_modules` instead.

Also needs `python3`, for filtering the extraction output in step 2 — the raw
`identifiers.json` is far too large to read directly.

### 2. Extract all bindings, then filter to your target list

Run extraction once on the full file — it is fast even at this size (seconds,
not minutes) — then filter the output in a script. **Do not try to read
`identifiers.json` directly**: on the reference bundle it was 49,008,410
bytes for 64,747 bindings, itself a context-window hazard of the same shape
the parent skill warns about for the original bundle.

```bash
node ~/.claude/skills/humanify-deobfuscate/scripts/extract_identifiers.mjs \
  pass2.js > /tmp/identifiers-full.json

python3 -c "
import json
with open('/tmp/identifiers-full.json') as f:
    data = json.load(f)
targets = {'MXe', 'B5', 'Pl', 'uo'}   # the mangled names you actually need
hits = [e for e in data['identifiers'] if e['name'] in targets]
with open('/tmp/identifiers-filtered.json', 'w') as f:
    json.dump(hits, f, indent=2)
print(len(hits), 'of', data['count'], 'bindings matched')
"
```

Each entry has `pos` (declaration byte offset — the rename key), `name`,
`kind` (`var`/`hoisted`/etc.), `line`, and `context` (windowed source around
the declaration; tune window size with `CONTEXT_SIZE=2500` for denser code).
`pos` is stable across re-runs on the same file; it is what ties a name
decision back to one specific declaration even if the same mangled name
(`e`, `t`, `n`) appears in a hundred unrelated scopes.

**How to find your target names first**, if you don't already know them:
read the surrounding code by hand with the parent skill's byte-bounded
grep/Python-slice technique, or just look at `identifiers-full.json` filtered
by `line` once you have a line number from a manual read. The extraction
tool does not guess which symbols matter — you still have to know what
you're looking for before this step, same as any grep-first investigation.

### 2b. Rank candidates by _per-binding_ reference count, not by grep

Naming effort should go to multiply-referenced symbols. But do not measure
that with `grep -c <name>` — on a real bundle this is wrong in two ways that
both produce garbage rankings:

- **String and prose contamination.** Short mangled names collide with
  ordinary English and with object keys. On the reference bundle, a regex
  token count put `the` (1350), `get` (2435), `of` (1542), `is`, `to`, `not`,
  `be`, `px` at the top — all of them text inside error messages and property
  keys, not variable references.
- **Shadowed bindings are conflated.** `ie`, `te`, `ge`, `_e` each had 4–6
  _separate_ top-level declarations in different scopes, and a by-name count
  reports the same inflated total for every one of them. These are exactly
  the bindings you must never hand-edit.

Count references per _binding_ from Babel's scope data instead, with
[../scripts/refcount.mjs](../scripts/refcount.mjs):

```bash
node <skill-dir>/scripts/refcount.mjs pass2.js refs.json \
  --top-level-only --min-refs 50
```

```
bindings: 65977 total, 106 kept -> refs.json
refs/binding: 1:0  2-3:0  4-10:0  11-50:4  51-200:89  200+:13

top candidates:
  m        refs=1780   hoisted  depth=0   line=12555
  jsx      refs=1160   var      depth=0   line=162843
  T        refs=598    hoisted  depth=0   line=19734
```

Two sanity checks that the ranking is real: already-named symbols show up at
their true counts (`jsx` at exactly the 1,160 sites the rename rewrote), and
the English-word false positives from a grep count are absent.

It works because `scope.bindings[name].references` is already computed during
parse:

```js
// refcount.mjs - per-binding reference counts, keyed by declaration pos
traverse(ast, {
  Scope({ scope }) {
    for (const name of Object.keys(scope.bindings)) {
      const b = scope.bindings[name];
      rows.push({
        pos: b.identifier.start,   // same key extract_identifiers.mjs uses
        name, kind: b.kind,
        refs: b.references,        // true reference count for THIS binding
        constant: b.constant,      // never reassigned - safe to treat as fixed
        depth: /* walk scope.parent to count */,
      });
    }
  },
});
```

Runs in ~4s on a 7 MB file (vs ~47s for full context extraction), and the
`pos` key joins straight onto `identifiers.json`. Filter to `depth === 0`
(top-level) plus `kind` of `hoisted`/`var` to get the symbols worth naming;
`constant: true` additionally tells you the binding is never reassigned.

Expect the distribution to be steep and mostly worthless: on the reference
bundle, of 64,747 bindings, 54,237 were single-character and 54,042 were
`param`/`let` — overwhelmingly throwaway locals. Only 25 bindings had 200+
references, and 172 had 50+. Those few hundred are the whole job.

### 3. Name from context (your judgment, not the tool's)

Read each filtered entry's `context` and name based on usage, not the
mangled name itself. Rules that mattered in practice:

- **Function constructors with recognizable member-assignment patterns are
  usually a known library's internals.** A `function B5(e,t,i)` whose body
  assigns `this.props` and `this.context`, followed later by
  `B5.prototype.isReactComponent={}` and
  `B5.prototype.setState=...this.updater.enqueueSetState(...)`, is not a
  generic "class" — it is React's actual internal `Component` constructor,
  just never bound to the name `React.Component` because esbuild only
  retains bindings the app code actually references. `grep -c "\.Component"`
  returning 0 across the whole bundle is a strong early signal of this, not
  proof the code is missing — check for the structural pattern (the
  `this.updater.enqueueXxx` delegation, `isReactComponent` marker) before
  concluding a class is absent.
- **Two different mangled names can be true aliases**, not distinct concepts.
  `var b = Jbe; var E = Jbe;` — both are literally the same function
  (confirmed: identical `context` blocks). Don't invent a false distinction
  between them. But _do_ check whether call sites use them by convention
  before flattening them to one name: here, counting calls whose props object
  contained a `children:` **array** gave `E` → 102 sites and `b` → 0, which
  identifies them as React's JSX-runtime pair `jsxs`/`jsx` (esbuild emitted a
  single shared implementation, keeping both bindings). The alias is real and
  the distinction is real; they're just different facts.
- **Read the implementation before accepting an inherited name.** The symbol
  above was labelled `createElement` in an earlier pass's notes. The body
  returns `{$$typeof, type, key, ref, props, _owner}` from a fixed
  `(type, props, key)` signature — that is the `jsx-runtime` factory, not
  `createElement`, which is variadic over children. A wrong-but-plausible
  name propagates into every file you then write against it; a 30-second read
  of the function body settles it.
- **CSS-module objects are safe to name from their key sets** even with zero
  other context: `{ inputFooter: "inputFooter_gGYT1w", spacer: "spacer_gGYT1w",
sendButton: "sendButton_gGYT1w" }` is unambiguously a footer-toolbar
  style map.
- **Cross-check against any existing prose documentation** (patch writeups,
  issue threads, code comments) before trusting a guess — on the reference
  bundle, 13 of 15 names matched a pre-existing patch doc's symbol table
  exactly, written before this tool was used at all. Agreement between an
  independent AST-context read and independently-written prose is a strong
  correctness signal; a mismatch is a reason to re-check both.

Write the rename map keyed by `pos`:

```json
{
  "1732": "ReactComponent",
  "4923982": "Signal",
  "4929501": "effect"
}
```

### 4. Apply and verify

```bash
node ~/.claude/skills/humanify-deobfuscate/scripts/apply_renames.mjs \
  pass2.js renames.json pass2.js

# Fail closed: `... && echo VALID` alone exits 0 even when the check fails.
node --check pass2.js || { echo "BROKEN - restore the backup"; exit 1; }
echo VALID
```

Apply to a **copy you can throw away**, or keep a pre-pass backup — an apply
rewrites the file in place when input and output are the same path:

```bash
cp pass2.js pass2.js.prepass
```

Reports `applied N renames, skipped M`. Investigate any skip — it means the
`pos` didn't match a binding declaration in the current file (stale offset
from a file that's since been re-extracted/re-formatted elsewhere, or a typo
in the map).

**Re-verify at multiple call sites, not just the declaration.** Grep for the
new name after applying — a correct scope-safe rename shows up consistently
everywhere the binding is actually used, including far from the region you
were originally reading:

```bash
grep -n "Signal.prototype.subscribe\|= effect(" pass2.js
```

If a renamed symbol only appears once (at its own declaration) when you
expected multiple call sites, that is a signal something is wrong — either
the binding is genuinely unused (dead code, worth noting) or the apply step
silently missed references (re-check with `node --check` and re-read the
diff before trusting the result).

## Gotchas specific to this stack

**`split_bundle.mjs` module mode does not apply.** It is built for
webpack/browserify's `__webpack_require__(id)` module-numbering scheme. An
esbuild `--minify` entry bundle is one flat scope — use the direct
extract/apply path (Step 2–4 above), not the module-splitting workflow.

**A rename preserves export names, by design — don't mistake it for a bug.**
Renaming a binding that is exported makes Babel split the statement to keep
the _public_ name stable:

```js
export var b = Jbe;              // before
// becomes:
var jsx = jsxFactory;            // after
export { jsx as b };             //   local renamed, external name unchanged
```

That is correct ES-module semantics — consumers importing `b` keep working.
If you also own every importer (e.g. nothing has been extracted yet and the
export exists only for your own future use), collapse it by hand afterward to
`export { jsx }`. Decide deliberately; silently changing a public export name
is a breaking change in any other situation.

**High-reference renames are safe and cheap — blast radius is not a reason to
skip them.** Renaming the two JSX aliases touched 1,160 + 487 reference sites
in one pass, `node --check` valid, references verified consistent from line
162857 to 246050. The AST does not care how many sites there are, and the
cost is one ~50s apply. Earlier hesitation about "huge blast radius" for these
two symbols was misplaced: that reasoning applies to _hand_-editing, which you
must never do anyway. The real selection criterion is whether the name buys
readability, not how often it appears.

**Line numbers shift after every apply.** `apply_renames.mjs` fully
re-parses and re-generates via Babel, which reflows formatting, not just
identifiers — a symbol at line 201255 before a rename pass may be at line
155133 after. Re-run `extract_identifiers.mjs` (or at minimum re-`grep`) to
get current line numbers before citing them; do not reuse line numbers
captured before an apply.

**49 MB of `identifiers.json` on a 7.5 MB file is normal, not a bug.** The
extraction is one JSON object per binding with a full context window
attached; on a large single-scope file this inflates fast. Always filter in
a script before reading any of it — never `cat`/`Read` the raw extraction
output.

**The skill's own naming rule ("omit, don't invent") matters more here than
on a typical TS-compiled bundle.** esbuild `--minify` output has very little
of the `__extends`/`__awaiter`-style compiler scaffolding the parent skill's
TypeScript guidance targets — most short names left after a pass genuinely
are throwaway single-use locals (`e`, `t`, `i` as destructured props), not
hidden structure. Don't manufacture names for single-use loop/param locals
that already read fine; focus naming effort on multiply-referenced
functions, classes, and shared state objects.
