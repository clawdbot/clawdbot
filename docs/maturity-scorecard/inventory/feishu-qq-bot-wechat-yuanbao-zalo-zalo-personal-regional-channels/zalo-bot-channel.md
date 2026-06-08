---
title: "Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels - Zalo Bot Channel Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels - Zalo Bot Channel Maturity Note

## Summary

The Zalo bot channel is documented as experimental and the docs are candid about Marketplace-bot limits: DMs work, group support is not available for current Marketplace bots, media behavior is limited, link previews and non-text media are unreliable, and streaming is blocked by the 2000-character API limit. Source and tests cover polling, webhooks, replay protection, pairing, group policy gates, media payload handling, account config, status issues, and outbound sends. The score stays Alpha because runtime support is useful but scoped, and live public proof is weaker than the source/test surface.

## Category Scope

- Zalo Bot Creator / Marketplace bot DM channel.
- Long-polling default mode and optional HTTPS webhook mode.
- Bot token, token-file, multi-account, DM pairing, and allowlist behavior.
- Group policy schema and fail-closed group gates even where Marketplace groups are not usable.
- Text, media placeholders, outbound chunking, replay dedupe, rate limiting, webhook secrets, and proxy support.
- Status probes and troubleshooting for token/config/webhook problems.

## Features

- Zalo Bot Creator / Marketplace bot: Zalo Bot Creator / Marketplace bot DM channel
- Long-polling default mode: Long-polling default mode and optional HTTPS webhook mode
- Bot token: Bot token, token-file, multi-account, DM pairing, and allowlist behavior
- Group policy schema: Group policy schema and fail-closed group gates even where Marketplace groups are not usable
- Text: Text, media placeholders, outbound chunking, replay dedupe, rate limiting, webhook secrets, and proxy support
- Status probes: Status probes and troubleshooting for token/config/webhook problems

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (60%)`
- Positive signals: extension tests cover polling, webhook, durable handling, pairing, group policy, media reply, outbound payload contracts, setup, status, tokens, accounts, and approval authorization.
- Negative signals: docs say current Marketplace-bot behavior is DM-oriented, groups are unavailable in practice, media and link-preview behavior are limited, and no current live Zalo Marketplace/OA scenario was found.
- Integration gaps: live proof is missing for Marketplace-bot token setup, webhook registration, sender pairing, media behavior, replay/rate-limit handling, and any alternate Zalo product surface such as Official Account behavior.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the component. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Alpha (56%)`
- Gitcrawl reports: broad `Zalo` search returned open hits for non-numeric chat IDs, Zalo media max defaults, response.ok parsing, delivery error visibility, and several adjacent zalouser items; specific replay/query searches returned no hits.
- Discrawl reports: Zalo search returned archive discussion about secret-file symlink fail-closed behavior, channel-ingress refactor context listing Zalo among duplicated policy trees, stale security report closure, and recent Zalo monitor performance commits.
- Good qualities: the docs state limits directly and avoid overpromising group/media support; source includes webhook secret checks, HTTPS requirement, replay dedupe, rate limiting, token-file symlink rejection, DM pairing defaults, and status issue reporting.
- Bad qualities: the product surface is fragmented between Marketplace bots and other Zalo products, the group config exists without practical Marketplace group support, and media/link preview behavior remains explicitly uncertain.
- Excluded from quality: unit, integration, e2e, live, and real runtime-flow test presence or absence; these are Coverage inputs only.

Quality labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage as a scoring input.

## Completeness Score

- Score: `Alpha (60%)`
- Surface instructions: evaluated against `references/completeness/feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Zalo Bot Creator / Marketplace bot, Long-polling default mode, Bot token, Group policy schema, Text, Status probes.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add live Zalo Marketplace-bot scenario proof for token setup, DM pairing, polling, webhook, outbound sends, media, and retry/replay behavior.
- Split or document any Zalo Official Account behavior separately from Marketplace-bot behavior.
- Keep media/link-preview and group-behavior docs aligned with upstream Zalo product changes.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/zalo.md` labels Zalo experimental, documents bundled plugin status, token/env/config setup, DM pairing, long-polling default, webhook mode, 2000-character text chunking, 5 MB media cap, streaming block, group schema limits, and the Marketplace-bot capabilities table.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference/zalo.md` identifies package `@openclaw/zalo`, install route `npm; ClawHub`, and surface `channels: zalo`.

### Source

- `/Users/kevinlin/code/openclaw/extensions/zalo/src/channel.ts`, `channel.runtime.ts`, `runtime.ts`, `monitor.ts`, `monitor.webhook.ts`, and `monitor-durable.ts` implement channel registration, runtime, polling/webhook monitor, and durable receive behavior.
- `/Users/kevinlin/code/openclaw/extensions/zalo/src/token.ts`, `accounts.ts`, `config-schema.ts`, `secret-input.ts`, `secret-contract.ts`, `setup-core.ts`, `setup-surface.ts`, and `status-issues.ts` implement credential/config/setup/status paths.
- `/Users/kevinlin/code/openclaw/extensions/zalo/src/group-access.ts`, `setup-allow-from.ts`, `approval-auth.ts`, `session-route.ts`, `send.ts`, `outbound-media.ts`, `api.ts`, `proxy.ts`, and `actions.ts` implement access, pairing, routing, sends, media, API, proxy, and actions.

### Integration tests

- `/Users/kevinlin/code/openclaw/test/vitest/vitest.extension-zalo.config.ts` defines the dedicated Zalo test project.
- `/Users/kevinlin/code/openclaw/extensions/zalo/src/monitor.lifecycle.test.ts`, `monitor.reply-once.lifecycle.test.ts`, `monitor.pairing.lifecycle.test.ts`, `monitor.webhook.test.ts`, `monitor-durable.test.ts`, `monitor.image.polling.test.ts`, `monitor.polling.media-reply.test.ts`, `channel.runtime.ts`, `channel.startup.test.ts`, and `outbound-payload.contract.test.ts` cover channel-flow behavior.
- No current live Zalo Marketplace or OA platform scenario was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/zalo/src/api.test.ts`, `token.test.ts`, `accounts.test.ts`, `config-schema.test.ts`, `setup-surface.test.ts`, `send.test.ts`, `outbound-media.test.ts`, `group-policy.test.ts`, `setup-status.test.ts`, `status-issues.test.ts`, and `approval-auth.test.ts` cover focused API, credential, config, setup, send, policy, status, and auth behavior.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Zalo webhook replay dedupe account path target scope marketplace bot" --json --limit 6`
- `gitcrawl search openclaw/openclaw --query "Zalo" --json --limit 8`

Results:

- The feature-specific query returned no hits.
- The broad Zalo query returned open hits including `#57594` proactive outbound non-numeric chat IDs, `#57608` Zalo media max default, `#62740` response.ok handling, and adjacent Zalo Personal items such as delivery error surfacing and quote metadata.

### Discrawl queries

Query:

- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 6 "Zalo Marketplace bot group media webhook"`
- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 8 "Zalo"`

Results:

- The feature-specific query returned no results.
- The broad Zalo query returned maintainer discussion around Zalo/other channel credential symlink rejection, a channel-ingress refactor note listing Zalo among plugins with duplicated upstream policy logic, stale closure of an older Nostr/Zalo credential exposure report, and commits for speeding Zalo polling and narrowing monitor imports.
