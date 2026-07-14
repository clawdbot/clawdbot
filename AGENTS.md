# AGENTS.MD

Telegraph style. Root rules only. Read scoped `AGENTS.md` before subtree work.
Skills own workflows; root owns hard policy and routing.

## Start

- Repo: `https://github.com/openclaw/openclaw`
- Replies: repo-root refs only: `extensions/telegram/src/index.ts:80`. No absolute paths, no `~/`.
- Docs/user-visible work: `pnpm docs:list`, then read relevant docs only.
- Existing-solutions preflight: before proposing or building a custom system, feature, workflow, tool, integration, or automation, do a lightweight check for open-source projects, maintained libraries, existing OpenClaw plugins, or free platforms that already solve it well enough. Prefer those when adequate. Build custom only when existing options are unsuitable, too expensive, unmaintained, unsafe, non-compliant, or the user explicitly asks for custom. Avoid paid-service recommendations unless the user explicitly approves spend. Keep this to a brief preflight gate, not a broad research assignment.
- Fix/triage answers need source, tests, current/shipped behavior, and dependency contract proof.
- Reviews/answers: high confidence required. Default to exhaustive relevant codebase search/read, including owners, callers, siblings, tests, docs, and upstream/dependency contracts before verdict. Diff-only review is insufficient.
- Review default: read the whole changed function/module plus callers, callees, sibling implementations, adjacent tests, scoped docs, and dependency/Codex contracts before saying `good`, `bad`, `best fix`, `proof sufficient`, or posting a comment. If challenged, keep reading first; do not defend the earlier verdict until the missing path is checked.
- Dependency-touching work: direct dependency inspection is mandatory when feasible; do not rely on assumptions, wrappers, or memory. Most dependencies are OSS, so read their source/docs/types. Codex-related work has a hard gate: the acting agent must personally inspect sibling `../codex` source for the exact protocol/runtime behavior before any verdict, comment, approval, merge recommendation, code change, or `proof sufficient` claim. If missing, clone `https://github.com/openai/codex.git` there first. Subagent reports, PR text, OpenClaw wrappers, generated schemas, memory, and prior bot reviews do not satisfy this gate. No direct `../codex` check means no Codex verdict. Cite Codex files/lines checked in final/review/comment.
- Dependency-backed behavior: read upstream docs/source/types first. No API/default/error/timing guesses.
- External API work: live test required. Google/search for additional proof. Prefer official docs/source/types; cite current proof. No memory-only API claims.
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
- Every PR review must explicitly ask whether the PR is the best fix, not merely a plausible fix. Verdicts need a best-fix judgment backed by enough code reading to compare owner boundaries, callers, siblings, tests, docs, current `main`, shipped behavior when relevant, and dependency/Codex contracts when involved.
- Before a PR verdict, build a small evidence map: changed surface, entry point, owner boundary, at least one caller and callee, sibling surfaces that share the invariant, existing tests, and current `main` behavior. If any cell is missing, say the gap instead of concluding.
- One-sided fixes need sibling-surface proof, an explanation for why siblings are unaffected, or explicit follow-up work.
- Changelog findings: see Docs / Changelog.
- Public ClawSweeper comments prefer `https://docs.openclaw.ai/...` when a public docs page exists; structured evidence still cites repo files, lines, SHAs.
- Findings need current source, shipped/current behavior, tests/CI evidence, and dependency contract proof when dependency-backed behavior is involved. Validation is judged against touched and sibling surfaces plus this file's commands; clear evidence matters for user-visible changes, with Telegram/Desktop proof for Telegram-visible behavior when feasible.
- Prefer findings for concrete behavior regressions, missing changed-surface proof, owner-boundary violations, security/API contract issues, or docs/config mismatches.
- Do not file findings for repo policy preference when changed code follows the relevant scoped guide and no user-visible, runtime, security, or maintainer-risk impact is shown.

## Map

- Core TS: `src/`, `ui/`, `packages/`; plugins: `extensions/`; SDK: `src/plugin-sdk/*`; channels: `src/channels/*`; loader: `src/plugins/*`; protocol: `packages/gateway-protocol/*`; docs/apps: `docs/`, `apps/`.
- Installers: sibling `../openclaw.ai`.
- Scoped guides: `extensions/`, `src/{plugin-sdk,channels,plugins,gateway,agents}/`, `packages/`, `test/helpers*/`, `docs/`, `ui/`, `scripts/`.

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
- OpenAI Codex is folded into `openai`. No new/live `openai-codex` provider/plugin/auth/model routes; treat them as legacy input only. Runtime/setup/auth/catalog use `openai` + `openai/*`; doctor/migrations repair stale `openai-codex/*` profiles/metadata.
- Config/env surface bar is high; `openclaw.json` and environment variables are already large. Before adding a config option or env var, first prove existing product behavior, provider selection, defaults, or doctor migration cannot solve it. Prefer removing or consolidating config/env options when touching these surfaces. Core supports only the latest config shape; `openclaw doctor --fix` migrates older shipped shapes into the current one.
- CLI setup flows are public API when external docs, installers, or integrations can copy them. Changes to `openclaw onboard`, `openclaw configure`, their documented flags, non-interactive behavior, or generated config shape are compatibility-sensitive API contract changes; prefer additive flags/aliases, deprecation windows, and backward-preserving migrations over breaking existing snippets.
- Fix shape: default to clean bounded refactor, not smallest patch. Move ownership to right boundary; delete stale abstractions, duplicate policy, dead branches, wrappers, fallback stacks.
- New binary fallible-operation results use `Result` from `@openclaw/normalization-core/result`; domain-rich outcomes keep named discriminated unions.
- Fix observed local failures with generic product rules; do not hardcode names, ids, log phrases, or user examples in prod code unless they are an explicit contract.
- Tests may use observed examples, but prod literals need a short contract reason.
- Compatibility is opt-in. "Shipped" means reachable from a release Git tag; main/GitHub/PR/unreleased code is not shipped.
- Refactor default: one canonical path. Delete the old path unless user explicitly wants compat or the shipped public contract is obvious and cited.
- Core runtime consumes only current canonical shapes/config/data. Legacy or retired shapes normalize only in doctor/migration code before runtime; no runtime shims, aliases, or fallback readers.
- State/storage migrations are database-first. Runtime reads/writes the canonical store only. Old file stores, sidecars, aliases, and fallback readers belong in `openclaw doctor --fix` migration code only, never steady-state runtime.
- Storage default: SQLite only. Do not add JSON/JSONL/TXT/sidecar files for OpenClaw-owned runtime state, caches, queues, registries, indexes, cursors, checkpoints, or plugin scratch data.
- SQLite runtime access uses Kysely helpers, not raw SQL statement strings, except schema DDL, migrations, low-level DB bootstrap, or narrowly justified SQLite primitives.
- SQLite write transactions are synchronous commit sections only. Finish async planning, filesystem access, plugin hooks, and predicates before `BEGIN`; then reread and validate authoritative rows before writing. Never return a Promise or execute `await` from a transaction callback.
- Use the shared state DB (`state/openclaw.sqlite`) for global runtime state and plugin KV data. Use the per-agent DB (`agents/<agentId>/agent/openclaw-agent.sqlite`) for agent-scoped state/cache. Use a dedicated SQLite DB only when schema, volume, or lifecycle clearly does not fit those stores.
- Legacy state/cache files are migration debt. When touching code that reads/writes them, prefer moving the data into SQLite or calling out the refactor follow-up; do not add parallel file paths.
- File storage must be a named product artifact: import/export, user attachment, log, backup, or external tool contract. If it is app state or cache, it belongs in SQLite.
- Before adding any path under state dirs, choose one: shared state DB, plugin KV, agent DB, or dedicated SQLite schema. If none fits, design the SQLite owner/schema first.
- Cache/transient state gets no compat migration unless a shipped user contract is cited. Prefer delete/drop/rebuild over import. If old state can be lost without user-visible data loss, remove the old path entirely.
- Persistent user state gets one migration owner. Doctor migrates, verifies, and then runtime assumes the new shape. No dual-write, read-through fallback, lazy import, or "if SQLite fails use JSON" branches.
- Fallback is a product decision, not an implementation convenience. Before adding one, name the shipped contract, failure mode, removal plan, and why doctor cannot solve it. Otherwise delete it.
- Keep old behavior only for an explicit public API/config/plugin SDK/data contract, tagged upgrade path, security/migration boundary, dependency contract, or observed prod state.
- If unsure, ask before preserving compat. Do not keep aliases, shims, fallback stacks, stale names, or obsolete tests just in case.
- Tests alone do not make internals contracts. If compat stays, name the contract and migration/removal plan in code, test, or PR.
- Lean code is a goal. No internal shims, aliases, legacy names, broad fallbacks, or defensive branches just to reduce diff or handle unrealistic edge cases.
- Handle real production states, tagged upgrade paths, security boundaries, and dependency contracts. Public/hostile/observed malformed input gets care; hypothetical malformed input does not.
- Deprecate shipped public contracts only.
- Plugin SDK exception: shipped external API gets new API first plus named compat/deprecation, small tests/docs if useful, removal plan.
- Migrate internal/bundled callers to modern API in the same change. Do not let internal compat become permanent architecture.
- Channels are implementation under `src/channels/**`; plugin authors get SDK seams. Providers own auth/catalog/runtime hooks; core owns generic loop.
- Message/channel plugins stay transport-only. They render portable presentation/actions, enforce transport limits, and map native callback envelopes. They do not own product command trees, plugin/provider policy, or feature-specific menus.
- Portable command UI must use typed presentation actions, not raw string inference. Do not make channels guess that `value` starting with `/` means a native command; core/owner plugins declare command actions, channels map them when supported.
- Raw callback data is transport/private. Approval, command, URL, web-app, and select actions must stay distinguishable before channel encoding so transport adapters do not special-case product strings.
- Agent run terminal state: normalize/merge via `src/agents/agent-run-terminal-outcome.ts`; do not rederive timeout/cancel precedence in projections.
- Hot paths should carry prepared facts forward: provider id, model ref, channel id, target, capability family, attachment class. Do not rediscover with broad plugin/provider/channel/capability loaders.
- Do not fix repeated request-time discovery with scattered caches. Move the canonical fact earlier; reuse prepared runtime objects; delete duplicate lookup branches.
- Gateway/plugin metadata is process-stable: installs, manifests, catalogs, generated paths, bundled metadata. Changes require restart or explicit owner reload/install/doctor flow.
- Runtime hot paths: no freshness polling (`stat`/`realpath`/JSON reread/hash). Reuse current snapshots, install records, discovery, lookup tables, root scopes, resolved paths.
- Process-local metadata caches ok when lifecycle-owned and bounded/single-slot. Freshness exceptions need named owner + tests.
- Inline comments: preserve reviewer context at the code site. Required for non-obvious cross-path/state invariants, lifecycle ordering, ownership boundaries, queue/dedupe symmetry, TTL/cache expiry, cleanup/release coupling, session/id adoption, fallback behavior, platform/dependency caps, deterministic ordering, compact encoded state, or intentional caller differences.
- Comment shape: 1-3 short lines; state why the branch/helper exists, what contract it protects, and the bad outcome if removed. Cite nearby constants/helpers when useful. No syntax narration, PR/user-specific lore, or obvious mechanics.
- Gateway protocol changes: additive first; incompatible needs versioning/docs/client follow-through.
- Protocol version bumps: explicit owner confirmation only; never automatic/generated.
- Config contract: exported types, schema/help, metadata, baselines, docs aligned. Retired public keys stay retired; compat in raw migration/doctor only.
- Prompt cache: deterministic ordering for maps/sets/registries/plugin lists/files/network results before model/tool payloads. Preserve old transcript bytes when possible.
- Agent tool schema cleanup: remove stale args cleanly; no hidden compat for model-facing params just to avoid churn.

## Commands

- Runtime: Node 22.22.3+, 24.15+, or 25.9+; Node 24 recommended. Keep Node + Bun paths working.
- Package manager/runtime: repo defaults only. No swaps without approval.
- Install: `pnpm install` (keep Bun lock/patches aligned if touched). Agent dependency installation for tests/builds defaults to the selected remote box; do not reconcile a local Codex worktree just to run validation.
- CLI: `pnpm openclaw ...` or `pnpm dev`; build: `pnpm build`.
- Agent tests default remote through Crabbox, including focused tests. Trusted maintainer code defaults to Blacksmith Testbox. Contributor/fork code remains untrusted unless a maintainer explicitly approves credentialed execution after review; an explicit owner/maintainer instruction to land named, reviewed PRs is that approval, so do not ask twice. Otherwise use secretless fork CI or sanitized direct AWS Crabbox, never a credential-hydrated Testbox. Sanitized AWS must launch an installed trusted Crabbox binary from a clean trusted `main` checkout and fetch only the remote PR via `--fresh-pr`; never execute a wrapper, config, or command from the untrusted local checkout. Before warmup, unset `CRABBOX_AWS_INSTANCE_PROFILE` and all `CRABBOX_TAILSCALE*` overrides; fail closed unless resolved `aws.instanceProfile` is empty. Force `--network public --tailscale=false`, clear exit-node/LAN flags, and require `crabbox inspect` to report public networking with no Tailscale state before any script. Upload trusted `scripts/crabbox-untrusted-bootstrap.sh` from clean `main` alongside `--fresh-pr`; it proves the remote IMDSv2 IAM credentials endpoint returns 404, verifies the reviewed head SHA, unsets `NODE_OPTIONS`, installs pinned Node/pnpm, verifies the package-manager pin, isolates `HOME`, installs dependencies, then runs the requested test. Use a newly warmed lease bound to one reviewed head SHA, set `CRABBOX_ENV_ALLOW=CI`, and use `--no-hydrate`. Never reuse a trusted/previously hydrated lease or carry an untrusted lease across head revisions; stop and rewarm when the SHA changes. No repo `OPENCLAW_*` allowlist, existing auth profile, instance role, tailnet/LAN access, moving PR head, or ambient Node preload may reach untrusted execution. When a code task is likely to need tests, classify source trust, pre-warm the safe backend immediately, keep working while it hydrates, reuse trusted leases or same-SHA untrusted leases, then stop before handoff.
- Test commands (run inside the selected remote box by default): `pnpm test <path-or-filter> [vitest args...]`, `pnpm test:changed`, `pnpm test:serial`, `pnpm test:coverage`; never raw `vitest`.
- If raw Vitest is unavoidable, use `vitest run ...`; bare `vitest ...` starts local watch mode and will not exit on its own.
- Local agent test execution is opt-in: only when the user explicitly requests local proof or Testbox is unavailable and the fallback is reported. In a Codex worktree or linked/sparse checkout, the narrow local fallback is `node scripts/run-vitest.mjs <path-or-filter>`; never direct local `pnpm test*`.
- Checks/lint in a normal source checkout: `pnpm check:changed` delegates to Crabbox/Testbox; lanes: `pnpm changed:lanes --json`; staged/path-scoped: `pnpm check:changed --staged` or `pnpm check:changed -- <files...>`; full `pnpm check`/`pnpm lint` only when required.
- Checks in a Codex worktree or linked/sparse checkout: avoid direct local `pnpm check*`; use `node scripts/crabbox-wrapper.mjs run ... -- env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 corepack pnpm check:changed` so pnpm runs inside the selected remote box, not locally.
- Extension tests: `pnpm test:extensions`, `pnpm test extensions`, `pnpm test extensions/<id>`.
- Typecheck: `tsgo` lanes only (`pnpm tsgo*`, `pnpm check:test-types`); never add `tsc --noEmit`, `typecheck`, `check:types`.
- Formatting: `oxfmt`, not Prettier. Use repo wrappers (`pnpm format:*`, `scripts/run-oxlint.mjs`; full `pnpm lint:*` only when scope requires).
- SDK surface gate: `pnpm plugin-sdk:surface:check`; no `plugin-sdk:surface-report` script.
- Build before push when build output, packaging, lazy/module boundaries, dynamic imports, or published surfaces can change; agent builds default to the selected remote box unless platform-specific proof requires another remote host.

## Validation

- Use `$openclaw-testing` for test/CI choice and `$crabbox` for remote/full/E2E proof.
- At task start, if code changes, tests, builds, typechecks, lint fan-out, Docker, packaging, E2E, or live proof are likely, classify source trust and immediately pre-warm the safe Crabbox backend in a background command session. Trusted maintainer code defaults to Blacksmith Testbox; untrusted contributor/fork code uses secretless fork CI or sanitized direct AWS Crabbox under the rule above. Continue inspection/editing while it hydrates; sync the current checkout for every run, reuse the lease, then stop it before handoff.
- Warm Testbox from the task checkout; ownership is checkout-path scoped; `--reclaim` only for intentional transfer.
- One Testbox lease, one active command; never sync/reclaim during a run.
- Testbox `--reclaim` does not retarget the remote checkout; never cross repos.
- Base/head changed: stop and rewarm Testbox; never override stale lease checks.
- Compound Testbox commands: `bash -lc`, never `sh -lc`; job env uses Bash `declare`.
- Testbox cleanup: `blacksmith testbox stop --id <tbx_id>`; id is not positional.
- Delegated Testbox rejects `--fresh-pr` and `--stop-after`; sync current checkout, workflow owns lifecycle.
- PR review artifacts: keep template enum values; put evidence detail in summaries.
- Crabbox request means real scenario proof: install/update/call/repro user path; not just copy tests and run them remotely.
- Visual proof: use Crabbox, set up like a user, then screenshot-verify. No harness/bypass/shortcut unless explicitly asked.
- Local agent work is limited to lightweight non-test checks such as `git diff --check`, targeted formatting, and cheap static probes. Tests and computationally intensive work default to the selected remote box.
- In Codex or linked worktrees, direct local `pnpm test*`, `pnpm check*`, `pnpm crabbox:run`, and `scripts/committer` can trigger pnpm dependency reconciliation or install prompts. Prefer `node` wrappers locally and Crabbox/Testbox for pnpm-gated proof.
- Crabbox wrapper `stop` has no `--timing-json`; use `node scripts/crabbox-wrapper.mjs stop --provider <provider> --id <id>`.
- Repo-native PR worktree may omit `node_modules`; prove remotely, then use `git commit --no-verify`, not `scripts/committer`.
- Parallel agents share the checkout; never switch its branch while sibling work runs.
- Testbox status: `blacksmith testbox status --id <tbx_id>`; no `--json` flag.
- QA CLI `--output-dir` must be repo-relative.
- Full suites, changed gates, builds, typechecks, lint fan-out, Docker/package/E2E/live/cross-OS proof, or anything computationally intensive: Crabbox/Testbox.
- If an allowed local fallback fans out or becomes expensive, stop it and move the work to the pre-warmed remote box.
- Before handoff/push: prove touched surface. Before landing to `main`: proof matches actual risk. Bounded behavior-neutral refactor: focused tests/checks enough; no issue proof or full/broad suite by default.
- Release-branch full validation: freeze the product-complete **Code SHA**, then use `node scripts/full-release-validation-at-sha.mjs --sha <code-sha> --target-ref release/YYYY.M.PATCH`; no raw dispatch without `target_context_ref`.
- Pre-land/pre-commit code changes: mandatory fresh `$autoreview` until no accepted/actionable findings remain. Do not land code on CI, ClawSweeper, prior review comments, or your own manual review alone unless user explicitly opts out or scope is truly trivial/docs-only. If findings want refactor, refactor; no ugly fixes.
- If proof is blocked, say exactly what is missing and why.
- Do not land related failing format/lint/type/build/tests. If unrelated on latest `origin/main`, say so with scoped proof.
- Docs/changelog-only and CI/workflow metadata-only: `git diff --check` plus relevant docs/workflow sanity; escalate only if scripts/config/generated/package/runtime behavior changed.
- Prompt snapshots: CI truth is Linux Node 24. If macOS local passes but CI drifts, reproduce/generate in Linux before rerun.

## GitHub / PRs

- Fresh GitHub items: read `CONTRIBUTING.md`, the issue chooser/form, PR template, and `.github/CODEOWNERS`; blank issues are disabled; preserve templates and evidence requirements.
- Issue first for bugs, user-facing features, architecture/product decisions, or work needing durable discussion. Bounded maintainer-requested refactor may go direct; agent decides whether an issue adds value. PRs use the template, link context, and keep durable problem/impact/evidence sections.
- Route support to Discord and security through `SECURITY.md`. Use listed maintainer areas/`CODEOWNERS`; never guess mentions.
- Use `$openclaw-pr-maintainer` immediately for maintainer-side OpenClaw issue/PR review, triage, duplicates, labels, comments, close, land, or evidence. Contributor PR creation/refresh follows the requested contributor workflow; linked refs alone do not require maintainer archive tooling.
- Issue/PR start: `git status -sb`; if clean, `git pull --ff-only`; if dirty, yell before pull/rebase.
- PR refs: `gh pr view/diff` or `gh api`, not web search. Prefer `gitcrawl` for maintainer discovery; missing/stale `gitcrawl` falls through to live `gh`, not contributor setup. Verify live with `gh` before mutation.
- `gh pr view` takes the branch positionally; no `--head` flag.
- zsh: quote `gh api` endpoints containing `?` or brackets; otherwise glob expansion corrupts the invocation.
- GitHub Actions: resolve workflow files from `.github/workflows` or API; never infer filenames from display names.
- zsh: quote command globs; unmatched patterns abort before the tool runs.
- zsh: don't use `path` as a variable; it rewrites `$PATH`.
- `scripts/pr` artifacts: preserve template enum values; validate before prepare.
- `scripts/pr` subcommands require a PR number; no subcommand `--help` placeholder.
- `scripts/pr` review: checkout main baseline, then PR, before artifact validation.
- PR head changed: rerun `scripts/pr review-init`; checkout alone leaves stale guard SHA.
- `rg`: options before `--`; use `--` before patterns starting with `-`.
- `gh --jq` is not standalone `jq`; pipe JSON to `jq` for variables or `--arg`.
- `gh api --paginate '<endpoint>' | jq -s ...`; gh `--slurp` may emit nothing and forbids `--jq`/`--template`.
- Main-bound workflow dispatch: resolve server `main` SHA immediately before dispatch; retry if identity fails after `main` advances.
- `gh run view --json` uses `attempt`, not `attemptNumber`.
- Crabbox stop: no `--timing-json`; use `node scripts/crabbox-wrapper.mjs stop --provider <provider> --id <id>`.
- macOS `find` has no `-printf`; use `-print0` plus `stat`.
- Actions checkout refs: use full 40-char SHAs; short SHAs resolve as branches/tags.
- zsh Git object paths: use `${sha}:path`; `$sha:path` invokes parameter modifiers.
- Bare issue/PR URL/number: inspect live and take the efficient maintainer path; switch branches/refs when useful.
- No unsolicited PR labels/retitles/rebases/fixups/landing. Comments/reviews ok only for reviewable findings, pre-merge proof, or close/duplicate reason after explicit close/sweep/landing request.
- Maintainer decision closes the cluster: if deciding reported behavior/proposed fix is not planned, comment+close all directly associated open issues/PRs unless explicitly told to keep one open. Associated means linked PRs/issues, duplicates, companion workaround PRs, and the canonical issue for the rejected behavior.
- Do not leave associated issues open for hypothetical future repros. Close with rationale; ask for a new issue or reopen only if concrete new evidence appears. Close comment states: decision, why, supported alternative, and what evidence would change the decision.
- Issue/PR work: search strong related issues/PRs before final; close proven dupes/fixed siblings. If none close, suggest one next related follow-up.
- PR superseded by `main`: if code proof shows `main` already has same-or-better behavior, comment canonical commit/PR + focused proof, then close. Bar high: inspect PR diff, current code/tests, linked issue, caller/sibling path. If unsure, leave open.
- Issue/PR numbers need a short summary every time; assume the reader has not opened or read them.
- Before presenting a batch of issues/PRs, use smart subagents to verify live state and current `main`; omit closed/fixed items, and comment+close items already fixed on `main` when maintainer action is authorized.
- Generic triage and landing shortlists: exclude PRs authored by maintainers with broad repository access until 14 days after creation. An ordinary request for landing candidates does not override this gate; only a named PR or explicit request for maintainer-owned work does.
- PR review answer: bug/behavior, URL(s), affected surface, provenance for regressions when traceable, best-fix judgment, evidence from code/tests/CI/current or shipped behavior.
- PR reviewable findings: post them on the PR, not chat-only, so author sees actionable feedback.
- Issue/PR final answer: last line is the full GitHub URL.
- PR verification: before merge, post land-ready work done, exact local commands, CI/Testbox run IDs, before/after proof when used, and known proof gaps.
- Issue fixed on `main` with proof: comment proof + commit/PR, then close.
- After landing or requested close/sweep: search duplicates; comment proof + canonical commit/PR/release before closing.
- After landing/ship final: include 2-5 sentence recap of what landed: behavior change, key files/surface, proof run, issue/PR state. Do not answer with only status/links.
- `ship` that fixes an issue: after push, comment proof + commit link, then close the issue.
- Public GH comments: show draft in chat first unless user explicitly asked to post/comment/reply/close/merge/land. After work starts and changes/proof exist, post the review/proof/commit comment.
- Representing user: if user already has a comment/thread for the point, update/reply there when possible; avoid duplicate PR/issue comments.
- No surprise GH writes: chat must mention every posted/updated public comment with URL.
- GH comments with backticks, `$`, or shell snippets: use heredoc/body file, not inline double-quoted `--body`.
- PR create: real body required. Use the current template: `What Problem This Solves`, `Why This Change Was Made`, `User Impact`, and `Evidence`; include visible refs, behavior, and validation.
- PR create/refresh: keep PR branches takeover-ready. Use a branch maintainers can push to, or for fork PRs ensure `maintainer_can_modify` / GitHub's `Allow edits by maintainers` is enabled unless explicitly told otherwise or GitHub's Actions/secrets warning makes that unsafe.
- GitHub issue/PR create: read `$agent-transcript`; ask about sanitized transcript logs when available.
- Contributor PRs: parsed context requires authored `What Problem This Solves` and `Evidence` sections. Do not require field-level proof forms; reviewers inspect code, tests, and CI for correctness.
- PR artifacts/screenshots: attach to PR/comment/external artifact store. Never push screenshots, videos, proof images, or proof assets to OpenClaw or any product repo branch, including temp artifact branches. Use Crabbox artifact publishing plus the manifest URL. Do not commit `.github/pr-assets`.
- CI polling: exact SHA, relevant checks only, minimal fields. Skip routine noise (`Auto response`, `Labeler`, docs agents, performance/stale). Logs only after failure/completion or concrete need. Never `gh run watch`; its 3s polling exhausts API quota. Use sparse GraphQL rollups.
- Trusted-workflow release-branch CI: pass `target_ref` + `release_candidate_ref`; never `release_gate` (requires workflow head == target).
- Agent PR landing to `main`: use only the repo-native `scripts/pr` wrapper: run `scripts/pr review-init <PR>`, follow its emitted checkout/guard guidance, initialize and complete review artifacts with `scripts/pr review-artifacts-init <PR>`, validate them with `scripts/pr review-validate-artifacts <PR>`, then run `OPENCLAW_TESTBOX=1 scripts/pr prepare-run <PR>` and `scripts/pr merge-run <PR>`. The Testbox flag is mandatory for agents so prepare verifies hosted CI/Testbox on the current head or reuses a patch-identical pre-rebase run green within 24 hours instead of running full gates locally. `prepare-run` fails fast; invoke only after exact-head CI is complete and green. For owner-approved reviewed fork code without hosted Testbox, use `OPENCLAW_PR_GATES_REMOTE=testbox` instead. Do not rebase only because `main` advanced; merge drift is advisory unless strict drift is explicitly enabled, while GitHub still blocks conflicts. Do not idle on `auto-response` or `check-docs`.
- Non-main PRs: do not run `scripts/pr prepare-run` or `merge-run`; they diff against `main`. Use review artifacts, exact base-head CI, revalidate `headRefOid`, then `gh pr merge --match-head-commit <verified-sha>`.
- Merge guard shells: start `set -euo pipefail`; a failed `[[ ... ]]` alone does not stop a later merge command.
- After `scripts/pr merge-run` removes its worktree, `cd` to a persistent repo before follow-up commands.
- `scripts/pr` review JSON: land-ready recommendation `READY FOR /prepare-pr`, `issueValidation.status=valid`; never `APPROVE`.

## Code

- TS ESM, strict. Avoid `any`; prefer real types, `unknown`, narrow adapters.
- No `@ts-nocheck`. Lint suppressions only intentional + explained.
- External boundaries: prefer `zod` or existing schema helpers.
- Runtime branching: discriminated unions/closed codes over freeform strings. Avoid semantic sentinels (`?? 0`, empty object/string).
- Cross-function state: when valid combos matter, return a closed mode/result shape. Avoid parallel nullable fields or derived booleans that callers must keep in sync; make impossible states unrepresentable.
- Formatter-friendly shape: when oxfmt explodes an expression vertically, extract named booleans, payloads, or small helpers. Do not change width or use format-ignore for local compactness.
- Calls should be boring: complex decisions happen above; call args/object fields are names, literals, or simple property reads.
- Prefer early returns over nested condition pyramids. Split code into gather -> normalize -> decide -> act.
- Use named intermediates only for domain meaning or readability; avoid temp-variable soup.
- Code size matters. Prefer small clear code; maintainability includes not growing LOC without payoff.
- Refactors should delete about as much local complexity as they add. If LOC grows, the new ownership/API needs to clearly pay for it.
- Refactors should reduce non-test LOC unless they remove a larger architectural cost. Treat positive prod LOC as a smell. Before closeout, run `git diff --numstat`; if non-test LOC grew, trim or explicitly justify why fewer paths now exist.
- Prefer deleting branches, modes, adapters, and tests over preserving them. A refactor that adds a second path has probably failed unless the old path is a cited shipped contract.
- New helpers/files must pay rent immediately: fewer call paths, fewer concepts, or less repeated logic. No helpers for one-off compat, naming translation, or speculative resilience.
- Before adding helpers/files, check whether existing code can absorb the behavior with less new surface.
- Keep APIs narrow: export only current caller needs; keep types/helpers local by default.
- Return the smallest useful shape. Avoid broad result objects, flags, metadata unless callers use them.
- Avoid adapter layers that only rename fields. Move real responsibility or leave code local.
- Inline simple one-use objects/spreads when clearer. Extract only when it removes duplication or hard logic.
- Tests prove behavior/regressions, not every internal branch.
- Tests are welcome, but review them before landing for duplication and value. Delete useless tests, such as assertions for behavior or paths just removed.
- Tests protect canonical behavior and migration boundaries, not obsolete internals. Delete tests for removed fallback paths instead of updating them.
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

- Vitest. Colocated `*.test.ts`; e2e `*.e2e.test.ts`; example models `sonnet-4.6`, `gpt-5.6-luna`; test GPT with Luna preferred; use Sol when capability matters; no GPT-4.x agent-smoke defaults.
- Prefer behavior tests over workflow/docs string greps. Put operator policy reminders in AGENTS/docs.
- QA scenario sources are YAML only: `qa/scenarios/index.yaml` and `qa/scenarios/<theme>/*.yaml`. Do not add fenced `qa-scenario`/`qa-flow` Markdown files under `qa/scenarios/`.
- Clean timers/env/globals/mocks/sockets/temp dirs/module state; `--isolate=false` safe.
- Tests asserting resolver/root-containment paths: `fs.realpath` mkdtemp/tmp roots first. macOS `os.tmpdir()` is a `/var` -> `/private/var` symlink; prod resolvers return canonical paths, so raw mkdtemp assertions pass on Linux CI but fail on Mac.
- Explicit `vi.mock` factories must export every binding prod touches, including error classes used in `instanceof` checks; `vi.importActual` the defining module for those instead of stub classes.
- Prefer injection and narrow `*.runtime.ts` mocks over broad barrels or `openclaw/plugin-sdk/*`.
- Do not edit baseline/inventory/ignore/snapshot/expected-failure files to silence checks without explicit approval.
- Do not run independent `pnpm test`/Vitest commands concurrently in one worktree; Vitest cache races with `ENOTEMPTY`. Group one command or use distinct `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH`.
- Vitest rejects Jest `--runInBand`; use `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test` for serial proof. Test workers max 16.
- Live: `OPENCLAW_LIVE_TEST=1 pnpm test:live`; verbose `OPENCLAW_LIVE_TEST_QUIET=0`.
- Guide: `docs/reference/test.md`.

## Docs / Changelog

- Use `$technical-documentation` for docs writing/review. Docs change with behavior/API.
- Codex harness upgrade (`extensions/codex/package.json` `@openai/codex`): refresh `docs/plugins/codex-harness.md` model snapshot from the new harness `model/list`.
- Docs final answers: include relevant full `https://docs.openclaw.ai/...` URL(s). If issue/PR work too, GitHub URL last.
- `CHANGELOG.md`: release-only. Do not edit for normal PRs, direct `main` fixes, or `ship it`; release generation owns it. Do not ask contributors/agents for changelog edits.
- User-facing `fix`/`feat`/`perf`: put release-note context in PR body, squash message, or direct commit: behavior, surface, issue/PR refs, credited human author/reporter.
- Release generation: derive `CHANGELOG.md` from merged PRs + all direct `main` commits. Entries: active `### Changes`/`### Fixes`, single-line, thank credited humans; never thank bots/forbidden handles: `@openclaw`, `@clawsweeper`, `@codex`, `@steipete`.

## Git

- Commit via `scripts/committer "<msg>" <file...>`; stage intended files only.
- Commits: conventional-ish, concise, grouped.
- No manual stash/autostash unless explicit. Branch switches ok when useful; no new worktrees unless requested.
- `main`: no merge commits; rebase on latest `origin/main` before push. After one green run plus clean rebase sanity, do not chase moving `main` with repeated full gates.
- User says `commit`: your changes only. `commit all`: all changes in grouped chunks. `push`: may `git pull --rebase` first.
- User says `ship it`: commit intended changes, pull --rebase, push.
- Do not delete/rename unexpected files; ask if blocking, else ignore.
- Bulk PR close/reopen >50: ask with count/scope.

## Security / Release

- Never commit real phone numbers, videos, credentials, live config.
- Secrets: channel/provider creds in `~/.openclaw/credentials/`; model auth profiles in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`.
- Dependency patches/overrides/vendor changes need explicit approval. `pnpm-workspace.yaml` patched dependencies use exact versions only.
- Release/package guards: no hard-coded retired-package denylists; use generic artifact/dependency checks or fix build source.
- Lockfiles/shrinkwrap are security surface: review `pnpm-lock.yaml`, `npm-shrinkwrap.json`, `package-lock.json`; root/plugin npm packages ship shrinkwrap, not package-lock.
- Carbon pins owner-only: do not change `@buape/carbon` unless Shadow (`@thewilloftheshadow`, verified by `gh`) asks.
- Releases/publish/version bumps need explicit approval. Use `$release-openclaw-maintainer`.
- Release versions use `YYYY.M.PATCH`, where `PATCH` is a sequential monthly release-train number, never the calendar day. Stable and beta tags determine the current train; alpha-only tags do not consume or advance the beta/stable patch number. After `2026.6.5`, the next beta train is `2026.6.6-beta.1` even if higher alpha-only tags exist.
- Alpha/nightly versions use the next unreleased train plus an incrementing prerelease number. Repeated nightlies for the same train increment only `alpha.N`; they must not mint a new patch number from the date.
- Backports are optional. Apply only the operator-selected set; when requested without a target, use the newest open `release/` branch.
- Regular beta/stable flow has two immutable identities:
  - **Code SHA**: version prep plus any optional backports/release fixes, with no release changelog mutation. Full product validation belongs here.
  - **Release SHA**: a descendant of the green Code SHA whose complete diff is exactly `CHANGELOG.md`. Tag, npm preflight, package/install acceptance, and publish belong here.
- Never generate the release changelog before the Code SHA has green Full Release Validation. A product/code failure changes the Code SHA and restarts product validation. A workflow/harness/infrastructure failure is fixed in trusted tooling and rerun against the same Code SHA; do not mutate the candidate to satisfy newer tooling.
- After green Code SHA validation, generate and review `CHANGELOG.md` once. Dispatch Full Release Validation for the Release SHA with evidence reuse enabled; `changelog-only-release-v1` may reuse the Code SHA product evidence only when GitHub independently proves the entire descendant delta is `CHANGELOG.md`. Any other path change requires a new Code SHA and fresh full validation.
- Release-SHA proof is intentionally narrow: release-note/provenance checks, npm preflight/package bytes, install/update acceptance, and publish readiness. Do not rerun the full product matrix merely because the changelog changed.
- Pass the successful Release-SHA validation run and npm preflight run into `release:candidate`; do not let the candidate helper dispatch duplicate copies of evidence that already passed.
- Keep one release operator and one watcher per release identity. Resume partial publish from successful immutable child artifacts/runs; never rebuild or republish an already-published package version.
- GHSA/advisories: `$openclaw-ghsa-maintainer` / `$security-triage`. Secret scanning: `$openclaw-secret-scanning-maintainer`.
- Beta tag/version match: `vYYYY.M.PATCH-beta.N` -> npm `YYYY.M.PATCH-beta.N --tag beta`.

## Platform / Ops

- Before simulator/emulator testing, check real iOS/Android devices.
- "restart iOS/Android apps" = rebuild/reinstall/relaunch, not kill/launch.
- SwiftUI: Observation (`@Observable`, `@Bindable`) over new `ObservableObject`.
- Mac gateway: dev watch = `pnpm gateway:watch`; managed installs = `openclaw gateway restart/status --deep`; logs = `./scripts/clawlog.sh`. No launchd/ad-hoc tmux.
- Mac app permission testing: stable app path + real signing identity required. No `--no-sign`, `SIGN_IDENTITY=-`, or raw debug binary; TCC prompts/listing won't stick.
- Version bump surfaces live in `$release-openclaw-maintainer`.
- Parallels: `$openclaw-parallels-smoke`; Discord roundtrip: `$parallels-discord-roundtrip`.
- Crabbox/WebVNC human demos: keep remote desktop visible/windowed; no fullscreen remote browser unless video/capture-style output.
- Before sharing WebVNC links, use Crabbox screenshot first; verify real app/path works and target UI is not broken.
- ClawSweeper ops: `$clawsweeper`. Deployed hook sessions may post one concise `#clawsweeper` note only when surprising/actionable/risky; if using message tool, reply exactly `NO_REPLY`.
- Generated-media completions wake the requester agent first. Requester visible-reply config decides final text vs message tool; direct media send is fallback/recovery only.
- `message_tool_only`: normal agent final visible reply = current-source `message(action=send)` only. No `NO_REPLY` prompt/contract; no message call = no source reply. Plugin-owned bound-thread reply = plugin return value; no message tool needed. Never auto-publish private final.
- Memory wiki prompt digest stays tiny; prefer `wiki_search` / `wiki_get`; verify contact data before use; source-class provenance for generated people facts.
- Rebrand/migration/config warnings: run `openclaw doctor`.
- Never edit `node_modules`.
- Local-only `.agents` ignores: `.git/info/exclude`, not repo `.gitignore`.
- Provider tool schemas: prefer flat string enum helpers over `Type.Union([Type.Literal(...)])`; some providers reject `anyOf`.
- External messaging: no token-delta channel messages. Follow `docs/concepts/streaming.md`.
