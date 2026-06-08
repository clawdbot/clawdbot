---
title: "Security, auth, pairing, and secrets - Channel Access Control Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Security, auth, pairing, and secrets - Channel Access Control Maturity Note

## Summary

OpenClaw has a broad shared policy model for inbound channel trust: DM pairing, DM allowlists, group allowlists, access groups, mention gating, owner bootstrap, and channel-specific sender normalization. Coverage is Beta because many bundled channels have focused policy tests, but parity is uneven and not all channels share one end-to-end ingress contract yet. Quality is Alpha because Discord evidence shows frequent operator confusion around DM pairing versus group authorization, account-level overrides, Slack/WhatsApp/Telegram allowlists, and insecure group-command exposure warnings.

## Category Scope

Included in this category:

- Channel Identity: Covers Channel Identity across who can talk to OpenClaw through message channels: DM pairing codes, pairing stores, `dmPolicy`, `allowFrom`, and related channel identity, allowlists, and sender pairing behavior.
- Allowlists: Covers Allowlists across who can talk to OpenClaw through message channels: DM pairing codes, pairing stores, `dmPolicy`, `allowFrom`, and related channel identity, allowlists, and sender pairing behavior.
- Sender Pairing: Covers Sender Pairing across who can talk to OpenClaw through message channels: DM pairing codes, pairing stores, `dmPolicy`, `allowFrom`, and related channel identity, allowlists, and sender pairing behavior.

## Features

- Channel Identity: Covers Channel Identity across who can talk to OpenClaw through message channels: DM pairing codes, pairing stores, `dmPolicy`, `allowFrom`, and related channel identity, allowlists, and sender pairing behavior.
- Allowlists: Covers Allowlists across who can talk to OpenClaw through message channels: DM pairing codes, pairing stores, `dmPolicy`, `allowFrom`, and related channel identity, allowlists, and sender pairing behavior.
- Sender Pairing: Covers Sender Pairing across who can talk to OpenClaw through message channels: DM pairing codes, pairing stores, `dmPolicy`, `allowFrom`, and related channel identity, allowlists, and sender pairing behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Public channel docs consistently document DM pairing and allowlist controls, and many channel plugins have policy tests for sender matching, group policy, mention gating, approval auth, and native command authorization.
- Negative signals: The evidence is distributed across per-channel test suites. A single shared ingress authorization algebra is still described as a refactor plan, which makes parity harder to prove across long-tail channels.
- Integration gaps: Add a cross-channel conformance suite for DM pairing, first-owner bootstrap, account-scoped allowlists, group sender auth, mention gating, native commands, and approval-auth side effects.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports: The exact issue query returned open issue #81876 about automatically flipping channel DM defaults to owner allowlists after first-owner bootstrap. The PR query returned open PR #84461 for Telegram per-sender inbound rate limiting.
- Discrawl reports: Discord support history shows recurring misconfiguration and confusion: group commands without sender allowlists, Slack group policy blocking mentions, WhatsApp account-level `dmPolicy` overrides, BlueBubbles group/DM binding confusion, and users pasting configs with plaintext channel tokens while debugging access.
- Good qualities: The docs explicitly distinguish DM pairing from group authorization; access groups are reusable; many channels default groups to allowlist; and the security audit catches high-impact group-command exposure.
- Bad qualities: Channel variance remains high, user-facing diagnostics often require deep config interpretation, and pairing approval can be mistaken for broader group or command authorization.
- Excluded from quality: Coverage breadth, unit-test breadth, and integration-test depth are scored only under Coverage.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/security-auth-pairing-and-secrets.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Channel Identity, Allowlists, Sender Pairing.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Shared ingress policy is still being refactored from per-plugin decision trees toward one core access graph.
- DM pairing approval does not automatically solve group access, but this distinction remains a frequent support issue.
- Some channel docs and runtime warnings use channel-specific terminology, so operators still need per-channel knowledge to repair access.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/pairing.md` documents DM pairing, pairing-code expiry, pending caps, first-owner bootstrap, supported channels, access groups, pairing-store paths, and the DM-versus-group boundary.
- `/Users/kevinlin/code/openclaw/docs/channels/telegram.md`, `/Users/kevinlin/code/openclaw/docs/channels/discord.md`, `/Users/kevinlin/code/openclaw/docs/channels/slack.md`, and `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md` document representative channel-specific DM, group, allowlist, and approval behavior.
- `/Users/kevinlin/code/openclaw/docs/channels/access-groups.md` documents reusable sender groups.
- `/Users/kevinlin/code/openclaw/docs/gateway/security/audit-checks.md` documents `security.exposure.open_channels_with_exec`, open group, and sender allowlist audit checks.

### Source

- `/Users/kevinlin/code/openclaw/src/channels/direct-dm-access.ts` resolves inbound DM access and pairing decisions.
- `/Users/kevinlin/code/openclaw/src/channels/allow-from.ts`, `/Users/kevinlin/code/openclaw/src/channels/allowlist-match.ts`, and `/Users/kevinlin/code/openclaw/src/channels/mention-gating.ts` implement shared sender matching and mention gates.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/group-access.ts` and `/Users/kevinlin/code/openclaw/src/plugin-sdk/access-groups.ts` provide reusable plugin-facing access helpers.
- Representative bundled channel implementations live under `/Users/kevinlin/code/openclaw/extensions/telegram`, `/Users/kevinlin/code/openclaw/extensions/discord`, `/Users/kevinlin/code/openclaw/extensions/slack`, `/Users/kevinlin/code/openclaw/extensions/whatsapp`, and `/Users/kevinlin/code/openclaw/extensions/matrix`.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/group-access.base-access.test.ts` and `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-native-commands.group-auth.test.ts` cover Telegram group and native-command authorization.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/channel-access.test.ts` covers Discord channel access behavior.
- `/Users/kevinlin/code/openclaw/extensions/slack/src/group-policy.test.ts` and `/Users/kevinlin/code/openclaw/extensions/slack/src/monitor/provider.allowlist.test.ts` cover Slack group policy and provider allowlists.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/access-control.test.ts` and `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/group-policy.test.ts` cover WhatsApp inbound access and group policy.
- `/Users/kevinlin/code/openclaw/extensions/zalo/src/monitor.pairing.lifecycle.test.ts` covers channel pairing lifecycle for Zalo.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/channels/allowlist-match.test.ts`, `/Users/kevinlin/code/openclaw/src/channels/allow-from.test.ts`, and `/Users/kevinlin/code/openclaw/src/channels/mention-gating.test.ts` cover shared policy helpers.
- `/Users/kevinlin/code/openclaw/src/channels/plugins/pairing-adapters.test.ts` covers plugin pairing adapter behavior.
- `/Users/kevinlin/code/openclaw/extensions/*/src/approval-auth.test.ts` files cover per-channel approval authorization.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/resolve-allowlist-common.test.ts` and `/Users/kevinlin/code/openclaw/extensions/slack/src/resolve-allowlist-common.test.ts` cover allowlist normalization.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "channel pairing dmPolicy allowlist groupPolicy ownerAllowFrom"`

Results:

- Returned open issue #81876, `Auto-flip channel DM defaults to allowlist:[owner] after first-owner bootstrap`.

Query: `gitcrawl --json search prs -R openclaw/openclaw "channel pairing dmPolicy ownerAllowFrom allowlist"`

Results:

- Returned open PR #84461, `feat(channels/telegram): per-sender inbound rate limit`.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "channel pairing dmPolicy allowlist groupPolicy ownerAllowFrom"`

Results:

- Returned a support config where Telegram had `dmPolicy="pairing"`, owner allowlists, exec approval targets, and gateway token config; useful as operator evidence but not a direct defect.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "dmPolicy pairing allowlist groupPolicy"`

Results:

- Found maintainer design notes for a channel ingress refactor.
- Found support cases explaining Slack group-policy allowlists, WhatsApp account-level policy overrides, BlueBubbles group/DM routing, Telegram owner bootstrap, and security-audit findings for Telegram group commands with no sender allowlist.
