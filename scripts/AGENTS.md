# Scripts Guide

This directory owns local tooling, script wrappers, and generated-artifact helper rules.

## Wrapper Rules

- Prefer existing wrappers over raw tool entrypoints when the repo already has a curated seam.
- For tests, prefer `scripts/run-vitest.mjs` or the root `pnpm test ...` entrypoints over raw `vitest run` calls.
- Never use bare `vitest ...` in automation; it starts local watch mode unless `run` or `--run` is explicit.
- For lint/typecheck flows, prefer `scripts/run-oxlint.mjs` and `scripts/run-tsgo.mjs` when adding or editing package scripts or CI steps that should honor repo-local runtime behavior.
- For changed-file verification, prefer `scripts/check-changed.mjs` and keep lane classification in `scripts/changed-lanes.mjs`. Use `node scripts/check-changed.mjs --dry-run [--staged|-- <files...>]` to inspect the plan before running anything expensive. Do not copy path-scope rules into new hooks or ad hoc CI snippets.
- For one/few lint files, prefer direct `node scripts/run-oxlint.mjs --tsconfig <matching config> <files...>` over sharded `pnpm lint`; `check-changed.mjs` owns this targeting for core, extension, and script diffs.

## Local Heavy-Check Lock

- Respect the local heavy-check lock behavior in `scripts/lib/local-heavy-check-runtime.mjs`.
- Do not bypass that lock for real heavy commands just to make a local loop look faster.
- Metadata-only or explicitly narrow commands may skip the lock when the existing helper logic says that is safe.
- If you change the lock heuristics, add or update the narrow tests under `test/scripts/`.

## PR Prepare Gates

- `scripts/pr` serializes review, prepare, and merge operations per PR across linked worktrees; `scripts/pr gc` skips active or indeterminate locks. A successful command return is the trusted synchronous-completion contract: every PR-state-mutating child must be joined before returning, and such work must never daemonize or explicitly escape both the operation group and lock-notification FD. Failed, interrupted, or controller-lost operations stay locked because detached children cannot be disproved; after verifying no child tools remain, use the reported exact-OID `scripts/pr lock-recover` command. Never bypass or delete these refs manually.
- `scripts/pr prepare-gates` holds the heavy-check lock for its whole local gate block (`scripts/pr-gates-lock.mjs`), so concurrent gate runs across `.worktrees` queue as units instead of dying on child lock timeouts or vitest no-output watchdog kills.
- `OPENCLAW_PR_GATES_REMOTE=testbox` runs the full-suite `pnpm test` gate on a Blacksmith Testbox through `scripts/crabbox-wrapper.mjs` (same delegation as `check:changed`); `pnpm build`/`pnpm check` stay local. The `tbx_` lease id and Actions run URL land in `.local/gates.env` (`REMOTE_GATES_*`) and `.local/prep.md`. Use it for reviewed trusted code when a loaded host makes the local 88-shard run stall-kill; contributor/fork code stays on secretless CI or sanitized AWS unless a maintainer explicitly approves credentialed execution.

## Generated Outputs

- If a script writes generated artifacts, keep the source-of-truth generator, the package script, and the matching verification/check command aligned.
- Prefer additive generator/check pairs like `*:gen` and `*:check` over one-off undocumented scripts.

## Scope

- Keep script-runner behavior, wrapper expectations, and generated-artifact guidance here.
- Leave repo-global verification policy in the root `AGENTS.md`.
