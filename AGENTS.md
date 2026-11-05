# AGENTS.md

Guidance for AI coding agents working in this repository.

## Branch workflow

- `v3` is the mainline branch. All development targets `v3`.
- Never push directly to `v3` or `main`. Both are protected; direct pushes are rejected.
- Always create a feature branch from an up-to-date `v3` and open a pull request against `v3`.
- Merge only after the required CI checks pass (tests, VSIX build). Linear history is enforced.

```bash
git checkout v3 && git pull origin v3
git checkout -b <feature-branch>
# ... commit ...
git push -u origin <feature-branch>
# open a PR targeting v3
```

## CI on v3

- `pr-checks.yaml` runs on every push to `v3` and on PRs targeting it: tests, the VSIX build job, and the `require-all-checks-to-pass` gate.
- Jobs for surfaces dropped in v3 (binary, e2e, JetBrains) are skipped on `v3` by branch condition.
- `nightly.yaml` builds and publishes the nightly pre-release from `v3` (pinned `NIGHTLY_REF`).

## v3 architecture direction

- The extension becomes a thin IDE frontend plus a translation layer; OpenCode is the CLI backend engine.
- Per-model-per-provider settings (context window, max output, modalities) are the headline feature of the translation layer.
- The repository stays provider-agnostic: no gateway names, hostnames, provider-specific model IDs, or internal documentation references in code, configs, docs, commits, or PRs. User-specific deployment detail lives outside the repo.

## Labels

- `INSANITY` — v3 migration work (gutting and rebuild); also marks dogfooding items required or enhanced by that process
- `MVP` — required for the v3 MVP VSIX
- `obsolete` — superseded by the v3 architecture
