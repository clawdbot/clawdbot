---
title: "WhatsApp - Access and Identity Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# WhatsApp - Access and Identity Maturity Note

## Summary

WhatsApp pairing, login, and session auth are Beta. The core QR login,
per-account auth, corrupt credential recovery, logout/relink, and DM pairing
store paths are documented and source-backed, but live proof mostly starts after
credentials already exist and archive evidence still shows QR/session and
profile-boundary churn.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Access and Identity`
- Merged from: `Access Control`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- QR login: QR login and agent login QR flows
- Baileys multi-file auth persistence: Baileys multi-file auth persistence, queued credential writes, backup restore, and login recovery.
- DM pairing challenge: DM pairing challenge and allow-store persistence where it intersects WhatsApp
- Multi-account/default-account resolution: Multi-account/default-account resolution and Baileys 515/401 recovery
- Direct-message dmPolicy: Direct-message dmPolicy, allowFrom, pairing challenge, pairing-store
- Sender identity extraction: Sender identity extraction, read receipts, self-chat safeguards, and contact matching.
- Privacy controls for plugin hooks: Privacy controls for plugin hooks and untrusted context
- Direct-message `dmPolicy`: Covers Direct-message `dmPolicy`, `allowFrom`, pairing challenge, pairing-store behavior.
- Sender identity extraction: Covers Sender identity extraction, read receipts, self-chat safeguards, contact and behavior.
- Privacy controls for plugin hooks and: Covers Privacy controls for plugin hooks and untrusted context behavior.

## Features

- QR login: QR login and agent login QR flows
- Baileys multi-file auth persistence: Baileys multi-file auth persistence, queued credential writes, backup restore, and login recovery.
- DM pairing challenge: DM pairing challenge and allow-store persistence where it intersects WhatsApp
- Multi-account/default-account resolution: Multi-account/default-account resolution and Baileys 515/401 recovery
- Direct-message dmPolicy: Direct-message dmPolicy, allowFrom, pairing challenge, pairing-store
- Sender identity extraction: Sender identity extraction, read receipts, self-chat safeguards, and contact matching.
- Privacy controls for plugin hooks: Privacy controls for plugin hooks and untrusted context

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: docs cover QR login, account-specific login, pairing
  approval, auth paths, reconnect, logout, and multi-account defaults; source
  covers Baileys auth, queued writes, backup restore, auth-state barriers, 515
  restart handling, and 401 logout cleanup.
- Negative signals: standard live QA uses pre-leased auth archives and does not
  routinely prove first-time QR scan, relink, or broad multi-account credential
  isolation.
- Integration gaps: no located live scenario exercises first-time QR scan,
  account relink, secondary-account boot, and profile-boundary auth isolation in
  one regression matrix.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: `WhatsApp QR login authDir pairing multi-account Baileys session restart` surfaced open #77066 secondary-account boot crash; `WhatsApp credentials leak across profile boundaries` surfaced open #64555 credential leakage across profile boundaries.
- Discrawl reports: QR/login searches surfaced #51111 device-removed disconnects, a thread where QR succeeds but the listener never starts with repeated 515/logout recovery, Railway QR linking trouble, and discussions around pairing-code spam fixes.
- Good qualities: credential writes are queued and atomic, corrupt creds can
  restore from backup, symlink/custom-dir cleanup is guarded, account IDs are
  normalized, and docs align with source caveats.
- Bad qualities: Baileys is pinned to release-candidate `7.0.0-rc13`, QR-only
  login is fragile on remote/headless hosts, and recent archive evidence shows
  multi-account/profile-boundary defects.
- Excluded from quality: unit, integration, e2e, live, and real runtime-flow
  test coverage did not raise or lower this Quality score.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/whatsapp.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for QR login, Baileys multi-file auth persistence, DM pairing challenge, Multi-account/default-account resolution, Direct-message dmPolicy, Sender identity extraction, Privacy controls for plugin hooks.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add recurring live first-time QR login and relink scenarios.
- Add broad live multi-account auth-dir/profile-isolation proof.
- Keep remote/headless QR handoff and phone-code fallback work visible until QR
  operational friction is reduced.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:8` states the channel is production-ready via WhatsApp Web/Baileys and that Gateway owns linked sessions.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:63` documents QR login, account-specific login, custom `authDir`, pairing approval, and QR-only warnings.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:165` documents Gateway-owned sockets, reconnect loops, active listeners, and DM/group session rules.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:557` documents account selection, credential paths, and logout semantics.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-channels.md:134` documents multi-account config, default account, legacy auth migration, and per-account overrides.
- `/Users/kevinlin/code/openclaw/docs/concepts/qa-e2e-automation.md:694` documents WhatsApp QA scenarios and credential-pool behavior.

### Source

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/session.ts:129` creates the Baileys socket with multi-file auth, queued credential saves, QR callback, and 401 warning.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/login.ts:13` resolves account/auth directory, restores backup, waits for connection, and handles relink errors.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/login-qr.ts:58` maintains active QR-login TTL and per-account active login state.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auth-store.ts:69` restores backups and reports linked, not-linked, or unstable auth states.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auth-store.ts:204` clears Baileys auth files and handles logout cleanup.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/accounts.ts:21` resolves account config, auth directory selection, and legacy auth handling.
- `/Users/kevinlin/code/openclaw/src/pairing/pairing-store.ts:35` defines one-hour pending requests, per-account scope, and allow-store persistence.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/whatsapp/whatsapp-live.runtime.ts:222` defines live `whatsapp-pairing-block`.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/whatsapp/whatsapp-live.runtime.test.ts:154` verifies canary, pairing-block, and mention-gating standard scenario registration.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply.web-auto-reply.connection-and-logging.e2e.test.ts:402` covers stale auth/listener cleanup after terminal statuses.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/login.coverage.test.ts:119` covers 515 restart, QR output, logged-out cleanup, and generic login errors.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/login-qr.test.ts:104` covers QR restart, logout, unstable auth, recovered sessions, and QR rotation.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auth-store.test.ts:78` covers backup restore, large creds, symlink safety, and unstable auth.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/access-control.test.ts:85` covers pairing grace, account-level `dmPolicy`, and persisted pairing behavior.
- `/Users/kevinlin/code/openclaw/src/pairing/pairing-store.test.ts:301` covers lifecycle, limits, account-scoped allow-store, and pending requests.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "whatsapp qr login pairing session auth" --json`

Results:

- Surfaced #85866 phone-code login work, #85867 QR-unavailable/headless login fallback need, #85868 pairing stuck at Logging in until Gateway restart finalizes 515 recovery, and #75153 channel restart control request.

Query:

`gitcrawl search openclaw/openclaw --query "WhatsApp credentials leak across profile boundaries" --json`

Results:

- Surfaced open #64555 credential leakage across profile boundaries.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl --json search "whatsapp qr login pairing session auth" --limit 5`

Results:

- Returned #51111 QR login linked briefly then disconnected with 401/device_removed, a thread where QR succeeds but listener never starts with corrupt creds restored and repeated 515/logout, Railway deployment QR linking trouble, and old setup chatter.

Query:

`/Users/kevinlin/.local/bin/discrawl --json search "WhatsApp pairing code auth" --limit 5`

Results:

- Returned account `dmPolicy` fix discussion, pairing-code spam fix discussion, and multi-account pairing support guidance.
