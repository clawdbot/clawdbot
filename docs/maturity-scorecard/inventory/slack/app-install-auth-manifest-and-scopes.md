---
title: "Slack - Channel Setup and Operations Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Slack - Channel Setup and Operations Maturity Note

## Summary

Slack setup has a broad and current implementation surface: production docs cover Socket Mode and HTTP manifests, required token types, SecretRefs, env fallback, user-token reads, and multi-account precedence. The score remains Beta because real workspace setup is still scope- and reinstall-sensitive, and archive evidence shows repeated operator confusion around missing scopes, token type swaps, and multi-account default promotion.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Channel Setup and Operations`
- Merged from: `Setup, Auth, and Runtime Health`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- App Install: Covers App Install across installing `@openclaw/slack`, creating the Slack app, choosing recommended/minimal manifests, bot/app/user/signing-secret credential handling, and related app install, auth, manifest, and scopes behavior.
- Slack app credentials: Covers bot/app/user tokens, signing-secret handling, and Slack credential setup for app authentication.
- Manifest: Covers Manifest across installing `@openclaw/slack`, creating the Slack app, choosing recommended/minimal manifests, bot/app/user/signing-secret credential handling, and related app install, auth, manifest, and scopes behavior.
- Scopes: Covers Scopes across installing `@openclaw/slack`, creating the Slack app, choosing recommended/minimal manifests, bot/app/user/signing-secret credential handling, and related app install, auth, manifest, and scopes behavior.
- Channel status diagnostics: Covers `openclaw channels status --probe`, account snapshots, token source/status fields, capability and scope diagnostics, and Slack repair guidance.
- Slack account status: Covers account snapshots, token source/status fields, capability summaries, and Slack status output.
- Operator Repair: Covers Operator Repair across `openclaw channels status --probe`, account snapshots, token source/status fields, capability and scope diagnostics, and related diagnostics, status, and operator repair behavior.
- Socket: Covers Socket across Socket Mode startup/reconnect/backoff, HTTP Request URL registration and signing-secret verification, transport mode selection, multi-account lifecycle, status/liveness, and runtime startup/skip behavior.
- HTTP transport: Covers HTTP Request URL registration, signing-secret verification, transport mode selection, multi-account lifecycle, status/liveness, and Slack HTTP runtime startup/skip behavior.
- Runtime Lifecycle: Covers Runtime Lifecycle across Socket Mode startup/reconnect/backoff, HTTP Request URL registration and signing-secret verification, transport mode selection, multi-account lifecycle, status/liveness, and runtime startup/skip behavior.
- Socket: Covers Socket across Socket Mode startup/reconnect/backoff, HTTP Request URL registration and signing-secret verification, transport mode selection, multi-account lifecycle, status/liveness, and runtime startup/skip behavior
- HTTP transport: Covers HTTP Request URL registration, signing-secret verification, transport mode selection, multi-account lifecycle, status/liveness, and Slack HTTP runtime startup/skip behavior
- Runtime Lifecycle: Covers Runtime Lifecycle across Socket Mode startup/reconnect/backoff, HTTP Request URL registration and signing-secret verification, transport mode selection, multi-account lifecycle, status/liveness, and runtime startup/skip behavior
- Channel status diagnostics: Covers `openclaw channels status --probe`, account snapshots, token source/status fields, capability and scope diagnostics, and Slack repair guidance
- Slack account status: Covers account snapshots, token source/status fields, capability summaries, and Slack status output
- Operator Repair: Covers Operator Repair across `openclaw channels status --probe`, account snapshots, token source/status fields, capability and scope diagnostics, and related diagnostics, status, and operator repair behavior

## Features

- App Install: Covers App Install across installing `@openclaw/slack`, creating the Slack app, choosing recommended/minimal manifests, bot/app/user/signing-secret credential handling, and related app install, auth, manifest, and scopes behavior.
- Slack app credentials: Covers bot/app/user tokens, signing-secret handling, and Slack credential setup for app authentication.
- Manifest: Covers Manifest across installing `@openclaw/slack`, creating the Slack app, choosing recommended/minimal manifests, bot/app/user/signing-secret credential handling, and related app install, auth, manifest, and scopes behavior.
- Scopes: Covers Scopes across installing `@openclaw/slack`, creating the Slack app, choosing recommended/minimal manifests, bot/app/user/signing-secret credential handling, and related app install, auth, manifest, and scopes behavior.
- Channel status diagnostics: Covers `openclaw channels status --probe`, account snapshots, token source/status fields, capability and scope diagnostics, and Slack repair guidance.
- Slack account status: Covers account snapshots, token source/status fields, capability summaries, and Slack status output.
- Operator Repair: Covers Operator Repair across `openclaw channels status --probe`, account snapshots, token source/status fields, capability and scope diagnostics, and related diagnostics, status, and operator repair behavior.
- Socket: Covers Socket across Socket Mode startup/reconnect/backoff, HTTP Request URL registration and signing-secret verification, transport mode selection, multi-account lifecycle, status/liveness, and runtime startup/skip behavior.
- HTTP transport: Covers HTTP Request URL registration, signing-secret verification, transport mode selection, multi-account lifecycle, status/liveness, and Slack HTTP runtime startup/skip behavior.
- Runtime Lifecycle: Covers Runtime Lifecycle across Socket Mode startup/reconnect/backoff, HTTP Request URL registration and signing-secret verification, transport mode selection, multi-account lifecycle, status/liveness, and runtime startup/skip behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: Production docs and config-schema tests cover Socket Mode, HTTP mode, signing secrets, token source precedence, SecretRefs, user tokens, `dmPolicy="open"` validation, and account inheritance.
- Negative signals: The Slack live lane validates a narrower SUT manifest, not the full production manifest, user-token read mode, every SecretRef provider, or full multi-account onboarding.
- Integration gaps: Missing live workspace install/admin scorecards for app reinstall after scope changes, workspace policy restrictions, multiple Slack apps, and user-token read/write failover.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: `#62387` shows multi-account promotion can strip shared defaults when channel credential/policy keys are promoted incorrectly.
- Discrawl reports: Setup support threads repeatedly cite missing `im:write`, missing `*:read` scopes, app-token/bot-token swaps, and Slack app reinstall requirements after scope changes.
- Good qualities: Source separates active credential surfaces by mode, tracks credential source/status, supports SecretRefs, and documents recommended/minimal manifests with scope rationale.
- Bad qualities: Slack setup is still operator-fragile because Slack grants scopes only after reinstall, the manifest surface is long, and token/source state is easy to misread across default and named accounts.
- Excluded from quality: Unit-test count, live-lane breadth, and integration depth.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/slack.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for App Install, Slack app credentials, Manifest, Scopes, Channel status diagnostics, Slack account status, Operator Repair, Socket, HTTP transport, Runtime Lifecycle.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a live or recorded workspace-install scorecard that starts from a clean Slack app, applies the manifest, reinstalls after scope changes, and verifies token/source status.
- Add explicit maintainer examples for migrating one default Slack account into named accounts without losing shared policy keys.
- Add operator-facing diagnostics that distinguish "scope present in manifest" from "scope granted on installed bot token."

## Evidence

### Docs

- `docs/channels/slack.md` documents install, Quick setup, Socket Mode and HTTP manifests, scope checklist, token model, SecretRef examples, and multi-account setup.
- `docs/plugins/reference/slack.md` identifies package `@openclaw/slack`, install routes, and the `slack` channel surface.
- `docs/gateway/secrets.md` is the linked SecretRef reference for Slack credentials.

### Source

- `extensions/slack/openclaw.plugin.json` registers plugin id `slack`, channel env vars `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_USER_TOKEN`.
- `extensions/slack/src/config-schema.ts` validates token, HTTP signing secret, Socket Mode tuning, user-token, `dmPolicy`, and account-level fields.
- `extensions/slack/src/accounts.ts` resolves default/named accounts, config/env token precedence, `allowFrom`, mode-specific active credentials, actions, streaming, and media fields.
- `extensions/slack/src/account-inspect.ts` reports per-credential source/status including HTTP-only `signingSecretStatus`.
- `extensions/slack/src/scopes.ts`, `extensions/slack/src/security.ts`, `extensions/slack/src/security-audit.ts`, and `extensions/slack/src/doctor.ts` back scope/security/repair reporting.

### Integration tests

- `extensions/qa-lab/src/live-transports/slack/slack-live.runtime.ts` builds Slack QA config with distinct SUT/driver bot tokens and SUT app token.
- `docs/concepts/qa-e2e-automation.md` documents live Slack QA workspace setup with separate Driver and SUT Slack apps.
- Live lane coverage is intentionally narrower than the production manifest and does not cover all setup/admin branches.

### Unit tests

- `extensions/slack/src/config-schema.test.ts` covers HTTP signing-secret validation, Socket Mode ping/pong settings, `dmPolicy="open"` guardrails, and user-token fields.
- `extensions/slack/src/accounts.test.ts` covers allowlist precedence, named account inheritance, SecretRef failures, HTTP-mode credential activity, and env fallback.
- `extensions/slack/src/channel.lazy-seams.test.ts`, `extensions/slack/src/scopes.test.ts`, `extensions/slack/src/security-audit.test.ts`, and `extensions/slack/src/doctor.test.ts` cover status, scope, security, and doctor seams.

### Gitcrawl queries

Query:

- `gitcrawl search issues "Slack install app manifest scopes token multi-account" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10`
- `gitcrawl search openclaw/openclaw --query "slack appToken botToken signingSecret" --json`

Results:

- The focused issue search returned `[]`.
- The broader query returned `#62387`, "fix(channels): most channels missing namedAccountPromotionKeys - multi-account promotion strips shared defaults", with Slack credential and policy keys called out as examples.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Slack app manifest scopes token"`

Results:

- Returned support threads on Slack image upload/setup, missing scopes, token type checks, app reinstall after OAuth scope changes, `auth.scopes`/`apps.permissions.info` `unknown_method`, and onboarding manifest `im:write` gaps.
