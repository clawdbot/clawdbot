---
title: "Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels - Personal Account Channels Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels - Personal Account Channels Maturity Note

## Summary

WeChat support is intentionally externalized through Tencent's `@tencent-weixin/openclaw-weixin` package. OpenClaw core provides docs, catalog metadata, plugin install/status handling, channel-id aliases, pairing docs, and generic plugin runtime contracts, but the WeChat-specific runtime is not present in the source repo. Coverage is therefore low for this audit: the source proves integration hooks and install metadata, not QR login, Tencent iLink behavior, monitor/runtime internals, or real WeChat delivery. Quality is limited by archive evidence of version drift, runtime init issues, registration failures, lost replies, media/session bugs, Nix install friction, and upstream-account constraints.

## Category Scope

Included in this category:

- WeChat/Weixin personal messaging: WeChat/Weixin personal messaging through external package @tencent-weixin/openclaw-weixin
- Plugin install: Plugin install, enablement, compatibility, QR login, saved account tokens, and channel id openclaw-weixin
- Direct-message pairing: Direct-message pairing and per-account session isolation
- Core-side catalog metadata: Core-side catalog metadata, aliases, install plans, plugin trust markers, status/repair hints, docs redirects, and channel discovery
- External sidecar/helper process behavior: External sidecar/helper process behavior and stale process cleanup protections
- zalouser channel plugin: zalouser channel plugin for Zalo Personal Account automation via native zca-js
- QR login: QR login, saved profiles, multi-account/profile selection, and gateway-local runtime
- DM pairing: DM pairing, group policy, group gating, directory peers, and sender/session routing
- Message send: Message send, image/link/document media, reactions, status, friends/groups/me tools, and text style normalization
- Doctor/status checks for runtime availability: Doctor/status checks for runtime availability and profile/session health
- Explicit unofficial-account risk: Explicit unofficial-account risk and operator safeguards

## Features

- WeChat/Weixin personal messaging: WeChat/Weixin personal messaging through external package @tencent-weixin/openclaw-weixin
- Plugin install: Plugin install, enablement, compatibility, QR login, saved account tokens, and channel id openclaw-weixin
- Direct-message pairing: Direct-message pairing and per-account session isolation
- Core-side catalog metadata: Core-side catalog metadata, aliases, install plans, plugin trust markers, status/repair hints, docs redirects, and channel discovery
- External sidecar/helper process behavior: External sidecar/helper process behavior and stale process cleanup protections
- zalouser channel plugin: zalouser channel plugin for Zalo Personal Account automation via native zca-js
- QR login: QR login, saved profiles, multi-account/profile selection, and gateway-local runtime
- DM pairing: DM pairing, group policy, group gating, directory peers, and sender/session routing
- Message send: Message send, image/link/document media, reactions, status, friends/groups/me tools, and text style normalization
- Doctor/status checks for runtime availability: Doctor/status checks for runtime availability and profile/session health
- Explicit unofficial-account risk: Explicit unofficial-account risk and operator safeguards

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (42%)`
- Positive signals: docs and source prove the official external catalog, channel aliases, plugin install/enable/status flows, pairing docs, version compatibility notes, and generic plugin runtime integration.
- Negative signals: WeChat-specific runtime source and tests are external to this repo; no current live QR-login or message-delivery scenario was found in the source repo.
- Integration gaps: this audit could not verify external package internals for Tencent iLink login, account monitor, media upload/download, token persistence, direct-message delivery, group handling, reconnect, or sidecar lifecycle beyond core hooks and archives.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the component. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Experimental (44%)`
- Gitcrawl reports: broad `openclaw-weixin` search returned open reports for QR login hanging, intermittently lost replies, runtime channel registration failure, unsupported channel in cron delivery, standalone media directives dropped, proactive send false success/missing chunks, wrong session type routing, and accountId leakage.
- Discrawl reports: `openclaw-weixin` search returned Nix plugin-install failure, undefined-channel login failure, beta catalog drift from `2.4.1` to `2.4.3`, maintainer caution around recent security issues, and user reports around runtime init issues.
- Good qualities: docs are explicit that WeChat-specific runtime is external, group chats are not advertised by current capability metadata, direct chats and media are supported by the external plugin, and core startup cleanup has generic protection against sidecar parent cleanup.
- Bad qualities: external runtime opacity, package version drift, install environment sensitivity, QR-login fragility, and multiple recent message/session delivery reports make public support risk high.
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

- Score: `Experimental (42%)`
- Surface instructions: evaluated against `references/completeness/feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for WeChat/Weixin personal messaging, Plugin install, Direct-message pairing, Core-side catalog metadata, External sidecar/helper process behavior, zalouser channel plugin, QR login, DM pairing, Message send, Doctor/status checks for runtime availability, Explicit unofficial-account risk.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add or link a current external-package scorecard for QR login, direct chat, media, account token persistence, reconnect, proactive sends, and session routing.
- Keep the core catalog pinned to a validated external package version and preserve upgrade/repair guidance when external package metadata drifts.
- Clarify Nix/non-npm plugin install support and failure modes for external channel packages.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/wechat.md` explains that WeChat code does not live in OpenClaw core and that OpenClaw provides the generic channel plugin contract while the external package owns QR login, Tencent iLink API calls, media upload/download, context tokens, and monitoring.
- `/Users/kevinlin/code/openclaw/docs/channels/wechat.md` documents package `@tencent-weixin/openclaw-weixin`, channel id `openclaw-weixin`, direct chats and media support, group chats not advertised, install commands, QR login, per-account session isolation, pairing commands, version compatibility, sidecar cleanup context, troubleshooting, and disable/repair commands.
- `/Users/kevinlin/code/openclaw/docs/channels/index.md` lists WeChat as Tencent iLink Bot plugin via QR login and private chats only.

### Source

- `/Users/kevinlin/code/openclaw/scripts/lib/official-external-channel-catalog.json` defines the `@tencent-weixin/openclaw-weixin` official external entry with plugin/channel ids, aliases `weixin`, `wechat`, and `微信`, docs path `/channels/wechat`, and npm spec `@tencent-weixin/openclaw-weixin@2.4.3`.
- `/Users/kevinlin/code/openclaw/src/channels/registry.helpers.test.ts` validates `openclaw-weixin` registration aliases and normalization.
- `/Users/kevinlin/code/openclaw/src/commands/channel-setup/channel-plugin-resolution.test.ts`, `src/cli/directory-cli.test.ts`, `src/config/channel-configured.test.ts`, `src/commands/doctor/shared/preview-warnings.test.ts`, and `src/commands/doctor/shared/stale-plugin-config.test.ts` cover core-side resolution, config, directory, and doctor interactions.
- `/Users/kevinlin/code/openclaw/src/infra/restart-stale-pids.test.ts` includes regression context for an `openclaw-weixin` sidecar child process trying to clean up the parent gateway.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/cli/plugins-cli.install.test.ts`, `src/cli/plugin-install-plan.test.ts`, `src/plugins/official-external-plugin-catalog.test.ts`, `src/channels/plugins/catalog.test.ts`, and `src/channels/plugins/contracts/channel-catalog.contract.test.ts` exercise official external plugin catalog, install, and trusted install behavior that WeChat relies on.
- No current in-repo live WeChat QR-login or message-delivery scenario was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/channels/registry.helpers.test.ts`, `src/plugins/channel-catalog-registry.test.ts`, `src/config/config.plugin-validation.test.ts`, `src/commands/channels.list.test.ts`, and `src/commands/channels.status.command-flow.test.ts` cover focused alias, catalog, validation, list, and status behavior for external channels including `openclaw-weixin`.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "openclaw-weixin QR login sidecar compiled runtime output version too old" --json --limit 6`
- `gitcrawl search openclaw/openclaw --query "openclaw-weixin" --json --limit 8`

Results:

- The feature-specific query was represented by the broad query because exact phrase matching returned no additional focused hits.
- The broad query returned open hits including `#62120` QR login hangs before QR code appears, `#86877` intermittently lost assistant replies, `#86314` channel not registered in gateway runtime on WSL2, `#78754` cron unsupported channel, `#78697` standalone media directive drop, `#79293` proactive send false success/missing chunks, `#81723` wrong WeChat session type, and `#69525` accountId leakage.

### Discrawl queries

Query:

- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 8 "openclaw-weixin"`

Results:

- Returned 2026-05-17 Nix/openclaw-weixin install and undefined-channel login failure discussion, 2026-05-14 catalog drift discussion around `@tencent-weixin/openclaw-weixin@2.4.1` versus `2.4.3`, and maintainer comments that security concerns make these external packages sensitive.
