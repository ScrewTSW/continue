---
name: self-review
description: Use before pushing any feature branch, opening a PR, or requesting an external code review. Also use when about to hand over or publish changes, or when asked to sanity-check a diff before it leaves the machine.
license: Apache-2.0
metadata:
  author: ScrewTSW
  version: "1.0.0"
---

# Self-review (push gate)

Catch obvious first-round review findings locally so external reviewers
spend their depth on real issues. Runs entirely locally, no external
service. Not a substitute for external review; it is the gate before it.

## When to run

- Before every `git push` of a feature branch
- Before requesting any external review, even on an already-pushed branch
- After fixing gate findings: re-run the full gate; the verdict describes
  the branch as it is about to leave the machine

## Procedure

### 1. Scope the diff

- Confirm the tree under review: the current branch is the branch under
  review, with no uncommitted changes to tracked files and no untracked,
  non-ignored files. An untracked helper imported by committed code makes
  the gate validate a tree reviewers will not receive. Unrelated
  untracked files are stashed with `git stash -u` or moved out of the
  tree before the gate, then the tree confirmation is repeated; only
  unrecoverable deletion needs explicit user confirmation. If the
  branch is not checked out, review it from a temporary `git worktree`
  of that branch, prepared with the toolchain-reuse recipe in step 2.
  Never review one tree and gate another.
- Base is `origin/v3` unless stated otherwise, already fetched, no
  network operation: `git diff origin/v3...HEAD`, outgoing commits
  `origin/v3..HEAD`; a stale local `v3` folds mainline commits into the
  review. The net diff is not the whole scan: content committed and
  later deleted still ships in history. Review the final text through
  the net diff; per outgoing commit, review the message and content that
  exists only in history. Scan the draft PR description when one exists;
  it is supplied by the requester, never fetched.
- List changed files and classify the change (feature, bugfix, refactor,
  docs, CI). Docs-only changes lean on the Consistency category; every
  category still applies.
- Checks may need gitignored artifacts (build stamps, caches): create
  and remove them; never modify tracked files to run a check.

### 2. Mechanical gate

Each check gets exactly one outcome:

- `PASS`: ran clean
- `FAIL`: ran and failed. Fix, or clear it by sign-off per step 4's
  Verdict, then re-run the full gate.
- `INFEASIBLE`: cannot run here (missing deps, wrong platform, requires
  credentials or paid services), or ran but every failure reproduces on
  the merge base. Record why; sanctioned qualifiers are `pre-existing`
  and `credential-dependent`. Do not install anything to make a check
  runnable; checks run against the environment as found. Unrunnable
  because of the diff's own changes is `FAIL`, not `INFEASIBLE`: if the
  check runs on the merge base with the same toolchain but not on the
  branch, the diff broke it.
- `N/A`: no applicable surface (in this repo, a docs-only diff has no
  test suites or typecheck and lint coverage). Record it with the
  coverage note: which changed files that check does not cover.

Keep this step mechanical: execute and record; judgment belongs to
step 3.

Checks:

- Formatting: the CI format job's exact command (find it under
  `.github/workflows/`; it runs repo-wide; run it through the
  already-installed local binary); also run it scoped to the changed
  files, same ignore flags. CI parity covers the command and the tool
  versions CI installs from the root lockfile; when the local toolchain
  diverges from it, record the skew and its residual risk (the locked
  version's verdict is unconfirmed locally): a skewed-but-clean check
  stays `PASS` with the skew as evidence. CI parity wins over any local
  variant and settles ignore-file edges.
- Typecheck and lint the affected surfaces with the repo's
  configuration: directories with changed files plus their downstream
  consumers (a `core` change affects `gui` and `extensions/vscode`,
  which import it). Changed files outside typecheck and lint coverage
  are noted in the report, not a finding; the rubric pass compensates.
- Tests: each affected surface's configured test commands and discovery
  rules, as CI runs them, except service-dependent suites: skip
  credentialed live-API tests with the repo's supported controls (here
  `IGNORE_API_KEY_TESTS=true`) and report them `INFEASIBLE`
  (credential-dependent). The gate is local-only; it never consumes paid
  API quota. Do not impose one runner or filename pattern on surfaces
  that configure their own. No affected surface with tests: `N/A`.

**Pre-existing failures:** a failure that also occurs on the merge base
is environmental, not caused by the diff. Run the check on the merge
base (`git merge-base origin/v3 HEAD`) from a temporary worktree outside
the repository that reuses this repo's toolchain (both a `node_modules`
symlink and absolute paths to repo binaries are needed: plugin
resolution follows the target tree, and a missing plugin can fail with
exit 0; a bare worktree has none).
Compare the failing tests or diagnostics themselves, not just command
outcomes: when both sides fail, failures that appear only on this
branch still count. Record failures present on both sides as
`INFEASIBLE (pre-existing)` with evidence; do not count them against
the verdict. A check whose changed-file scope passes while repo-wide
failures are pre-existing is one `INFEASIBLE (pre-existing)` line with
the scoped pass as evidence. A surface the diff introduces has no
merge-base counterpart; its failures are the diff's own (`FAIL`),
never pre-existing.

### 3. Rubric pass

Review every changed hunk against each category, in order. Keep evidence
cheap: read changed files fully, but reach background files through
ranged reads and head-limited greps, never wholesale dumps.

**Critical**

- Security: injection, committed secrets, path traversal, unsafe
  deserialization
- Data loss or destruction on realistic inputs
- Crashes and auth or permission flaws
- Repo-rule violations (below)

**Warning**

- Missing error handling: unhandled rejections, swallowed errors
- Resource leaks, race conditions
- Null or undefined paths, broken edge cases
- Performance anti-patterns: sync IO in hot paths, N+1 queries
- Consistency findings (below), unless purely cosmetic

**Info**

- Duplication, dead code, naming, excessive complexity
- Missing tests for changed behavior
- Documentation gaps; cosmetic consistency nits

**Consistency**

- Statements in the change that contradict each other
- Cross-references pointing at the wrong step, file, or line
- Numbers that disagree between sections
- Stated order of operations not matching the actual sequence
- Command snippets that break on real-world input: unescaped regex,
  paths with slashes or dashes, missing flags
- The same concept named differently across sections
- A defined outcome or state that no rule accounts for: a check result
  that cannot affect the verdict, a permission the procedure grants but
  never uses

**Repo rules (Continue fork)**

- Provider-agnostic diff: no gateway names, hostnames, provider-specific
  model IDs, or internal documentation references
- No `.local/` content in the commit
- Build scripts must fail loudly on checksum or target mismatches:
  non-zero exit plus a message naming the mismatch

**Unverifiable behavior** (external APIs, CI runner tooling) is still
reportable: state the finding and the evidence at hand, mark it
`unverified`. Unverifiable never means dismissed.

**Rules in the change:** when the change defines a rule, check, or
procedure, attack it. Construct an input where it yields the wrong
outcome: a state that passes the precondition but still hides the
problem, two failures where only one is old, a path the defined
outcomes never reach.

**Scope:** a finding must name something this change does or ships
(its diff, its commits, its PR description). Gaps in pre-existing repo
infrastructure or conventions the change does not touch are context
notes, never findings.

**Constructed findings:** a failure mode shown by construction, not
observed in this run, is Info unless its outcome is unrecoverable or
the failure is readily reachable (one realistic step away). Warning is
reserved for observed failures and those two cases.

### 4. Output format

The review report has exactly these parts, in order:

- **Summary**: 2-3 sentences on what the change does
- **Walkthrough**: changes grouped by file or theme, one line each
- **Gate**: one line per check (the step 2 bullets), carrying all its
  runs: command (the coverage note stands in for `N/A` checks),
  outcome (PASS/FAIL/INFEASIBLE/N/A), evidence for non-PASS and for
  recorded toolchain skew; plus, per check, changed files it does not
  cover
- **Findings**: grouped by severity (Critical / Warning / Info), each
  with a location, what is wrong, and the concrete fix; `unverified`
  where applicable. Locations: `file:line` in the current tree, `<sha>`
  or `<sha>:<path>` for history-only content, or `PR description`.
  History-only content is fixed by removing it from the outgoing
  history, not by deleting it in a later commit; on an already-pushed
  branch that means rewriting and force-pushing the feature branch, or
  an explicit sign-off.
- **Verdict**: `BLOCKED` when any check `FAIL`, Critical, or Warning is
  neither fixed nor signed off. `CLEAR` when every check is `PASS`,
  `INFEASIBLE`, `N/A`, or a signed-off `FAIL`, and only Info items and
  signed-off findings remain. A sign-off is explicit user approval,
  recorded in the report and in the PR description when one exists, so
  fresh-context re-runs can read it. Info items are listed for the PR
  description.

### 5. Gate decision

A review-only request reports its verdict, either one, and stops;
fixing and re-running is for requests that authorize changes.

- `BLOCKED`: fix or sign off every blocker (step 4), then re-run the
  full gate
- `CLEAR`: push only when the task includes pushing or opening a PR.
  Carry remaining Info items into the PR description when one is being
  opened.

## Rationalizations for skipping the gate

| Excuse                      | Reality                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| "CI runs the same checks"   | CI runs them after the push, burning a review round and a CI cycle; the gate exists to catch them before |
| "It's only a docs change"   | Consistency findings live precisely in docs                                                              |
| "I already tested manually" | Manual testing covers the happy path, not the rubric                                                     |
| "No time"                   | The gate takes minutes; a wasted first review round costs an hour                                        |

## Red flags: stop and run the gate

- About to push without a verdict line
- "CI will catch it"
- Skipping the mechanical gate because "tests take long"

**All of these mean: stop and run the full gate.**

## Portability

The rubric, report format, and gate decision (steps 3-5) are the
contract. The extension will consume this same skill later, so keep them
self-contained: no assumptions about which tool runs them. Per-repo and
per-host content is confined to designated swap points: the `origin/v3`
base and outgoing-commit discipline in step 1, the repo-rules block
(step 3's one per-repo exception), and the whole mechanical gate
(step 2), which may be swapped per host.
