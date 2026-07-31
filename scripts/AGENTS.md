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

- Respect the local heavy-check lock behavior in `scripts/lib/local-heavy-check-runtime.mts`.
- Do not bypass that lock for real heavy commands just to make a local loop look faster.
- Metadata-only or explicitly narrow commands may skip the lock when the existing helper logic says that is safe.
- If you change the lock heuristics, add or update the narrow tests under `test/scripts/`.

## PR Prepare Gates

- `scripts/pr` serializes review, prepare, and merge operations per PR across linked worktrees; `scripts/pr gc` skips active or indeterminate locks. Its subcommand classification table is the canonical wrapper trust boundary: a mismatched local wrapper may run only a classified `advisory` subcommand with `--dev-wrapper` or `OPENCLAW_PR_DEV_WRAPPER=1`; classified `landing` subcommands always require canonical/origin-main wrapper code. A successful command return is the trusted synchronous-completion contract: every PR-state-mutating child must be joined before returning, and such work must never daemonize or explicitly escape both the operation group and lock-notification FD. A failed command auto-releases only while its explicit pre-side-effect validation marker remains active; failures after mutation/tool launch, interruptions, and controller loss stay locked because detached children cannot be disproved. After verifying no child tools remain, use the reported exact-OID `scripts/pr lock-recover` command. Never bypass or delete these refs manually.
- `scripts/pr prepare-gates` holds the heavy-check lock for its whole local gate block (`scripts/pr-gates-lock.mts`), so concurrent gate runs across `.worktrees` queue as units instead of dying on child lock timeouts or vitest no-output watchdog kills.
- `OPENCLAW_PR_GATES_REMOTE=testbox` runs the full-suite `pnpm test` gate on a Blacksmith Testbox through `scripts/crabbox-wrapper.mjs` (same delegation as `check:changed`); `pnpm build`/`pnpm check` stay local. The `tbx_` lease id and Actions run URL land in `.local/gates.env` (`REMOTE_GATES_*`) and `.local/prep.md`. Use it for reviewed trusted code when a loaded host makes the local 88-shard run stall-kill; contributor/fork code stays on secretless CI or sanitized AWS unless a maintainer explicitly approves credentialed execution.

## Generated Outputs

- If a script writes generated artifacts, keep the source-of-truth generator, the package script, and the matching verification/check command aligned.
- Prefer additive generator/check pairs like `*:gen` and `*:check` over one-off undocumented scripts.

## Localization Catalog Adoption

- Extend the shared `localization/catalogs.json` registry, `localization-catalogs` CI lane, and Localization Catalog Refresh workflow. Do not add a gate or refresh workflow per product surface.
- Adopted English sources use `<owner>/i18n/catalogs/en.json`; generated targets use `<owner>/i18n/catalogs/generated/<locale>.json`. The convention triggers the shared workflow, and the registry supplies its exact source and publication paths.
- Draft source PRs do not run the lane. Once ready, fork and non-default-base PRs run credential-free advisory detection. Same-repository PRs targeting the default branch fail on missing or stale targets, then a maintainer-authorized trusted workflow updates that same branch under an exact-head lease. Fork/cross-repository merges use one generated follow-up PR. Generated changes and manual/release runs use strict source/generated parity.
- Trusted refresh compares exact base and head revisions, translates only changed catalog areas, and may publish only those areas' owner-local generated targets. Keep source and target catalogs in the same `i18n/catalogs` directory; never redirect one owner's generated output into another owner root.
- Keep refresh budgets atomic and bounded before provider calls: at most 5 areas, 110 stale targets, 500 messages per area, 4,000 characters per message, 100,000 source characters per area, and 2,000,000 source-character translations per run. Split larger work into reviewed owner slices instead of raising limits casually.
- Keep auto-merge disabled. Generation provenance and structural validation do not count as linguistic, product, or safety approval.
- A new area must include the owner runtime import and focused rendering tests in the same adoption slice. Do not register speculative or unconsumed catalogs.
- Extend `localization/surfaces.json` progressively with owner-scoped adapters. Adapters enumerate product-facing source resources; they do not scan arbitrary literals or prove repository-wide coverage.
- Every source discovered by an adapter needs the matching semantic owner and one strict disposition: an owner/namespace/source-matched adopted catalog area, a registered conforming pipeline, an enumerated English-only reason, a native platform constraint, or a deferred issue plus review owner. Generated targets are derived from the catalog registry; adapters cannot declare exclusions.

## Scope

- Keep script-runner behavior, wrapper expectations, and generated-artifact guidance here.
- Leave repo-global verification policy in the root `AGENTS.md`.
