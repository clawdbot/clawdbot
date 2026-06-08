---
title: "Gateway Web App - Configuration Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Gateway Web App - Configuration Maturity Note

## Summary

The Control UI config editor is a mature operator surface: it reads redacted snapshots, loads schema and UI hints, supports form and raw editing, validates through the Gateway, uses base-hash guards, restores redacted values carefully, applies config/restart plans, and handles SecretRef preflight. Coverage is Stable because both server write flows and browser controllers have focused tests. Quality is Beta because the implementation is robust, but archive evidence includes raw-mode regressions, config-hardening UX requests, and provider/model config surprises.

## Category Scope

Included in this category:

- Config snapshots: Covers Config snapshots across `config.get`, `config.set`, `config.apply`, `config.patch`, and related config schema editing and safe writes behavior.
- Schema form editing: Covers Schema form editing across `config.get`, `config.set`, `config.apply`, `config.patch`, and related config schema editing and safe writes behavior.
- Raw JSON editing: Covers Raw JSON editing across `config.get`, `config.set`, `config.apply`, `config.patch`, and related config schema editing and safe writes behavior.
- Base-hash guarded writes: Covers Base-hash guarded writes across `config.get`, `config.set`, `config.apply`, `config.patch`, and related config schema editing and safe writes behavior.
- Apply and restart: Covers Apply and restart across `config.get`, `config.set`, `config.apply`, `config.patch`, and related config schema editing and safe writes behavior.

## Features

- Config snapshots: Covers Config snapshots across `config.get`, `config.set`, `config.apply`, `config.patch`, and related config schema editing and safe writes behavior.
- Schema form editing: Covers Schema form editing across `config.get`, `config.set`, `config.apply`, `config.patch`, and related config schema editing and safe writes behavior.
- Raw JSON editing: Covers Raw JSON editing across `config.get`, `config.set`, `config.apply`, `config.patch`, and related config schema editing and safe writes behavior.
- Base-hash guarded writes: Covers Base-hash guarded writes across `config.get`, `config.set`, `config.apply`, `config.patch`, and related config schema editing and safe writes behavior.
- Apply and restart: Covers Apply and restart across `config.get`, `config.set`, `config.apply`, `config.patch`, and related config schema editing and safe writes behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Server tests cover config methods, shared-auth changes, validation, restart write results, base hash, and config write helpers; UI tests cover config controllers, form rendering, search, browser form behavior, presets, quick config, and style.
- Negative signals: Full config editing spans plugin/channel schemas, SecretRefs, raw JSON5, restart/reload policy, and remote browser sessions. End-to-end UI proof for every schema branch and plugin-owned field is necessarily partial.
- Integration gaps: Add browser scenario proof for raw round-trip, form-mode edits with redacted secrets, SecretRef rejection, plugin/channel schema fields, concurrent edit base-hash mismatch, and config.apply restart follow-up.

## Quality Score

- Score: `Beta (78%)`
- Gitcrawl reports: Config query returned #39780 for applying config hardening suggestions through UI, #59330 for raw mode disabled by round-trip regression, and PRs #59336 and #76034 for raw-mode repair and basic/advanced field/doc-link UX.
- Discrawl reports: Exact config query returned no rows, but operator-panel archive traffic includes user confusion around elevated exec config shape and restart effects.
- Good qualities: The design uses source snapshots, redaction restore, schema-driven coercion, base-hash guards, safe raw mode fallback, restart sentinels, and scoped RPCs.
- Bad qualities: Config is a high-impact admin surface; small schema, redaction, or reload-plan bugs can break gateway auth or operator permissions in ways that users experience through WebChat.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow proof affect Coverage only.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/browser-control-ui-and-webchat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Config snapshots, Schema form editing, Raw JSON editing, Base-hash guarded writes, Apply and restart.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Config hardening suggestions still ask for better apply-with-diff UX.
- Raw mode and form mode need recurring proof against runtime-default and plugin-schema drift.
- Restart and hot-reload outcomes need clearer user-facing status in the same flow that saved the config.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md` documents config get/set/apply, validation, schema/form rendering, raw JSON editor constraints, base-hash guard, SecretRef preflight, and raw reset behavior.
- `/Users/kevinlin/code/openclaw/docs/gateway/configuration.md` and `/Users/kevinlin/code/openclaw/docs/gateway/configuration-reference.md` document the underlying config model.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/config.ts` implements config RPCs, schema loading, raw parse/validate, base-hash checks, redaction restore, and config open commands.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/config-write-flow.ts` commits config writes, schedules restarts, handles shared-auth changes, and writes restart sentinels.
- `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/config.ts` loads snapshots/schema, serializes form/raw edits, coerces schema values, strips stale redacted placeholders, and submits base hashes.
- `/Users/kevinlin/code/openclaw/ui/src/ui/views/config-form.render.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/views/config-form.node.ts`, and `/Users/kevinlin/code/openclaw/ui/src/ui/views/config.ts` render the editor.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/config.test.ts`, `/Users/kevinlin/code/openclaw/src/gateway/server-methods/config.shared-auth.test.ts`, and `/Users/kevinlin/code/openclaw/src/gateway/runtime-plugin-config.test.ts` cover Gateway config behavior.
- `/Users/kevinlin/code/openclaw/src/secrets/runtime.gateway-auth.integration.test.ts` covers auth-related runtime secret behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/config.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/views/config-form.search.node.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/views/config-form.node.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/views/config.browser.test.ts`, and `/Users/kevinlin/code/openclaw/ui/src/ui/config-form.browser.test.ts` cover browser config editor behavior.
- `/Users/kevinlin/code/openclaw/ui/src/styles/config.test.ts` and `/Users/kevinlin/code/openclaw/ui/src/styles/config-quick.test.ts` cover config UI styling contracts.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "config form Control UI"`

Results:

- Returned open #39780, `Control UI: Config upgrade/hardening suggestions should apply changes automatically with before/after diff and user acceptance, not direct users to edit files manually`.
- Returned open #59330, `Control UI Raw mode permanently disabled since 2026.3.31`.
- Returned adjacent config/provider issues #81961, #74310, #74395, and #65345.

Query: `gitcrawl --json search prs -R openclaw/openclaw "config form Control UI"`

Results:

- Returned open PR #59336, `fix: Config Raw mode permanently disabled due to round-trip check regression`.
- Returned open PR #76034, `feat(config-ui): add basic/advanced field split and doc-link affordance`.
- Returned localization and config-adjacent PRs #81743, #82514, and #58333.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Control UI config schema config apply secret ref raw json form"`

Results:

- Returned no rows.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Control UI channels sessions cron skills nodes exec approvals"`

Results:

- Found a user WebChat transcript where the wrong config shape for elevated exec had to be fixed and restart still did not immediately grant the current session capability.
