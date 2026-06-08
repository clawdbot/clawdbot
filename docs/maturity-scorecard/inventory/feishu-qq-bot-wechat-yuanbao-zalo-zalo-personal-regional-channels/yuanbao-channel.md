---
title: "Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels - Yuanbao Channel Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels - Yuanbao Channel Maturity Note

## Summary

Yuanbao docs describe a production-ready external channel for bot DMs and group chats over WebSocket, with native slash-command menus, group history, block streaming, multi-account setup, and message delivery tuning. OpenClaw core contains the official external catalog entry and install/status/contract tests, but the Yuanbao runtime source is not in this repo. Coverage is therefore Experimental for this audit, even though the docs are much richer than the visible source. Quality is somewhat better than coverage because docs and catalog metadata are coherent, but archive evidence shows catalog-id/version coupling and external plugin loading/refactor risk.

## Category Scope

- Tencent Yuanbao external channel `openclaw-plugin-yuanbao`.
- AppKey/AppSecret setup, login wizard, multi-account config, and default account routing.
- DMs, groups, mention requirements, reply-to mode, group history context, slash-command menus, and fallback replies.
- Outbound queue strategy, merge-text tuning, max chars, media caps, overflow behavior, and block-level streaming.
- Core-side official external catalog, install metadata, aliases, wizard blurbs, and channel catalog contracts.

## Features

- Tencent Yuanbao external channel: Tencent Yuanbao external channel openclaw-plugin-yuanbao
- AppKey/AppSecret setup: AppKey/AppSecret setup, login wizard, multi-account config, and default account routing
- DMs: DMs, groups, mention requirements, reply-to mode, group history context, slash-command menus, and fallback replies
- Outbound queue strategy: Outbound queue strategy, merge-text tuning, max chars, media caps, overflow behavior, and block-level streaming
- Core-side official external catalog: Core-side official external catalog, install metadata, aliases, wizard blurbs, and channel catalog contracts

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (47%)`
- Positive signals: docs are detailed, and core tests prove official external catalog metadata, install spec, channel catalog contracts, config warnings, wizard blurbs, and repair/install plumbing.
- Negative signals: Yuanbao runtime source and runtime tests are external to this repo; no current live Yuanbao app scenario was found here.
- Integration gaps: no in-repo proof for Yuanbao WebSocket connect, app approval, DM/group delivery, native slash-command sync, block streaming, group history, fallback replies, media, or multi-account behavior against the actual platform.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the component. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Alpha (55%)`
- Gitcrawl reports: broad `Yuanbao` search returned catalog-related PR `#81736` using Yuanbao as an existing official external catalog precedent; archive/changelog source also shows version bumps and catalog-id fixes.
- Discrawl reports: `Yuanbao` search returned release/backport discussion around a Yuanbao catalog-id fix, Freshbits notes for Yuanbao plugin GitHub location/docs entrance, and maintainer comments about Yuanbao and WeCom pulling in Matrix/Mattermost code that needed decoupling.
- Good qualities: docs set clear install/config/operation expectations, list config keys and defaults, and identify message delivery controls; official external catalog pins npm spec `openclaw-plugin-yuanbao@2.13.1` and marks aliases including `元宝`.
- Bad qualities: runtime opacity, external catalog/version coupling, and archive evidence of catalog-id and dependency-coupling repairs mean support depends on upstream plugin and catalog hygiene.
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

- Score: `Experimental (47%)`
- Surface instructions: evaluated against `references/completeness/feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Tencent Yuanbao external channel, AppKey/AppSecret setup, DMs, Outbound queue strategy, Core-side official external catalog.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add or link a current Yuanbao runtime scorecard covering app approval, WebSocket connect, DMs, groups, native slash commands, block streaming, fallback replies, media, and multi-account behavior.
- Keep catalog npm spec, integrity, docs path, and channel id aligned with the external plugin release.
- Document external runtime ownership and support boundaries as clearly as the WeChat docs do.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/yuanbao.md` describes Tencent Yuanbao as an external WebSocket channel for DMs and group chats, with appKey/appSecret setup, login wizard, DM policy, group mentions, reply-to behavior, slash-command menus, fallback replies, multi-account setup, message limits, block streaming, group history, channel routing bindings, and full config reference.
- `/Users/kevinlin/code/openclaw/docs/channels/index.md` lists Yuanbao as Tencent Yuanbao bot external plugin.

### Source

- `/Users/kevinlin/code/openclaw/scripts/lib/official-external-channel-catalog.json` defines `openclaw-plugin-yuanbao`, channel id `yuanbao`, aliases `yuanbao`, `yb`, `tencent-yuanbao`, and `元宝`, tools `query_group_info`, `query_session_members`, and `yuanbao_remind`, and npm spec `openclaw-plugin-yuanbao@2.13.1`.
- `/Users/kevinlin/code/openclaw/src/wizard/i18n/locales/en.ts`, `zh-CN.ts`, and `zh-TW.ts` include Yuanbao setup blurbs.
- `/Users/kevinlin/code/openclaw/src/logging/subsystem.ts`, `src/config/config.plugin-validation.test.ts`, and `src/channels/plugins/catalog.ts` include core-side Yuanbao catalog/status behavior.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/plugins/official-external-plugin-catalog.test.ts`, `src/channels/plugins/contracts/channel-catalog.contract.test.ts`, `src/channels/plugins/contracts/test-helpers/channel-plugin-catalog-contract-suites.ts`, `src/channels/plugins/catalog.test.ts`, `src/cli/plugins-cli.install.test.ts`, and `src/commands/channels.status.command-flow.test.ts` exercise catalog, install, and status behavior used by Yuanbao.
- No current in-repo live Yuanbao platform scenario was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/config/config.plugin-validation.test.ts`, `src/channels/plugins/catalog.test.ts`, `src/plugins/official-external-plugin-catalog.test.ts`, and `src/channels/plugins/contracts/channel-catalog.contract.test.ts` cover focused Yuanbao catalog and validation behavior.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Yuanbao sourceReplyDeliveryMode group chat fallback reply block streaming" --json --limit 6`
- `gitcrawl search openclaw/openclaw --query "Yuanbao" --json --limit 8`

Results:

- The feature-specific query returned no hits.
- The broad Yuanbao query returned open PR `#81736` adding DingTalk to the official external channel catalog while citing existing WeCom, Yuanbao, and Weixin external entries.

### Discrawl queries

Query:

- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 8 "Yuanbao"`

Results:

- Returned release/backport discussion identifying Yuanbao catalog-id fix `#75003`/commit `099037c` as important if the beta included the broken catalog entry, Freshbits entries for Yuanbao plugin GitHub location and docs entrance, and maintainer discussion that Yuanbao and WeCom loading Matrix/Mattermost code needed decoupling.
