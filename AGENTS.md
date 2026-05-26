# AGENTS.MD

Telegraph style. Root rules only. Read scoped `AGENTS.md` before subtree work.
Skills own workflows; root owns hard policy and routing.

## Start

- Repo: `https://github.com/openclaw/openclaw`
- Replies: repo-root refs only: `extensions/telegram/src/index.ts:80`. No absolute paths, no `~/`.
- Docs/user-visible work: `pnpm docs:list`, then read relevant docs only.
- Fix/triage answers need source, tests, current/shipped behavior, and dependency contract proof.
- Dependency-backed behavior: read upstream docs/source/types first. No API/default/error/timing guesses.
- Live-verify when feasible. Never print secrets.
- Missing deps: `pnpm install`, retry once, then report first actionable error.
- CODEOWNERS: maint/refactor/tests ok. Larger behavior/product/security/ownership: owner ask/review.
- Product/docs/UI/changelog wording: "plugin/plugins"; `extensions/` is internal.
- New channel/plugin/app/doc surface: update `.github/labeler.yml` + GH labels.
- New `AGENTS.md`: add sibling `CLAUDE.md` symlink; edit `AGENTS.md` only.

## ClawSweeper Review Policy

- OpenClaw-specific review rules live here; generic ClawSweeper prompts stay repo-agnostic.
- ClawSweeper-owned schema, labels, close reasons, protected-label gates, maintainer-item gates, and mutation rules live in `openclaw/clawsweeper`.
- Review workers read this full root `AGENTS.md` before judging; no reliance on search snippets, `head`, partial ranges, local excerpts, or truncated copies. Then read every scoped `AGENTS.md` that owns touched paths.
- Optional integrations, providers, channels, skill bundles, MCP surfaces, and service workflows route to plugins, ClawHub, or owner repos when current seams suffice. Keep core items for missing core/plugin APIs, bundled regressions, security/core hardening, or maintainer product decisions.
- Plugin APIs, provider routing, auth/session state, persisted preferences, config loading, config/default additions, migrations, setup, startup checks, and fallback behavior are compatibility/upgrade-sensitive. Treat config breaks, new config/default surfaces, removed fallbacks, fail-closed changes, stricter validation, or new operator action as merge risk even with green CI when they can affect existing users, upgrades, provider/plugin behavior, or maintainer operations.
- For PRs that add, remove, or change config/default surfaces with possible compatibility, upgrade, provider/plugin, operator, setup, startup, or fallback impact, ClawSweeper review should emit a `reviewMetrics` entry when practical. The metric should name the count and direction of the changes, such as added, changed, or removed config/default surfaces, and explain why the metric matters before merge. When the metric indicates concrete merge risk, also surface the concern in `risks`, use `mergeRiskLabels` when the risk matches the label rubric, make `bestSolution` name the desired pre-merge state, and ensure `labelJustifications` explain the specific reason rather than restating the label.
- Review whole decision surfaces, not only the touched runtime, provider, channel, harness, plugin seam, or context path. Check sibling Codex/Pi-style runtimes, provider/model routing, channel delivery, gateway/protocol, plugin SDK, and context-management paths when relevant.
- One-sided fixes need sibling-surface proof, an explanation for why siblings are unaffected, or explicit follow-up work.
- Changelog findings: see Docs / Changelog.
- Public ClawSweeper comments prefer `https://docs.openclaw.ai/...` when a public docs page exists; structured evidence still cites repo files, lines, SHAs.
- Findings need current source, shipped/current behavior, tests/CI evidence, and dependency contract proof when dependency-backed behavior is involved. Validation is judged against touched and sibling surfaces plus this file's commands; real behavior proof matters for user-visible changes, with Telegram/Desktop proof for Telegram-visible behavior when feasible.
- Prefer findings for concrete behavior regressions, missing changed-surface proof, owner-boundary violations, security/API contract issues, or docs/config mismatches.
- Do not file findings for repo policy preference when changed code follows the relevant scoped guide and no user-visible, runtime, security, or maintainer-risk impact is shown.

## Map

- Core TS: `src/`, `ui/`, `packages/`; plugins: `extensions/`; SDK: `src/plugin-sdk/*`; channels: `src/channels/*`; loader: `src/plugins/*`; protocol: `src/gateway/protocol/*`; docs/apps: `docs/`, `apps/`.
- Installers: sibling `../openclaw.ai`.
- Scoped guides: `extensions/`, `src/{plugin-sdk,channels,plugins,gateway,gateway/protocol,agents}/`, `test/helpers*/`, `docs/`, `ui/`, `scripts/`.

## Docs

- Source docs: `docs/**`; publish repo: `openclaw/docs`; host: `https://docs.openclaw.ai`.
- Flow: source -> `docs-sync-publish.yml` -> mirror build -> R2 -> Worker router.
- Docs AI: `openclaw/ask-molty`; see its `AGENTS.md`.

## Architecture

- Core stays plugin-agnostic. No bundled ids/defaults/policy in core when manifest/registry/capability contracts work.
- Plugins cross into core only via `openclaw/plugin-sdk/*`, manifest metadata, injected runtime helpers, documented barrels (`api.ts`, `runtime-api.ts`).
- Plugin prod code: no core `src/**`, `src/plugin-sdk-internal/**`, other plugin `src/**`, or relative outside package.
- Core/tests: no deep plugin internals (`extensions/*/src/**`, `onboard.js`). Use public barrels, SDK facade, generic contracts.
- Owner boundary: owner-specific repair/detection/onboarding/auth/defaults/provider behavior lives in owner plugin. Shared/core gets generic seams only.
- Dependency ownership follows runtime ownership: plugin-only deps stay plugin-local; root deps only for core imports or intentionally internalized bundled plugin runtime.
- Internal bundled plugins ship in core dist; bundled-only facade loader ok only for them.
- External official plugins own package/deps and are excluded from core dist; core uses registry-aware `facade-runtime` or generic contracts.
- Externalizing a bundled plugin: update package excludes, official catalogs, docs, tests, and prove core runtime paths resolve installed plugin roots before root-dep removal.
- Runtime reads canonical config only. No silent compat for old/malformed config keys. If a config change invalidates existing files, add a matching `openclaw doctor --fix` migration. Core/auth config repairs live in core doctor; plugin-owned config repairs live in that plugin's doctor contract (`legacyConfigRules` / `normalizeCompatibilityConfig`).
- Fix shape: default to clean bounded refactor, not smallest patch. Move ownership to right boundary; delete stale abstractions, duplicate policy, dead branches, wrappers, fallback stacks.
- Fix observed local failures with generic product rules; do not hardcode names, ids, log phrases, or user examples in prod code unless they are an explicit contract.
- Tests may use observed examples, but prod literals need a short contract reason.
- Lean code is a goal. No internal shims, aliases, legacy names, broad fallbacks, or defensive branches just to reduce diff or handle unrealistic edge cases.
- Handle real production states, shipped upgrade paths, security boundaries, and dependency contracts. Public/hostile/observed malformed input gets care; hypothetical malformed input does not.
- Unshipped code: clean rewrite/delete. No compat, aliases, shims, deprecations, or fallback scaffolding.
- Deprecate shipped public contracts only.
- Plugin SDK exception: shipped external API gets new API first plus named compat/deprecation, small tests/docs if useful, removal plan.
- Migrate internal/bundled callers to modern API in the same change. Do not let internal compat become permanent architecture.
- Channels are implementation under `src/channels/**`; plugin authors get SDK seams. Providers own auth/catalog/runtime hooks; core owns generic loop.
- Hot paths should carry prepared facts forward: provider id, model ref, channel id, target, capability family, attachment class. Do not rediscover with broad plugin/provider/channel/capability loaders.
- Do not fix repeated request-time discovery with scattered caches. Move the canonical fact earlier; reuse prepared runtime objects; delete duplicate lookup branches.
- Gateway/plugin metadata is process-stable: installs, manifests, catalogs, generated paths, bundled metadata. Changes require restart or explicit owner reload/install/doctor flow.
- Runtime hot paths: no freshness polling (`stat`/`realpath`/JSON reread/hash). Reuse current snapshots, install records, discovery, lookup tables, root scopes, resolved paths.
- Process-local metadata caches ok when lifecycle-owned and bounded/single-slot. Freshness exceptions need named owner + tests.
- Inline comments: add them where they preserve reviewer context: cross-path invariants, lifecycle ordering, ownership boundaries, session/id adoption, queue-depth symmetry, or intentional caller differences. No obvious-mechanics comments.
- Gateway protocol changes: additive first; incompatible needs versioning/docs/client follow-through.
- Protocol version bumps: explicit owner confirmation only; never automatic/generated.
- Config contract: exported types, schema/help, metadata, baselines, docs aligned. Retired public keys stay retired; compat in raw migration/doctor only.
- Prompt cache: deterministic ordering for maps/sets/registries/plugin lists/files/network results before model/tool payloads. Preserve old transcript bytes when possible.
- Agent tool schema cleanup: remove stale args cleanly; no hidden compat for model-facing params just to avoid churn.

## Commands

- Runtime: Node 22.19+; Node 24 recommended. Keep Node + Bun paths working.
- Package manager/runtime: repo defaults only. No swaps without approval.
- Install: `pnpm install` (keep Bun lock/patches aligned if touched).
- CLI: `pnpm openclaw ...` or `pnpm dev`; build: `pnpm build`.
- Tests in a normal source checkout: `pnpm test <path-or-filter> [vitest args...]`, `pnpm test:changed`, `pnpm test:serial`, `pnpm test:coverage`; never raw `vitest`.
- Tests in a Codex worktree or linked/sparse checkout: avoid direct local `pnpm test*`; use `node scripts/run-vitest.mjs <path-or-filter>` for tiny explicit-file proof, or Crabbox/Testbox for anything broader.
- Checks in a normal source checkout: `pnpm check:changed`; lanes: `pnpm changed:lanes --json`; staged: `pnpm check:changed --staged`; full: `pnpm check`.
- Checks in a Codex worktree or linked/sparse checkout: avoid direct local `pnpm check*`; use `node scripts/crabbox-wrapper.mjs run ... --shell -- "pnpm check:changed"` so pnpm runs inside Testbox, not locally.
- Extension tests: `pnpm test:extensions`, `pnpm test extensions`, `pnpm test extensions/<id>`.
- Typecheck: `tsgo` lanes only (`pnpm tsgo*`, `pnpm check:test-types`); never add `tsc --noEmit`, `typecheck`, `check:types`.
- Formatting: `oxfmt`, not Prettier. Use repo wrappers (`pnpm format:*`, `pnpm lint:*`, `scripts/run-oxlint.mjs`).
- Build before push when build output, packaging, lazy/module boundaries, dynamic imports, or published surfaces can change.

## Validation

- Use `$openclaw-testing` for test/CI choice and `$crabbox` for remote/full/E2E proof.
- Crabbox request means real scenario proof: install/update/call/repro user path; not just copy tests and run them remotely.
- Small/narrow tests, lints, format checks, and type probes are fine locally only in a healthy normal checkout.
- In Codex worktrees, direct local `pnpm test*`, `pnpm check*`, `pnpm crabbox:run`, and `scripts/committer` can trigger pnpm dependency reconciliation or install prompts. Prefer `node` wrappers locally and Crabbox/Testbox for pnpm-gated proof.
- Full suites, broad changed gates, Docker/package/E2E/live/cross-OS proof, or anything that bogs down the Mac: Crabbox/Testbox.
- One/few files local. If a local command fans out, stop and move broad proof to Crabbox/Testbox.
- Before handoff/push: prove touched surface. Before landing to `main`: issue proof plus appropriate full/broad proof unless scope is clearly narrow.
- Pre-land/pre-commit code changes: use `$autoreview` until no accepted/actionable findings remain, unless equivalent manual review already done, trivial/docs-only, or user opts out.
- If proof is blocked, say exactly what is missing and why.
- Do not land related failing format/lint/type/build/tests. If unrelated on latest `origin/main`, say so with scoped proof.
- Docs/changelog-only and CI/workflow metadata-only: `git diff --check` plus relevant docs/workflow sanity; escalate only if scripts/config/generated/package/runtime behavior changed.
- Prompt snapshots: CI truth is Linux Node 24. If macOS local passes but CI drifts, reproduce/generate in Linux before rerun.

## GitHub / PRs

- Use `$openclaw-pr-maintainer` immediately for maintainer-side OpenClaw issue/PR review, triage, duplicates, labels, comments, close, land, or evidence. Contributor PR creation/refresh follows the requested contributor workflow; linked refs alone do not require maintainer archive tooling.
- Pasted GitHub issue/PR: first `git status -sb`; if dirty, yell; then `git push` + `git pull --ff-only`.
- PR refs: `gh pr view/diff` or `gh api`, not web search. Prefer `gitcrawl` for maintainer discovery; missing/stale `gitcrawl` falls through to live `gh`, not contributor setup. Verify live with `gh` before mutation.
- Bare issue/PR URL/number means review/report in chat. Suggest comment/close/merge when appropriate; mutate only when asked.
- No unsolicited PR comments/reviews/labels/retitles/rebases/fixups/landing. Exception: close/duplicate action that needs a reason comment after explicit close/sweep/landing request.
- Maintainer decision closes the cluster: if deciding reported behavior/proposed fix is not planned, comment+close all directly associated open issues/PRs unless explicitly told to keep one open. Associated means linked PRs/issues, duplicates, companion workaround PRs, and the canonical issue for the rejected behavior.
- Do not leave associated issues open for hypothetical future repros. Close with rationale; ask for a new issue or reopen only if concrete new evidence appears. Close comment states: decision, why, supported alternative, and what evidence would change the decision.
- PR review answer: bug/behavior, URL(s), affected surface, provenance for regressions when traceable, best-fix judgment, evidence from code/tests/CI/current or shipped behavior.
- Issue/PR final answer: last line is the full GitHub URL.
- PR verification: before merge, post exact local commands, CI/Testbox run IDs, before/after proof when used, and known proof gaps.
- Issue fixed on `main` with proof: comment proof + commit/PR, then close.
- After landing or requested close/sweep: search duplicates; comment proof + canonical commit/PR/release before closing.
- After landing/ship final: include 2-5 sentence recap of what landed: behavior change, key files/surface, proof run, issue/PR state. Do not answer with only status/links.
- `ship` that fixes an issue: after push, comment proof + commit link, then close the issue.
- GH comments with backticks, `$`, or shell snippets: use heredoc/body file, not inline double-quoted `--body`.
- PR create: real body required. Include Summary + Verification; mention refs, behavior, and proof.
- PR create/refresh: keep PR branches takeover-ready. Use a branch maintainers can push to, or for fork PRs ensure `maintainer_can_modify` / GitHub's `Allow edits by maintainers` is enabled unless explicitly told otherwise or GitHub's Actions/secrets warning makes that unsafe.
- GitHub issue/PR create: read `$agent-transcript`; ask about sanitized transcript logs when available.
- Real behavior proof section is parsed. Use exact `field: value` labels: `Behavior addressed`, `Real environment tested`, `Exact steps or command run after this patch`, `Evidence after fix`, `Observed result after fix`, `What was not tested`.
- PR artifacts/screenshots: attach to PR/comment/external artifact store. Never push screenshots, videos, proof images, or proof assets to OpenClaw or any product repo branch, including temp artifact branches. Use Crabbox artifact publishing plus the manifest URL. Do not commit `.github/pr-assets`.
- CI polling: exact SHA, relevant checks only, minimal fields. Skip routine noise (`Auto response`, `Labeler`, docs agents, performance/stale). Logs only after failure/completion or concrete need.
- Maintainers: may skip/ignore `Real behavior proof` when local tests or Crabbox verified behavior; record proof in PR verification.
- `/landpr`: use `~/.codex/prompts/landpr.md`; do not idle on `auto-response` or `check-docs`.

## Code

- TS ESM, strict. Avoid `any`; prefer real types, `unknown`, narrow adapters.
- No `@ts-nocheck`. Lint suppressions only intentional + explained.
- External boundaries: prefer `zod` or existing schema helpers.
- Runtime branching: discriminated unions/closed codes over freeform strings. Avoid semantic sentinels (`?? 0`, empty object/string).
- Formatter-friendly shape: when oxfmt explodes an expression vertically, extract named booleans, payloads, or small helpers. Do not change width or use format-ignore for local compactness.
- Calls should be boring: complex decisions happen above; call args/object fields are names, literals, or simple property reads.
- Prefer early returns over nested condition pyramids. Split code into gather -> normalize -> decide -> act.
- Use named intermediates only for domain meaning or readability; avoid temp-variable soup.
- Code size matters. Prefer small clear code; maintainability includes not growing LOC without payoff.
- Refactors should delete about as much local complexity as they add. If LOC grows, the new ownership/API needs to clearly pay for it.
- Before adding helpers/files, check whether existing code can absorb the behavior with less new surface.
- Keep APIs narrow: export only current caller needs; keep types/helpers local by default.
- Return the smallest useful shape. Avoid broad result objects, flags, metadata unless callers use them.
- Avoid adapter layers that only rename fields. Move real responsibility or leave code local.
- Inline simple one-use objects/spreads when clearer. Extract only when it removes duplication or hard logic.
- Tests prove behavior/regressions, not every internal branch.
- For non-trivial refactors, check `git diff --numstat` before closeout. If LOC grew, trim or explain why.
- Prefer existing narrow helpers over repeated casts/guards. Add local helpers when 2+ nearby call sites share real boundary logic.
- Prefer ctor parameter properties for injected deps/config. Do not ban them for erasable-syntax purity.
- Prefer `satisfies` for registries/config maps; derive types from schemas when a runtime schema already exists.
- Table-drive repetitive tests when it reduces code and keeps failure names clear.
- Dynamic import: no static+dynamic import for same prod module. Use `*.runtime.ts` lazy boundary. After edits: `pnpm build`; check `[INEFFECTIVE_DYNAMIC_IMPORT]`.
- Cycles: keep `pnpm check:import-cycles` + architecture/madge green.
- Classes: no prototype mixins/mutations. Prefer inheritance/composition. Tests prefer per-instance stubs.
- Split files around ~700 LOC when clarity/testability improves.
- Naming: **OpenClaw** product/docs; `openclaw` CLI/package/path/config.
- English: American spelling.

## Tests

- Vitest. Colocated `*.test.ts`; e2e `*.e2e.test.ts`; example models `sonnet-4.6`, `gpt-5.5`; test GPT with 5.5 preferred, 5.4 ok; no GPT-4.x agent-smoke defaults.
- Prefer behavior tests over workflow/docs string greps. Put operator policy reminders in AGENTS/docs.
- Clean timers/env/globals/mocks/sockets/temp dirs/module state; `--isolate=false` safe.
- Prefer injection and narrow `*.runtime.ts` mocks over broad barrels or `openclaw/plugin-sdk/*`.
- Do not edit baseline/inventory/ignore/snapshot/expected-failure files to silence checks without explicit approval.
- Do not run independent `pnpm test`/Vitest commands concurrently in one worktree; Vitest cache races with `ENOTEMPTY`. Group one command or use distinct `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH`.
- Test workers max 16. Memory pressure: `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test`.
- Live: `OPENCLAW_LIVE_TEST=1 pnpm test:live`; verbose `OPENCLAW_LIVE_TEST_QUIET=0`.
- Guide: `docs/reference/test.md`.

## Docs / Changelog

- Use `$technical-documentation` for docs writing/review. Docs change with behavior/API.
- Codex harness upgrade (`extensions/codex/package.json` `@openai/codex`): refresh `docs/plugins/codex-harness.md` model snapshot from the new harness `model/list`.
- Docs final answers: include relevant full `https://docs.openclaw.ai/...` URL(s). If issue/PR work too, GitHub URL last.
- `CHANGELOG.md`: release-owned. Do not edit for normal PRs, direct `main` fixes, or `ship it`; only explicit release/changelog generation may rewrite it. Do not ask contributors/agents for changelog edits.
- User-facing `fix`/`feat`/`perf`: put release-note context in PR body, squash message, or direct commit: behavior, surface, issue/PR refs, credited human author/reporter.
- Release generation: derive `CHANGELOG.md` from merged PRs + all direct `main` commits. Entries: active `### Changes`/`### Fixes`, single-line, thank credited humans; never thank bots/forbidden handles: `@openclaw`, `@clawsweeper`, `@codex`, `@steipete`.

## Git

- Commit via `scripts/committer "<msg>" <file...>`; stage intended files only.
- Commits: conventional-ish, concise, grouped.
- No manual stash/autostash unless explicit. No branch/worktree changes unless requested.
- `main`: no merge commits; rebase on latest `origin/main` before push. After one green run plus clean rebase sanity, do not chase moving `main` with repeated full gates.
- User says `commit`: your changes only. `commit all`: all changes in grouped chunks. `push`: may `git pull --rebase` first.
- User says `ship it`: commit intended changes, pull --rebase, push.
- Do not delete/rename unexpected files; ask if blocking, else ignore.
- Bulk PR close/reopen >5: ask with count/scope.

## Security / Release

- Never commit real phone numbers, videos, credentials, live config.
- Secrets: channel/provider creds in `~/.openclaw/credentials/`; model auth profiles in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`.
- Dependency patches/overrides/vendor changes need explicit approval. `pnpm-workspace.yaml` patched dependencies use exact versions only.
- Lockfiles/shrinkwrap are security surface: review `pnpm-lock.yaml`, `npm-shrinkwrap.json`, `package-lock.json`; root/plugin npm packages ship shrinkwrap, not package-lock.
- Carbon pins owner-only: do not change `@buape/carbon` unless Shadow (`@thewilloftheshadow`, verified by `gh`) asks.
- Releases/publish/version bumps need explicit approval. Use `$release-openclaw-maintainer`.
- GHSA/advisories: `$openclaw-ghsa-maintainer` / `$security-triage`. Secret scanning: `$openclaw-secret-scanning-maintainer`.
- Beta tag/version match: `vYYYY.M.D-beta.N` -> npm `YYYY.M.D-beta.N --tag beta`.

## Platform / Ops

- Before simulator/emulator testing, check real iOS/Android devices.
- "restart iOS/Android apps" = rebuild/reinstall/relaunch, not kill/launch.
- SwiftUI: Observation (`@Observable`, `@Bindable`) over new `ObservableObject`.
- Mac gateway: dev watch = `pnpm gateway:watch`; managed installs = `openclaw gateway restart/status --deep`; logs = `./scripts/clawlog.sh`. No launchd/ad-hoc tmux.
- Mac app permission testing: stable app path + real signing identity required. No `--no-sign`, `SIGN_IDENTITY=-`, or raw debug binary; TCC prompts/listing won't stick.
- Version bump surfaces live in `$release-openclaw-maintainer`.
- Parallels: `$openclaw-parallels-smoke`; Discord roundtrip: `$parallels-discord-roundtrip`.
- Crabbox/WebVNC human demos: keep remote desktop visible/windowed; no fullscreen remote browser unless video/capture-style output.
- ClawSweeper ops: `$clawsweeper`. Deployed hook sessions may post one concise `#clawsweeper` note only when surprising/actionable/risky; if using message tool, reply exactly `NO_REPLY`.
- Memory wiki prompt digest stays tiny; prefer `wiki_search` / `wiki_get`; verify contact data before use; source-class provenance for generated people facts.
- Rebrand/migration/config warnings: run `openclaw doctor`.
- Never edit `node_modules`.
- Local-only `.agents` ignores: `.git/info/exclude`, not repo `.gitignore`.
- Provider tool schemas: prefer flat string enum helpers over `Type.Union([Type.Literal(...)])`; some providers reject `anyOf`.
- External messaging: no token-delta channel messages. Follow `docs/concepts/streaming.md`.
