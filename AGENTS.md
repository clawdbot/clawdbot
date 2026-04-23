# AGENTS.MD

Telegraph style. Root rules only. Read scoped `AGENTS.md` before touching a subtree.

## Start

- Repo: `https://github.com/openclaw/openclaw`
- Replies: repo-root file refs only, e.g. `extensions/telegram/src/index.ts:80`. No absolute paths, no `~/`.
- CODEOWNERS: maintenance/refactors/tests are ok. For larger behavior, product, security, or ownership-sensitive changes, get a listed owner request/review first.
- First pass: run docs list (`pnpm docs:list`; ignore if unavailable), then read only relevant docs/guides.
- Missing deps: run `pnpm install`, rerun once, then report first actionable error.
- Use "plugin/plugins" in docs/UI/changelog. `extensions/` remains internal workspace layout.
- Add channel/plugin/app/doc surface: update `.github/labeler.yml` and matching GitHub labels.
- New `AGENTS.md`: add sibling `CLAUDE.md` symlink to it.

## Repo Map

- Core TS: `src/`, `ui/`, `packages/`
- Bundled plugins: `extensions/`
- Plugin SDK/public contract: `src/plugin-sdk/*`
- Core channel internals: `src/channels/*`
- Plugin loader/registry/contracts: `src/plugins/*`
- Gateway protocol: `src/gateway/protocol/*`
- Docs: `docs/`
- Apps: `apps/`, `Swabble/`
- Installers served from `openclaw.ai`: sibling `../openclaw.ai`

Scoped guides:

- `extensions/AGENTS.md`: bundled plugin rules
- `src/plugin-sdk/AGENTS.md`: public SDK rules
- `src/channels/AGENTS.md`: channel core rules
- `src/plugins/AGENTS.md`: plugin loader/registry rules
- `src/gateway/AGENTS.md`, `src/gateway/protocol/AGENTS.md`: gateway/protocol rules
- `src/agents/AGENTS.md`: agent import/test perf rules
- `test/helpers/AGENTS.md`, `test/helpers/channels/AGENTS.md`: shared test helpers
- `docs/AGENTS.md`, `ui/AGENTS.md`, `scripts/AGENTS.md`: docs/UI/scripts

## Architecture

- Core must stay extension-agnostic. No core special cases for bundled plugin/provider/channel ids when manifest/registry/capability contracts can express it.
- Extensions cross into core only via `openclaw/plugin-sdk/*`, manifest metadata, injected runtime helpers, and documented local barrels (`api.ts`, `runtime-api.ts`).
- Extension production code must not import core `src/**`, `src/plugin-sdk-internal/**`, another extension's `src/**`, or relative paths outside its package.
- Core code/tests must not deep-import plugin internals (`extensions/*/src/**`, `onboard.js`). Use plugin `api.ts` / public SDK facade / generic contract.
- Extension-owned behavior stays in the extension: legacy repair, detection, onboarding, auth/provider defaults, provider tools/settings.
- Legacy config repair: prefer doctor/fix paths over startup/load-time core migrations.
- If a core test asserts extension-specific behavior, move it to the owning extension or a generic contract test.
- New seams: backwards-compatible, documented, versioned. Third-party plugins exist.
- Channels: `src/channels/**` is implementation. Plugin authors get SDK seams, not channel internals.
- Providers: core owns generic inference loop; provider plugins own provider-specific auth/catalog/runtime hooks.
- Gateway protocol changes are contract changes: additive first; incompatible needs versioning/docs/client follow-through.
- Config contract: keep exported types, schema/help, generated metadata, baselines, docs aligned. Retired public keys stay retired; compatibility belongs in raw migration/doctor paths.
- Plugin architecture direction: manifest-first control plane; targeted runtime loaders; no hidden paths around declared contracts; broad mutable registries are transitional.
- Prompt-cache rule: deterministic ordering for maps/sets/registries/plugin lists/files/network results before model/tool payloads. Preserve old transcript bytes when possible.

## Commands

- Runtime: Node 22+. Keep Node and Bun paths working.
- Install: `pnpm install` (Bun supported; keep lockfiles/patches aligned if touched).
- Dev CLI: `pnpm openclaw ...` or `pnpm dev`.
- Build: `pnpm build`
- Smart local gate: `pnpm check:changed` (scoped typecheck/lint/guards + relevant tests)
- Explain smart gate: `pnpm changed:lanes --json`
- Pre-commit view: `pnpm check:changed --staged`
- Normal full prod sweep: `pnpm check` (prod typecheck/lint/guards, no tests)
- Full tests: `pnpm test`
- Changed tests only: `pnpm test:changed`
- Local serial loop: `pnpm test:serial`
- Extension tests: `pnpm test:extensions` or `pnpm test extensions` = all extension shards; `pnpm test extensions/<id>` = one extension lane. Heavy channels/OpenAI have dedicated shards.
- Shard timing artifact: `.artifacts/vitest-shard-timings.json`; auto-used for balanced shard ordering. Disable with `OPENCLAW_TEST_PROJECTS_TIMINGS=0`.
- Targeted tests: `pnpm test <path-or-filter> [vitest args...]`; do not call raw `vitest`.
- Coverage: `pnpm test:coverage`
- Format check/fix: `pnpm format:check` / `pnpm format`
- Typecheck:
  - `pnpm tsgo`: fastest core prod graph
  - `pnpm tsgo:prod`: core + extensions prod graphs; used by `pnpm check`
  - `pnpm check:test-types` / `pnpm tsgo:test`: all test graphs
  - `pnpm tsgo:all`: all prod + test project refs
  - Debug slices exist; do not present as normal user flow.
  - Profile: `pnpm tsgo:profile [core-test|extensions-test|--all]`
- Type policy: use `tsgo`; do not add `tsc --noEmit`, `typecheck`, or `check:types` lanes. `tsc` only for declaration/package-boundary emit gaps.
- Lint:
  - `pnpm lint`: core/extensions/scripts shards
  - `pnpm lint:core`, `pnpm lint:extensions`, `pnpm lint:scripts`
  - `pnpm lint:apps`: Swift/app surface, separate from TS lint
  - `pnpm lint:all`: legacy comparison lane
- Local heavy-check behavior: `OPENCLAW_LOCAL_CHECK=1` default; `OPENCLAW_LOCAL_CHECK_MODE=throttled|full`; `OPENCLAW_LOCAL_CHECK=0` for CI/shared runs.
- Local validation is local-first. Do not default to Blacksmith/Testbox for routine OpenClaw iteration; it burns warm caches and startup time. Use repo `pnpm` lanes first, then reach for remote CI/Testbox only for parity-only failures, secrets/services, or when explicitly requested.

## GitHub API

- Issue/PR triage: list first, hydrate few. Use bounded fields + `--jq`, e.g. `gh issue list --state open --limit 80 --json number,title,labels,updatedAt,comments --jq '.[]|[.number,.updatedAt,.comments,.title]|@tsv'`; then `gh issue view <n> --json title,body,comments,labels,createdAt,updatedAt,url --jq '{title,labels,createdAt,updatedAt,url,body,comments:[.comments[]|{author:.author.login,createdAt,body}]}'` only for shortlisted items.
- Search/dedupe: prefer `gh search issues 'repo:openclaw/openclaw is:open <terms>' --json number,title,state,updatedAt --limit 20 --jq '.[]|[.number,.updatedAt,.title]|@tsv'`; avoid repeated full `--comments` scans.
- After landing a PR: search for duplicate open issues/PRs that can be closed.
- Before closing an issue/PR: add a comment explaining why, usually duplicate/invalid, with the canonical issue/PR when relevant.
- PR links: `gh pr list --state open --search '<issue-or-terms>' --json number,title,updatedAt,headRefName --limit 20`; use `gh pr view <n> --json number,title,body,closingIssuesReferences,files,statusCheckRollup,reviewDecision` only after shortlist.
- CI polling: keep full `gh` capability, but request only needed fields. Known run status: `gh api repos/<owner>/<repo>/actions/runs/<id> --jq '{status,conclusion,head_sha,updated_at,name,path}'`.
- Waiting: poll lightly, usually 30-60s backoff. Fetch jobs/logs/artifacts only after completion/failure or when job detail is needed; avoid repeated workflow + run + jobs loops.

## Gates

- Pre-commit hook: staged format/lint, then `pnpm check:changed --staged`; docs/markdown-only skips changed-scope check; `FAST_COMMIT=1` / `scripts/committer --fast` skips changed-scope check only.
- Changed lanes:
  - core prod => core prod typecheck + core tests
  - core tests => core test typecheck/tests only
  - extension prod => extension prod typecheck + extension tests
  - extension tests => extension test typecheck/tests only
  - public SDK/plugin contract => extension prod/test validation too
  - unknown root/config => all lanes
- Local loop: prefer `pnpm check:changed`; use `pnpm test:changed` for tests only; use `pnpm check` for full prod TS/lint sweep without tests.
- Landing on `main`: verify touched surface near landing; default bar is `pnpm check` + `pnpm test` when feasible.
- Hard build gate: run/pass `pnpm build` before push if build output, packaging, lazy/module boundaries, or published surfaces can change.
- Do not land related failing format/lint/type/build/tests. If failures are unrelated on latest `origin/main`, say so and give scoped proof.
- Fast commit escape hatch: use `scripts/committer --fast "<msg>" <file...>` only after the exact staged change set was already validated with equal-or-stronger gates, or after rerunning an isolated flaky failure with proof. State the gates/proof in handoff.
- CI architecture gate: `check-additional`; local equivalent `pnpm check:architecture`.
- Config docs drift: `pnpm config:docs:gen/check`
- Plugin SDK API drift: `pnpm plugin-sdk:api:gen/check`
- Generated docs baselines: tracked `docs/.generated/*.sha256`; full JSON ignored.

## Code Style

- TypeScript ESM. Strict types. Avoid `any`; prefer real types/`unknown`/narrow adapters.
- No `@ts-nocheck`. No lint suppressions unless intentional and explained.
- External boundaries: prefer `zod` or existing schema helpers.
- Runtime branching: prefer discriminated unions / closed codes over freeform strings.
- Avoid magic sentinels like `?? 0`, empty object/string when semantics change.
- Dynamic import: do not mix static and dynamic import for same module in prod path. Use dedicated `*.runtime.ts` lazy boundary. After lazy-boundary edits, run `pnpm build` and check `[INEFFECTIVE_DYNAMIC_IMPORT]`.
- Cycles: keep `pnpm check:import-cycles` and architecture/madge cycle checks green.
- Classes: no prototype mixins/mutations. Use explicit inheritance/composition. Tests prefer per-instance stubs.
- Comments: brief only for non-obvious logic.
- File size: split around ~700 LOC when it improves clarity/testability.
- Product naming: **OpenClaw** product/docs; `openclaw` CLI/package/path/config.
- Written English: American spelling.

## Tests

- Vitest. Tests colocated `*.test.ts`; e2e `*.e2e.test.ts`.
- Example models in tests: `sonnet-4.6`, `gpt-5.4`.
- Clean up timers/env/globals/mocks/sockets/temp dirs/module state; `--isolate=false` must stay safe.
- Hot tests: avoid per-test `vi.resetModules()` + fresh heavy imports; prefer static or `beforeAll` imports and reset state directly.
- Measure first: `pnpm test:perf:imports <file>` for import drag; `pnpm test:perf:hotspots --limit N` for suite targets.
- Keep tests at seam depth: unit-test pure helpers/contracts; one integration smoke per boundary, not per branch.
- Mock expensive runtime seams directly: scanners, manifests, package registries, filesystem crawls, provider SDKs, network/process launch.
- Prefer injected deps over module mocks; if mocking modules, mock narrow local `*.runtime.ts` seams, not broad barrels.
- Share fixtures/builders; do not recreate temp dirs, package manifests, or plugin workspaces in every case unless state isolation needs it.
- Delete duplicate assertions when another test owns the boundary; assert only the behavior that can regress here.
- Avoid broad `importOriginal()` / broad `openclaw/plugin-sdk/*` partial mocks in hot tests. Add narrow local `*.runtime.ts` seam and mock it.
- Use existing deps/callback/runtime injection seams before module mocks.
- Import-dominated test time is a boundary smell; shrink import surface before adding cases.
- Replacing slow integration coverage: extract production composition into a named helper and test that helper.
- Do not modify baseline/inventory/ignore/snapshot/expected-failure files to silence checks without explicit approval.
- Do not set test workers above 16. For memory pressure: `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test`.
- Live: `OPENCLAW_LIVE_TEST=1 pnpm test:live`; full logs `OPENCLAW_LIVE_TEST_QUIET=0`.
- Full testing guide: `docs/help/testing.md`.

## Docs / Changelog

- Update docs when behavior/API changes. Use docs list/read_when hints.
- Docs links: see `docs/AGENTS.md`.
- Changelog: user-facing only. Pure test/internal changes usually no entry.
- Changelog placement: append to active version `### Changes`/`### Fixes`; at most one contributor mention, prefer `Thanks @user`.

## Git

- Use `scripts/committer "<msg>" <file...>`; stage only intended files. Use `--fast` only under the Gates escape-hatch rule above.
- Commits: conventional-ish, concise/action-oriented. Group related changes.
- No manual stash/autostash unless explicitly requested. No branch/worktree changes unless requested.
- No merge commits on `main`; rebase on latest `origin/main` before push.
- User says "commit": commit your changes only. "commit all": commit everything in grouped chunks. "push": may `git pull --rebase` first.
- Do not delete/rename unexpected files; ask if it blocks. Otherwise ignore unrelated WIP.
- If bulk PR close/reopen affects >5 PRs, ask with exact count/scope.
- PR/issue workflows: use `$openclaw-pr-maintainer`.
- `/landpr`: use `~/.codex/prompts/landpr.md`.

## Security / Release

- Never commit real phone numbers, videos, credentials, live config.
- Secrets: channel/provider credentials under `~/.openclaw/credentials/`; model auth profiles under `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`.
- Env keys: check `~/.profile`.
- Dependency patches/overrides/vendor changes require explicit approval. `pnpm.patchedDependencies` must use exact versions.
- Carbon pins owner-only: do not change `@buape/carbon` versions unless Shadow (`@thewilloftheshadow`, verified by `gh`) asks.
- Releases/publish/version bumps require explicit approval.
- Release docs: `docs/reference/RELEASING.md`; use `$openclaw-release-maintainer`.
- GHSA/advisories: use `$openclaw-ghsa-maintainer`.
- Beta tag/version must match, e.g. `vYYYY.M.D-beta.N` => npm `YYYY.M.D-beta.N --tag beta`.

## Apps / Platform

- Before simulator/emulator testing, check connected real iOS/Android devices first.
- "restart iOS/Android apps" = rebuild/reinstall/relaunch, not kill/launch.
- SwiftUI: prefer Observation (`@Observable`, `@Bindable`) over new `ObservableObject`.
- mac gateway: use app or `openclaw gateway restart/status --deep`; avoid ad-hoc tmux gateway sessions. Rebuild mac app locally, not over SSH.
- mac logs: `./scripts/clawlog.sh`.
- Version bump touches: `package.json`, `apps/android/app/build.gradle.kts`, `apps/ios/version.json` then `pnpm ios:version:sync`, `apps/macos/.../Info.plist`, `docs/install/updating.md`. Appcast only for Sparkle release.
- iOS Team ID: `security find-identity -p codesigning -v`; fallback `defaults read com.apple.dt.Xcode IDEProvisioningTeamIdentifiers`.
- Mobile LAN pairing: plaintext `ws://` is loopback-only by default. Trusted private-network `ws://` needs `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1`; Tailscale/public use `wss://` or a tunnel.
- A2UI hash `src/canvas-host/a2ui/.bundle.hash`: generated; ignore unless running `pnpm canvas:a2ui:bundle`; commit separately.

## External Ops

- Remote install docs: `docs/install/exe-dev.md`, `docs/install/fly.md`, `docs/install/hetzner.md`.
- Parallels smoke: `$openclaw-parallels-smoke`; Discord roundtrip: `parallels-discord-roundtrip`.

## Misc Footguns

- Rebrand/migration/config warnings: run `openclaw doctor`.
- Never edit `node_modules`.
- Local-only `.agents` ignores: use `.git/info/exclude`, not repo `.gitignore`.
- CLI progress: use `src/cli/progress.ts`; status tables: `src/terminal/table.ts`.
- Connection/provider additions: update all UI surfaces + docs + status/config forms.
- Provider-facing tool schemas: prefer flat string enum helpers over `Type.Union([Type.Literal(...)])`; some providers reject generated `anyOf`. Do not treat this as a repo-wide protocol/schema ban.
- External messaging surfaces: no token-delta channel messages. Follow `docs/concepts/streaming.md`; preview/block streaming uses message edits/chunks and must preserve final/fallback delivery.
