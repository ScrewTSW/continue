---
name: deminifying-javascript-bundles
description: Use when reading, auditing, or reverse-engineering a minified, bundled, or obfuscated JavaScript file — VSCode extension bundles, webview bundles, dist output, vendor.js, or any single-file build with very long lines — especially when a read attempt hung, was killed, or blew the context window, or when verifying a change landed in built output
license: Apache-2.0
---

# De-minifying JavaScript Bundles

## Overview

A minified bundle is a context-window hazard before it is a comprehension problem. A 2.65 MB bundle is roughly 830,000 tokens (the `bytes / 3.2` estimate from Step 3): reading it whole is impossible at any context size, and _attempting_ it destroys the session — the tool call never returns, so nothing is rendered and the model cannot even see why it failed.

**Core principle: never let the bundle into context. Extract from it.**

The goal is not a readable copy of the whole file. The goal is answering a specific question while reading only kilobytes.

## The Iron Law

**NEVER read a minified bundle with a line-based limit.**

Not `head -300`. Not `cat`, `less`, or `grep -n`. Not "just to check the format".
Not "the first few lines are probably fine".

The prohibition is on the **unit**, not the tool. `head -N`, `tail -N`, `sed -n
'1,Np'`, and `grep -n` all bound _lines_, and minified bundles have almost none.
A real measured case: 2,650,012 bytes in **907 lines**, longest line **156,328
characters**. `head -300` there returns most of the file. Any line-based limit is
meaningless on minified JS.

**Byte-based limits are fine and used throughout this skill** — `head -c 2000`,
`grep -ob`, `wc -c`, and Python slices all bound output in bytes and are safe on
a multi-megabyte single-line file. `head -c` is not a violation; `head -n` is.

Use `wc`, `awk 'length($0)'`, `grep -ob`, `grep -oF … | wc -l`, and
byte-bounded slices. Note `grep -c` counts **lines**, so on this input it is a
presence check, not a count — see Step 2.

## Step 1: Preflight — do I have the tools?

Check before planning, because the answer changes the plan. A missing toolchain means falling back to grep-only extraction, which works but yields no line numbers.

```bash
node --version && npm --version          # need node for every tool below
python3 --version                        # bounded slicing + filtering JSON
timeout 10 npm ping                      # registry reachable? npx needs it
ls ~/.npm/_npx 2>/dev/null | head        # cached packages if offline
```

| Result                                                     | Plan                                         |
| ---------------------------------------------------------- | -------------------------------------------- |
| node + registry                                            | Full pipeline (Step 5). Best outcome.        |
| node, no registry, but `~/.npm/_npx` has webcrack/prettier | Full pipeline offline via `npx --no-install` |
| node, no registry, no cache                                | Grep-only (Step 4). Still effective.         |
| no node                                                    | Grep-only. Python `str.find` for slicing.    |

Python is not optional in practice: it does the byte-bounded slicing in Step 4
and the `identifiers.json` filtering in Step 6. Without it you can still grep,
but every "extract context safely" recipe here needs rewriting.

Do not `npm install -g`. Use `npx --yes <tool>@<exact-version>` — no environment
mutation.

**Extra dependencies for Step 6 only.** Semantic renaming needs Babel, which
is the one place this skill does install packages. Skip this unless you are
doing Step 6:

```bash
# one-time: the AST tooling that owns scope-safe renaming
npx --yes skills@1.7.4 add ajsb85/humanify-deobfuscate -g
(cd ~/.claude/skills/humanify-deobfuscate/scripts && npm ci)
```

Keep the `cd` in a subshell — unparenthesized it persists for the rest of the
session, and Step 3's `cp bundle.js /tmp/work/orig.js` would then run from
inside the skill directory.

Use `npm ci`, not `npm install`: the skill ships a `package-lock.json`, and
its `package.json` asks for `@babel/*: ^7.25.0`, so a plain install resolves
whatever 7.x is current (7.29.7 at the time of writing). `npm ci` installs the
locked tree instead — the same pinning argument as `webcrack`, applied to the
dependency tree rather than the CLI.

That install is **local to the skill directory**, not global — it writes
`node_modules/` under `~/.claude/skills/humanify-deobfuscate/scripts/` and
mutates nothing else, so it is consistent with the no-`-g` rule above rather
than an exception to it. It installs `@babel/parser`, `@babel/traverse`, and
`@babel/generator`. No API key and no network calls at extract/apply time.

**The skill revision cannot be pinned through this installer, and that is a
real gap.** `skills add` takes a repo, not a `repo@ref`; the installed result
carries no `.git` and writes no lockfile, so afterward there is no way to tell
which revision you got. The same objection that motivates pinning `webcrack`
— a third party choosing your AST-rewriting code at runtime — applies here,
and pinning the CLI only addresses half of it. For a reproducible install,
fetch a tagged revision directly instead (`v1.0.0` at the time of writing):

```bash
( set -e
  mkdir -p ~/.claude/skills && cd ~/.claude/skills
  curl -fsSL https://github.com/ajsb85/humanify-skill/archive/refs/tags/v1.0.0.tar.gz \
    | tar xz --one-top-level=humanify-deobfuscate --strip-components=1
  cd humanify-deobfuscate/scripts && npm ci )
```

Either way, read `scripts/*.mjs` before the first run — they parse and rewrite
files you are already treating as untrusted.

`scripts/refcount.mjs` in _this_ skill borrows Babel from that install. If you
have those packages somewhere else already, point it there instead and skip
the install: `BABEL_FROM=/path/to/dir/with/node_modules`.

Confirm it landed — a failed `skills add` or forgotten `npm ci` shows up
as a crash mid-pipeline otherwise:

```bash
ls ~/.claude/skills/humanify-deobfuscate/scripts/*.mjs | wc -l   # expect 7
node -e 'const{createRequire}=require("module");
  const r=createRequire(process.env.HOME+"/.claude/skills/humanify-deobfuscate/scripts/");
  r("@babel/parser");r("@babel/traverse");console.log("babel OK")'
```

**Pin the version.** A bare `npx --yes webcrack` resolves whatever the registry
currently calls latest, so the tool that rewrites your AST is chosen at runtime
by a third party. These commands run against code you are already treating as
untrusted; pin both tools and bump deliberately. Versions used and measured
throughout this skill: `webcrack@2.16.0`, `prettier@3.9.6`.

On the offline branch use `npx --no-install <tool>@<version>`, which runs a
cached package without installing. Note it is not an offline guarantee — it still
contacts the registry to resolve the spec and fails if the package was never
cached.

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
grep -oF -e useState -e createElement bundle.js | wc -l   # ~0 = no UI, wrong file
```

**Count occurrences, not matching lines.** `grep -c` counts lines, and a
minified bundle has almost none — so it floors at roughly the line count no
matter how much it actually matches. Measured on the reference
`webview/index.js` (2,057 lines): `useState` is 4 by `grep -c` but **29**
occurrences; `createElement` is 32 versus **214**. A `grep -c` of 4 reads like
"barely any UI" when the file is the UI bundle. Use `grep -oF | wc -l` here
and anywhere else the number informs a decision.

If that returns near zero and you are looking for UI, find the real one:

```bash
grep -oE '"[^"]{1,200}\.js"' extension.js | sort -u | head -20
```

`"[a-z.]*js"` looks tighter but silently misses every real bundle path — it
excludes `/`, digits, `_`, and `-`, so `"assets/index-D3f_2a.js"` does not match.
Match any quoted non-quote run ending in `.js` and bound the output instead.
The `{1,200}` matters on minified input: an unbounded `[^"]+` will happily
print a multi-megabyte quoted blob that happens to end in `.js`, and `head -20`
bounds lines, not bytes — the Iron Law applies to your own pipelines too.

Measured cost of skipping this step: a full webcrack+prettier cycle on a 2.65 MB
`extension.js` that contained no UI at all (`useState: 0`, `createElement: 2`).
The meter being hunted was in a separate 4.8 MB `webview/index.js`. One `grep -c`
would have redirected the entire effort.

## Step 3: Measure and fingerprint

Never modify the original. Work on a copy, always.

```bash
set -e                                   # stop if the copy fails
mkdir -p /tmp/work                       # not guaranteed to exist
cp bundle.js /tmp/work/orig.js
cd /tmp/work

wc -l orig.js                                         # lines
wc -c orig.js                                         # bytes
awk '{if(length($0)>m)m=length($0)}END{print m}' orig.js   # longest line
python3 -c "import os;print(int(os.path.getsize('orig.js')/3.2))"  # ~tokens
```

Without the `mkdir`, `cp` fails on a fresh machine and every command below
measures whatever `orig.js` happens to be in your current directory — or
nothing at all. Fail here rather than three steps later.

If est. tokens > half your context, the whole-file read is off the table — which is the normal case.

Then fingerprint the stack. These markers are cheap, but **not mutually
exclusive** — a webpack bundle routinely also carries Babel interop helpers, and
an obfuscated bundle was minified by something first. Two hits is additional
signal, not a contradiction. Read them in the table's order and take the first
row that matches:

```bash
# CHECK FIRST — but a marker alone isn't the jackpot: inline data: URLs carry no
# separate file, and a referenced .map can be missing or stale. Verify the
# referenced file actually exists before treating this as a stop condition.
grep -o 'sourceMappingURL=[^ *]*' orig.js | tail -1 | sed 's/.*=//'   # inline data:... or a relative path
grep -c "^// "                orig.js   # esbuild module boundaries (0 = --minify)
grep -c "__webpack_require__" orig.js   # webpack
grep -c "_interopRequireDefault" orig.js  # babel/rollup CJS interop
```

| Fingerprint                                                                | Attack plan                                                                             |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `sourceMappingURL` present AND the referenced `.map` file exists on disk   | **Stop.** Recover original source from the sourcemap. Everything else is wasted effort. |
| `var X=Object.create;var{getPrototypeOf:...}=Object` prologue, zero `^// ` | [stacks/esbuild-minify.md](stacks/esbuild-minify.md) — **tested**                       |
| `__webpack_require__`, numeric module map                                  | [stacks/webpack.md](stacks/webpack.md) — untested                                       |
| Large string array + index-shuffle function at top                         | [stacks/javascript-obfuscator.md](stacks/javascript-obfuscator.md) — untested           |
| Long lines, none of the above                                              | Generic: Step 4, then Step 5                                                            |

## Step 4: Extract without beautifying

**This is the highest-yield step, and it often ends the task.** Do it before beautifying.

**Hunt string literals, not identifiers.** Minification destroys identifiers permanently (`Nkt`, `USt`, `pNt`) but preserves every string: error messages, config keys, URLs, package names, schema descriptions. Strings are the only durable semantic surface.

```bash
grep -oiF "sandbox" orig.js | wc -l             # count FIRST — occurrences, not lines
grep -obiF "sandbox" orig.js | head -20         # locate: BYTE offsets, not lines
grep -oE '"[a-z0-9@/_-]{4,40}"' orig.js | sort | uniq -c | sort -rn | head -30
```

Keep the case mode identical in both commands. `grep -c -i` paired with a
case-sensitive `grep -obF` is a trap: `Sandbox` then reports a positive count
and zero locations, which reads as "the extractor is broken" rather than
"wrong flag".

**Locate by byte offset, never by line.** `grep -n` prints the whole matching
line, and `| head -20` bounds the number of _lines_, not bytes — on minified
input that is no bound at all. Measured: a file of one 400,001-byte line
containing a single match returned **400,010 bytes** through `grep -n | head -20`.
`grep -ob` prints `offset:match` and stays a few bytes per hit regardless of line
length.

Feed those offsets to the Python slicer below to read context.

**Bound every grep on a multi-megabyte file** — `-c`, `-ob`, or `| wc -l`. The
one form that is never safe is `grep -n`, bounded or not.

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
npx --yes webcrack@2.16.0 orig.js -o wc-out

# Pass 2 — prettier: consistent formatting, break residual long lines
cp wc-out/deobfuscated.js pass2.js
npx --yes prettier@3.9.6 --write pass2.js --log-level warn

# Pass 3 — VERIFY. Non-negotiable.
node --check pass2.js || { echo BROKEN; exit 1; }
echo VALID
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

## Step 6: Semantic renaming (optional)

Beautifying (Step 5) recovers syntax, never names — identifiers stay
permanently mangled. Skip this step if you only need to answer one question;
string-grepping (Step 4) is usually cheaper for that. Use it when mangled
names are themselves blocking the work: writing new code against the bundle,
explaining a component, or extracting a component into its own file.

[stacks/semantic-renaming.md](stacks/semantic-renaming.md) — **tested**, via
the `humanify-deobfuscate` Claude Code skill (an AST tool extracts bindings +
context and applies renames scope-safely; you supply the names from
context). Covers filtering a large `identifiers.json` down to a target list,
naming heuristics that mattered in practice (recognizing a tree-shaken
library's internals from a structural pattern, true aliases vs. distinct
symbols, cross-checking against existing prose docs), and gotchas specific to
esbuild `--minify` output (no module-splitting mode applies; line numbers
shift after every apply pass).

Pick targets with [scripts/refcount.mjs](scripts/refcount.mjs) — per-binding
reference counts from Babel's scope data, so naming effort goes to the few
hundred symbols that carry the file:

```bash
SKILL_DIR=~/.claude/skills/deminifying-javascript-bundles   # adjust if installed elsewhere
node "$SKILL_DIR/scripts/refcount.mjs" beautified.js refs.json \
  --top-level-only --min-refs 50
```

(`<skill-dir>` would be parsed as input redirection and fail, so this uses a
real variable.)

Do **not** rank candidates with `grep -c <name>`. On a real bundle that puts
English words from error strings (`the`, `get`, `of`) at the top and reports
one inflated total for every same-named binding across unrelated scopes.
Needs Babel from the `humanify-deobfuscate` skill, or set `BABEL_FROM`.

## Step 7: Read in bounded chunks

Never read the beautified file whole either — it is _larger_ than the original.

```bash
grep -n "sandbox" pass2.js | head          # find the line
sed -n '139700,139780p' pass2.js           # read a window
```

`grep -n` is safe **here and only here**: after Pass 2 the longest line is ~1.5 KB,
so a line is a real bound. Never use it on `orig.js`.

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
set -e                                            # a failed unzip must stop here
rm -rf /tmp/check && mkdir -p /tmp/check          # never grep a previous run
unzip -q built.vsix "extension/gui/assets/index.js" -d /tmp/check
set +e
grep -c -F "new string"  /tmp/check/extension/gui/assets/index.js   # want >0
grep -c -F "old string"  /tmp/check/extension/gui/assets/index.js   # want 0
```

**The `rm -rf` is the load-bearing line.** `unzip -o` overwrites but never
deletes, so a failed extraction leaves the previous run's bundle in place and
both greps then pass against a stale artifact — the exact false confirmation this
section exists to prevent. `set -e` ensures the greps never run on a failed
unzip. (`grep -c` returning 0 exits non-zero, hence `set +e` before them.)

## Quick Reference

| Task                 | Command                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- |
| Size in tokens       | `python3 -c "import os;print(int(os.path.getsize('f.js')/3.2))"`                       |
| Longest line         | `awk '{if(length($0)>m)m=length($0)}END{print m}' f.js`                                |
| Count before dumping | `grep -oiF TERM f.js \| wc -l`                                                         |
| Safe context extract | Python `str.find` + slice                                                              |
| Beautify             | `npx --yes webcrack@2.16.0 f.js -o out` then `prettier@3.9.6 --write`                  |
| Verify               | `node --check out.js`                                                                  |
| Rank rename targets  | `node "$SKILL_DIR/scripts/refcount.mjs" f.js refs.json --top-level-only --min-refs 50` |

## Common Mistakes

| Mistake                                 | Reality                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `head -300` on a bundle                 | Counts lines. 300 lines can be 2 MB. Blows context.                          |
| `grep -oE '.{200}X.{400}'`              | Catastrophic backtracking on long lines. Use Python.                         |
| `grep -n` on a bundle, even `\| head`   | `head` bounds lines, not bytes. Use `grep -ob` for offsets.                  |
| Chasing mangled identifiers             | `Nkt`/`USt` are dead ends. Hunt strings.                                     |
| Beautifying first                       | Step 4 often answers the question at a fraction of the cost.                 |
| Trusting line-count growth              | webcrack can duplicate modules. Growth ≠ pure recovery.                      |
| Skipping `node --check`                 | A broken transform silently produces plausible nonsense.                     |
| Editing the original                    | Always copy first.                                                           |
| Assuming module boundaries survive      | `--minify` strips `// node_modules/...`. Verify with `grep -c "^// "`.       |
| Assuming the entry point is the UI      | `extension.js` is the host bundle. Check `grep -oF useState \| wc -l` first. |
| Grepping built output by source pattern | Template literals leave no literal to match. Search constants.               |
| `grep -c name` to rank rename targets   | Counts strings/keys/prose and merges shadowed bindings. Use `refcount.mjs`.  |
| Hand-editing identifiers to rename them | Corrupts shadowed bindings silently. Only ever `scope.rename` via AST.       |

## Scope Limits

De-minification recovers _syntax_, never _meaning_:

- **Identifiers are gone forever.** No tool recovers original names without a sourcemap.
- **Cross-module meaning does not survive.** Mangled-name chasing hits a wall fast; an export stub may have no read site in the bundle at all because the consumer is a different process.
- **A bundle may not implement what it declares.** It can carry a config schema while enforcement lives in a separate binary. Do not report a documented guarantee as a verified one — say which you checked.
