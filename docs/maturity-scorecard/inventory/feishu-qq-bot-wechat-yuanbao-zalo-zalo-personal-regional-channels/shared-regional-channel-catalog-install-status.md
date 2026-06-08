---
title: "Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels - Channel Setup and Operations Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels - Channel Setup and Operations Maturity Note

## Summary

The shared catalog/install/status layer is the cross-cutting component that makes regional channels discoverable and operable. It covers docs navigation, channel picker entries, official external catalog records, aliases, install plans, trusted official install markers, missing-plugin repair hints, plugin validation, channel status/list output, and wizard localization. This shared layer is better covered than several individual external runtimes, but recent archive evidence shows install/list/status confusion, undefined picker/status rows, optional-channel startup failures, and external-channel trust-path churn.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Channel Setup and Operations`
- Merged from: `Catalog and Setup`, `Bot Channels`, `Personal Account Channels`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Docs channel index: Docs channel index, plugin reference pages, redirects, and pairing support list for regional channels
- Official external channel catalog entries: Official external channel catalog entries for WeCom, Yuanbao, Weixin, and adjacent external channels
- Core channel-plugin catalog: Core channel-plugin catalog, alias normalization, install-plan resolution, trusted-source flags, repair hints, and status/list output
- Channel setup wizard: Channel setup wizard and i18n blurbs for regional channels
- Missing-plugin: Missing-plugin, stale-plugin, raw package-manager upgrade, and doctor/repair paths
- Cross-channel ingress/access/refactor concerns: Cross-channel ingress/access/refactor concerns for regional plugins
- Feishu/Lark bot channel setup: Feishu/Lark bot channel setup through manual App ID/App Secret or QR app registration
- WebSocket default mode: WebSocket default mode and optional webhook mode
- DM pairing: DM pairing, allowlists, group policy, mention gates, per-group overrides, and sender restrictions
- Message delivery: Message delivery, replies, streaming cards, reactions, comments, bot menus, and card actions
- Feishu document: Feishu document, wiki, drive, bitable, and dynamic-agent tools
- Multi-account credential handling: Multi-account credential handling and troubleshooting for regional Feishu/Lark deployments
- QQ Open Platform AppID/AppSecret setup: QQ Open Platform AppID/AppSecret setup and default-account env/config handling
- C2C private chat: C2C private chat, group messages, guild channel messages, and target parsing
- Group activation: Group activation, mention gates, group history, tool policies, and sender allowlists
- Rich media messages: Inbound and outbound rich media including images, voice, video, files, STT/TTS, and native voice sends
- Slash commands: Slash commands, approval buttons, reminder/channel tools, and framework command registration
- Multi-account gateway connections: Multi-account gateway connections, token cache, credential backups, diagnostics, and reconnect behavior
- Tencent Yuanbao external channel: Tencent Yuanbao external channel openclaw-plugin-yuanbao
- AppKey/AppSecret setup: AppKey/AppSecret setup, login wizard, multi-account config, and default account routing
- DMs: DMs, groups, mention requirements, reply-to mode, group history context, slash-command menus, and fallback replies
- Outbound queue strategy: Outbound queue strategy, merge-text tuning, max chars, media caps, overflow behavior, and block-level streaming
- Core-side official external catalog: Core-side official external catalog, install metadata, aliases, wizard blurbs, and channel catalog contracts
- Zalo Bot Creator / Marketplace bot: Zalo Bot Creator / Marketplace bot DM channel
- Long-polling default mode: Long-polling default mode and optional HTTPS webhook mode
- Bot token: Bot token, token-file, multi-account, DM pairing, and allowlist behavior
- Group policy schema: Group policy schema and fail-closed group gates even where Marketplace groups are not usable
- Text: Text, media placeholders, outbound chunking, replay dedupe, rate limiting, webhook secrets, and proxy support
- Status probes: Status probes and troubleshooting for token/config/webhook problems
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
- QQ Open Platform AppID/AppSecret setup and: Covers QQ Open Platform AppID/AppSecret setup and default-account env/config handling behavior.
- C2C private chat: Covers C2C private chat, group messages, guild channel messages, and target parsing behavior.
- Group activation: Covers Group activation, mention gates, group history, tool policies, and sender allowlists behavior.
- Inbound and outbound rich media including: Covers Inbound and outbound rich media including images, voice, video, files, STT/TTS, and native voice sends behavior.
- Slash commands: Covers Slash commands, approval buttons, reminder/channel tools, and framework command registration behavior.
- Multi-account gateway connections: Covers Multi-account gateway connections, token cache, credential backups, diagnostics, and reconnect behavior behavior.
- Tencent Yuanbao external channel `openclaw-plugin-yuanbao`: Evidence scope for Tencent Yuanbao external channel `openclaw-plugin-yuanbao`.
- AppKey/AppSecret setup: Covers AppKey/AppSecret setup, login wizard, multi-account config, and default account routing behavior.
- DMs: Covers DMs, groups, mention requirements, reply-to mode, group history context, slash-command menus, and fallback replies behavior.
- Outbound queue strategy: Covers Outbound queue strategy, merge-text tuning, max chars, media caps, overflow behavior, and block-level streaming behavior.
- Core-side official external catalog: Covers Core-side official external catalog, install metadata, aliases, wizard blurbs, and channel catalog contracts behavior.
- Zalo Bot Creator / Marketplace bot: Covers Zalo Bot Creator / Marketplace bot DM channel behavior.
- Long-polling default mode and optional HTTPS: Covers Long-polling default mode and optional HTTPS webhook mode behavior.
- Bot token: Covers Bot token, token-file, multi-account, DM pairing, and allowlist behavior behavior.
- Group policy schema and fail-closed group: Covers Group policy schema and fail-closed group gates even where Marketplace groups are not usable behavior.
- Text: Covers Text, media placeholders, outbound chunking, replay dedupe, rate limiting, webhook secrets, and proxy support behavior.
- Status probes and troubleshooting for token/config/webhook problems: Evidence scope for Status probes and troubleshooting for token/config/webhook problems.
- `zalouser` channel plugin for Zalo Personal: Covers `zalouser` channel plugin for Zalo Personal Account automation via native `zca-js` behavior.
- QR login: Covers QR login, saved profiles, multi-account/profile selection, and gateway-local runtime behavior.
- DM pairing: Covers DM pairing, group policy, group gating, directory peers, and sender/session routing behavior.
- Message send: Covers Message send, image/link/document media, reactions, status, friends/groups/me tools, and text style normalization behavior.
- Doctor/status checks for runtime availability and: Covers Doctor/status checks for runtime availability and profile/session health behavior.
- Explicit unofficial-account risk and operator safeguards: Evidence scope for Explicit unofficial-account risk and operator safeguards.

## Features

- Docs channel index: Docs channel index, plugin reference pages, redirects, and pairing support list for regional channels
- Official external channel catalog entries: Official external channel catalog entries for WeCom, Yuanbao, Weixin, and adjacent external channels
- Core channel-plugin catalog: Core channel-plugin catalog, alias normalization, install-plan resolution, trusted-source flags, repair hints, and status/list output
- Channel setup wizard: Channel setup wizard and i18n blurbs for regional channels
- Missing-plugin: Missing-plugin, stale-plugin, raw package-manager upgrade, and doctor/repair paths
- Cross-channel ingress/access/refactor concerns: Cross-channel ingress/access/refactor concerns for regional plugins

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: core tests cover official external catalog, install plan, plugin install CLI, channels list/status, config validation, repair hints, alias normalization, manifest registry, and channel catalog contracts.
- Negative signals: coverage is strongest for metadata/control-plane behavior, not for the external channel runtimes themselves.
- Integration gaps: no single regional-channel catalog scenario was found that installs every named channel/account type, checks status/list output, runs setup/login, sends one message, and verifies repair hints across bundled and external plugins.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the component. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: broad regional catalog searches found reports around configured official external channels missing plugins, catalog id/version drift, openclaw-weixin unsupported-channel behavior, Feishu status omissions, and plugin/channel bootstrap failures.
- Discrawl reports: `official external plugin catalog` returned maintainer review of trusted official install derivation, plugin release notes saying 25/25 release-managed official plugins were published, and cautions around broader trust-path tests; `regional channel` returned optional regional Feishu startup failure and regional/proxy comments.
- Good qualities: the catalog design separates bundled, official external, and third-party plugin paths; docs and repair hints generally tell operators how to install missing official plugins; trusted install state is derived from install records and catalog/package matching rather than a raw manifest assertion.
- Bad qualities: channel list/status output has shown undefined rows and duplicate regional entries, external package support is sensitive to Nix/raw package-manager paths, and optional regional channels have previously broken unrelated CLI startup.
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

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Docs channel index, Official external channel catalog entries, Core channel-plugin catalog, Channel setup wizard, Missing-plugin, Cross-channel ingress/access/refactor concerns.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add one catalog scenario that exercises install/list/status/setup/repair across Feishu, QQ Bot, WeChat, Yuanbao, Zalo, and Zalo Personal.
- Keep external catalog entries pinned with validated npm specs and docs paths, especially after upstream plugin releases.
- Continue hardening optional regional plugin loading so non-users of a regional channel cannot hit unrelated CLI startup failures.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/index.md` lists WeChat and Yuanbao among channels and identifies them as external plugins.
- `/Users/kevinlin/code/openclaw/docs/channels/pairing.md` lists supported channel ids including `feishu`, `openclaw-weixin`, `zalo`, and `zalouser`.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference/feishu.md`, `qqbot.md`, `zalo.md`, and `zalouser.md` provide plugin reference entries for regional bundled/official plugins.
- `/Users/kevinlin/code/openclaw/docs/plugins/architecture-internals.md` describes external channel catalog merging.

### Source

- `/Users/kevinlin/code/openclaw/scripts/lib/official-external-channel-catalog.json` contains official external channel records including Yuanbao and Weixin with ids, labels, aliases, docs paths, and npm specs.
- `/Users/kevinlin/code/openclaw/src/channels/plugins/catalog.ts`, `src/plugins/official-external-plugin-catalog.ts`, `src/cli/plugin-install-plan.ts`, `src/cli/plugins-install-command.ts`, `src/commands/channels/status-config-format.ts`, and `src/plugins/official-external-plugin-repair-hints.ts` implement catalog, install, status, and repair behavior.
- `/Users/kevinlin/code/openclaw/src/wizard/setup.official-plugins.ts` and wizard locale files expose setup picker and localized channel blurbs.
- `/Users/kevinlin/code/openclaw/src/config/config.plugin-validation.test.ts`, `src/plugins/manifest-registry.test.ts`, and `src/plugins/install-security-scan.runtime.ts` define validation and trust-path behavior for external/official plugins.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/cli/plugins-cli.install.test.ts`, `src/cli/plugin-install-plan.test.ts`, `src/commands/channels.list.test.ts`, `src/commands/channels.status.command-flow.test.ts`, `src/plugins/official-external-plugin-catalog.test.ts`, `src/plugins/official-external-plugin-repair-hints.test.ts`, `src/channels/plugins/contracts/channel-catalog.contract.test.ts`, `src/channels/plugins/contracts/test-helpers/channel-plugin-catalog-contract-suites.ts`, and `src/wizard/setup.official-plugins.test.ts` exercise shared control-plane flows.
- No single end-to-end scenario was found that installs and smoke-tests every named regional channel/account type.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/channels/registry.helpers.test.ts`, `src/channels/plugins/catalog.test.ts`, `src/config/config.plugin-validation.test.ts`, `src/plugins/channel-catalog-registry.test.ts`, `src/plugins/manifest-registry.test.ts`, `src/plugins/update.test.ts`, and `src/commands/doctor/shared/preview-warnings.test.ts` cover focused alias, catalog, validation, manifest, update, and doctor behavior.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "official external channel catalog missing plugin repair hints Feishu WhatsApp Yuanbao" --json --limit 6`
- `gitcrawl search openclaw/openclaw --query "regional channels Chinese memory navigation Feishu Zalo profile env vars" --json --limit 6`
- `gitcrawl search openclaw/openclaw --query "openclaw-weixin" --json --limit 8`
- `gitcrawl search openclaw/openclaw --query "Yuanbao" --json --limit 8`

Results:

- The broad external catalog queries returned open reports in adjacent component searches: Feishu status omissions, openclaw-weixin unsupported-channel/runtime registration issues, Yuanbao catalog precedent, and Zalo/Zalo Personal profile and media issues.
- The `openclaw-weixin` query returned several external-channel install/routing/message issues, and the `Yuanbao` query returned an official external catalog precedent PR.

### Discrawl queries

Query:

- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 8 "official external plugin catalog"`
- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 8 "regional channel"`

Results:

- The official external plugin catalog query returned 2026-05-18 maintainer discussion that `trustedOfficialInstall` is derived from install records plus official external catalog/package matching, not manifest self-assertion; it also returned release notes saying 25/25 release-managed official plugins were published.
- The regional channel query returned issue `#69959` about an optional Feishu/Lark dependency breaking non-Lark CLI startup, comments about whether WhatsApp should be optional/regional, and proxy/regional-support review comments.
