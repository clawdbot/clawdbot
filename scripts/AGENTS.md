# Scripts Guide

This directory owns local tooling, script wrappers, and generated-artifact helper rules.

## Wrapper Rules

- Prefer existing wrappers over raw tool entrypoints when the repo already has a curated seam.
- For tests, prefer `scripts/run-vitest.mjs` or the root `pnpm test ...` entrypoints over raw `vitest run` calls.
- Never use bare `vitest ...` in automation; it starts local watch mode unless `run` or `--run` is explicit.
- For lint/typecheck flows, prefer `scripts/run-oxlint.mjs` and `scripts/run-tsgo.mjs` when adding or editing package scripts or CI steps that should honor repo-local runtime behavior.
- For changed-file verification, prefer `scripts/check-changed.mjs` and keep lane classification in `scripts/changed-lanes.mjs`. Use `node scripts/check-changed.mjs --dry-run [--staged|-- <files...>]` to inspect the plan before running anything expensive. Do not copy path-scope rules into new hooks or ad hoc CI snippets.
- For one/few lint files, prefer direct `node scripts/run-oxlint.mjs --tsconfig <matching config> <files...>` over sharded `pnpm lint`; `check-changed.mjs` owns this targeting for core, extension, and script diffs.

## PR Prepare Gates

- `scripts/pr` serializes review, prepare, and merge operations per PR across linked worktrees; `scripts/pr gc` skips active or indeterminate locks. Its subcommand classification table is the canonical wrapper trust boundary: a mismatched local wrapper may run only a classified `advisory` subcommand with `--dev-wrapper` or `OPENCLAW_PR_DEV_WRAPPER=1`; classified `landing` subcommands always require canonical/origin-main wrapper code. A worktree whose wrapper differs from origin/main (stale base or wrapper-editing branch) loudly substitutes the canonical checkout's wrapper when that checkout is clean and byte-identical to fetched `refs/remotes/origin/main`; it refuses only when no anchor-matching wrapper is available. A successful command return is the trusted synchronous-completion contract: every PR-state-mutating child must be joined before returning, and such work must never daemonize or explicitly escape both the operation group and lock-notification FD. Release on clean exit requires the leader's completion marker; an escaped descendant that merely holds the notify pipe then produces a loud warned release instead of retention (#124583), while all failure shapes still retain. A failed command auto-releases only while its explicit pre-side-effect validation marker remains active; failures after mutation/tool launch, interruptions, and controller loss stay locked because detached children cannot be disproved. After verifying no child tools remain, use the reported exact-OID `scripts/pr lock-recover` command. Never bypass or delete these refs manually.
- `OPENCLAW_PR_GATES_REMOTE=testbox` runs the full-suite `pnpm test` gate on a Blacksmith Testbox through `scripts/crabbox-wrapper.mjs` (same delegation as `check:changed`); `pnpm build`/`pnpm check` stay local. The `tbx_` lease id and Actions run URL land in `.local/gates.env` (`REMOTE_GATES_*`) and `.local/prep.md`. Use it for reviewed trusted code when a loaded host makes the local 88-shard run stall-kill; contributor/fork code stays on secretless CI or sanitized AWS unless a maintainer explicitly approves credentialed execution.

## Generated Outputs

- If a script writes generated artifacts, keep the source-of-truth generator, the package script, and the matching verification/check command aligned.
- Prefer additive generator/check pairs like `*:gen` and `*:check` over one-off undocumented scripts.

## Scope

- Keep script-runner behavior, wrapper expectations, and generated-artifact guidance here.
- Leave repo-global verification policy in the root `AGENTS.md`.
