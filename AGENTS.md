# AGENTS.md

Guidance for AI coding agents working in this repository.

## Branch workflow

- `v3` is the mainline branch. All development targets `v3`.
- Never push directly to `v3` or `main`. Both are protected; direct pushes are rejected.
- Always create a feature branch from an up-to-date `v3` and open a pull request against `v3`.
- Run the self-review gate (`skills/self-review/SKILL.md`) before pushing a feature branch; it must return `CLEAR`, with any blocking findings fixed or explicitly signed off per the skill.
- Merge only after the required CI checks pass (tests, VSIX build). Linear history is enforced.

```bash
git checkout v3 && git pull origin v3
git checkout -b <feature-branch>
# ... commit ...
# run the self-review gate (skills/self-review/SKILL.md) before pushing
git push -u origin <feature-branch>
# open a PR targeting v3
```

## CI on v3

- `pr-checks.yaml` runs the full suite on `main`. On `v3` it runs the VSIX-focused subset: prettier, vscode-checks (typecheck, lint, vitest), and the VSIX package build, gated by `require-all-checks-to-pass`.
- The other jobs (core, gui, packages test suites, binary, e2e, JetBrains) are skipped on `v3` by branch condition and named in the gate's `allowed-skips`.
- `nightly.yaml` builds and publishes the nightly pre-release from `v3` (pinned `NIGHTLY_REF`).

## v3 architecture direction

- The extension becomes a thin IDE frontend plus a translation layer; OpenCode is the CLI backend engine.
- Per-model-per-provider settings (context window, max output, modalities) are the headline feature of the translation layer.
- The repository stays provider-agnostic: no gateway names, hostnames, provider-specific model IDs, or internal documentation references in code, configs, docs, commits, or PRs. User-specific deployment detail lives outside the repo.

## Labels

- `INSANITY` — v3 migration work (gutting and rebuild); also marks dogfooding items required or enhanced by that process
- `MVP` — required for the v3 MVP VSIX
- `obsolete` — superseded by the v3 architecture
