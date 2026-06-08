---
title: "Voice Call channel - Access and Identity Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice Call channel - Access and Identity Maturity Note

## Summary

This note migrates archived maturity evidence for `Voice Call channel` / `Webhook Exposure and Security` into the current process-version-3 scorecard inventory.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Access and Identity`
- Merged from: `Webhook Security`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Voice Call Channel: Webhook Exposure and Security

## Features

- Voice Call Channel: Webhook Exposure and Security

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (60%)`

Webhook exposure and security have broad implementation evidence: public URL validation, tunnel/Tailscale serving, trusted proxy handling, signature verification, replay protection, body limits, request deadlines, in-flight caps, strict paths, and WebSocket upgrade gates. Coverage is Alpha rather than Beta because evidence is still mostly local/integration-level and archive state shows active proxy/path edge fixes.

## Quality Score

- Score: `Alpha (62%)`

Quality is based on fail-closed security posture, proxy/header constraints, replay design, and active defect state. Test existence and test breadth were not counted in this Quality score.

This is one of the stronger components because it rejects unauthenticated traffic before expensive body parsing, constrains forwarded hosts/proxies, and requires public URLs for external providers. It remains Alpha because public exposure is operationally fragile and there are active webhook/proxy edge issues.

## Completeness Score

- Score: `Alpha (60%)`
- Surface instructions: evaluated against `references/completeness/voice-call-channel.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Voice Call Channel.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Proxy and stream-path fixes are active enough to keep this below Beta.
- Public exposure depends on operator infrastructure and cannot be inferred from unit/local checks.
- No live replay/signature/public URL scenario matrix was found for all three external providers.

## Evidence

### Docs

- `docs/plugins/voice-call.md:83-88` requires a public webhook URL for Twilio, Telnyx, and Plivo and says loopback/private hosts are rejected for external providers.
- `docs/plugins/voice-call.md:170-204` documents provider exposure/security notes, streaming connection caps, and doctor migration behavior.
- `docs/plugins/voice-call.md:683-704` documents webhook security, allowed hosts, trusted proxy IPs, forwarding headers, replay protection for Twilio/Plivo, per-turn tokens, unauthenticated rejection before body parsing, 64 KB/5 second request limits, and per-IP in-flight caps.
- `docs/cli/voicecall.md:178-199` documents Tailscale serve/funnel exposure commands.

### Source

- `extensions/voice-call/src/runtime.ts:263-528` resolves public URL/tunnel/Tailscale selection and fails external providers if only local/private webhook exposure is available.
- `extensions/voice-call/src/webhook-security.ts:240-345` reconstructs public URLs from trusted proxy headers, allowed hosts, and trusted proxy IPs.
- `extensions/voice-call/src/webhook-security.ts:482-547` implements Telnyx signature verification with timestamp/replay handling.
- `extensions/voice-call/src/webhook-security.ts:552-683` implements Twilio signature verification, public URL/forwarded variants, replay handling, and dev skip behavior.
- `extensions/voice-call/src/webhook-security.ts:854-980` implements Plivo V3/V2 verification and replay handling.
- `extensions/voice-call/src/webhook.ts:657-810` applies path/method gates, pre-auth headers, body/in-flight limits, provider verification, replay checks, realtime allowlists, and parse/process/cache behavior.

### Integration tests

- `extensions/voice-call/src/webhook.test.ts:348-460` covers media stream client IP trust behavior.
- `extensions/voice-call/src/webhook.test.ts:620-650` rejects prefix-lookalike webhook paths.
- `extensions/voice-call/src/webhook.test.ts:703-800` covers replay behavior and Plivo replay side effects.
- `extensions/voice-call/src/webhook.test.ts:972-1031` prevents replayed realtime Twilio webhooks from minting stream state.
- `extensions/voice-call/src/webhook.test.ts:1098-1200` covers realtime allowlist rejection and accepted stream paths.
- `extensions/voice-call/src/webhook.test.ts:1276-1394` covers missing signature rejection, body size limits, and in-flight caps before auth.

### Unit tests

- `extensions/voice-call/src/webhook-security.test.ts:286-500` covers replay detection and Plivo V2/V3 verification behavior.
- `extensions/voice-call/src/webhook-security.test.ts:502-628` covers Telnyx replay, Twilio query handling, idempotency, invalid forwarded host rejection, and ngrok compatibility.
- `extensions/voice-call/src/config.test.ts:32-279` covers provider credential/env validation that gates webhook runtime startup.

### Gitcrawl queries

- `gitcrawl search issues "voice-call" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned #79918 for realtime WebSocket upgrades accepting sibling stream paths and #86525 for trusted proxies reported as IPv4-mapped addresses.
- `gitcrawl search prs "voice-call" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned #79919 for tightening realtime stream upgrade paths and #86527 for IPv4-mapped trusted proxy matching.
- `gitcrawl search issues "voicecall setup smoke webhook" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned no results for exact setup/smoke webhook terms.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "voice-call webhook guard public url"`: returned evidence that the webhook guard landed on main so Twilio/Telnyx/Plivo fail fast if public URL/tunnel/Tailscale resolution would fall back to loopback/private URLs.
- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "voice-call twilio telnyx plivo"`: returned repeated user-facing guidance that real carrier providers need a publicly reachable Gateway webhook.
- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "voice-call realtime twilio"`: returned review and PR discussion around outbound realtime TwiML interception, notify calls, and stream attachment behavior.

### Archived source snapshot

- `gitcrawl doctor --json`: `version=0.2.1`, `api_supported=false`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `github_token_present=false`, `openai_key_present=true`.
- `/Users/kevinlin/.local/bin/discrawl status --json`: `state=current`, `generated_at=2026-05-29T16:49:09Z`, `last_sync_at=2026-05-29T15:59:50Z`, `messages=1487061`, `channels=25819`, `threads=25591`, `embedding_backlog=0`, `share.needs_update=true`.
