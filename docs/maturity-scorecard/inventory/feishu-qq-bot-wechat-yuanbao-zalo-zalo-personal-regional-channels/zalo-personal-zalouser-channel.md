---
title: "Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels - Zalo Personal / Zalouser Channel Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels - Zalo Personal / Zalouser Channel Maturity Note

## Summary

Zalo Personal is a distinct account type from the Zalo bot channel. It uses `zca-js` to automate a normal personal account and the docs warn that unofficial automation may lead to account suspension or ban. Source and tests cover QR/login profiles, account scoping, group gates, directory peers, sends, reactions, tools, status, doctor checks, and Zalo client adapters. The maturity ceiling is lower because the upstream integration is unofficial, live account proof is not captured in this audit, and archives show recent user-visible rough edges around startup, media, quote metadata, sender parsing, and profile docs.

## Category Scope

- `zalouser` channel plugin for Zalo Personal Account automation via native `zca-js`.
- QR login, saved profiles, multi-account/profile selection, and gateway-local runtime.
- DM pairing, group policy, group gating, directory peers, and sender/session routing.
- Message send, image/link/document media, reactions, status, friends/groups/me tools, and text style normalization.
- Doctor/status checks for runtime availability and profile/session health.
- Explicit unofficial-account risk and operator safeguards.

## Features

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

- Score: `Alpha (58%)`
- Positive signals: extension tests cover setup, QR/profile handling, account scoping, monitor behavior, group gates, directory peers, sends, reactions, status, doctor checks, tool behavior, message SID handling, and ZCA client adapters.
- Negative signals: no current live Zalo Personal account scenario was found that proves QR login, session persistence, account/profile switching, group routing, media, reactions, tools, and reconnect against the real Zalo client/service.
- Integration gaps: repeatable runtime proof is missing for account suspension/ban boundaries, QR re-login, profile recovery, document media, quote metadata, group invite links, and long-running monitor behavior.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the component. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Alpha (52%)`
- Gitcrawl reports: broad `zalouser` search returned open reports for start-account hang after re-login, inbound photo attachments, document media duplicate delivery, markdown rendering, quote metadata, and group invite link actions.
- Discrawl reports: `zalouser` and `Zalo Personal` searches returned install timing notes, profile-env docs PR `#69643`, review comments about sender-label parsing breaking `Zalo Personal`, a user quickstart showing Zalo Personal in the channel picker, and channel-status output with duplicate/undefined rows.
- Good qualities: docs clearly label the unofficial automation risk and separate `zalouser` from `zalo`; source exposes doctor/status, account/profile, group policy, directory, reactions, tools, and text normalization rather than hiding ZCA complexity.
- Bad qualities: unofficial upstream automation creates account-safety risk; archives show profile docs lag, sender-label parsing risk, startup hangs, media duplication, quote metadata loss, and real-client rendering gaps.
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

- Score: `Alpha (58%)`
- Surface instructions: evaluated against `references/completeness/feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for zalouser channel plugin, QR login, DM pairing, Message send, Doctor/status checks for runtime availability, Explicit unofficial-account risk.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a live Zalo Personal scenario for QR login, profile selection, DM pairing, group routing, sends, media, reactions, tools, reconnect, and re-login recovery.
- Document account-safety boundaries, profile env vars, multi-account profile selection, and recovery steps in one operator runbook.
- Close or document the recent start-account, document-media, quote-metadata, sender-label, and rendering issues.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/plugins/zalouser.md` documents Zalo Personal via `zca-js`, warns about unofficial automation and account suspension/ban risk, explains the `zalouser` channel id, gateway-local runtime, install options, channel config, CLI commands, and tool actions.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference/zalouser.md` identifies package `@openclaw/zalouser`, install route `npm; ClawHub`, and surface `channels: zalouser; contracts: tools`.

### Source

- `/Users/kevinlin/code/openclaw/extensions/zalouser/src/channel.ts`, `channel.runtime.ts`, `channel.setup.ts`, `runtime.ts`, `monitor.ts`, `zca-client.ts`, `zalo-js.ts`, `zca-constants.ts`, and `zca-js-exports.d.ts` implement channel runtime and ZCA integration.
- `/Users/kevinlin/code/openclaw/extensions/zalouser/src/accounts.ts`, `accounts.runtime.ts`, `qr-temp-file.ts`, `setup-core.ts`, `setup-surface.ts`, `config-schema.ts`, `status-issues.ts`, `doctor.ts`, and `doctor-contract.ts` implement accounts, profile/session setup, QR files, config, status, and doctor checks.
- `/Users/kevinlin/code/openclaw/extensions/zalouser/src/group-policy.ts`, `session-route.ts`, `send.ts`, `send-receipt.ts`, `reaction.ts`, `directory.ts`, `tool.ts`, `text-styles.ts`, and `message-sid.ts` implement routing, group policy, sends, reactions, directory, tools, rendering, and message identity.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/zalouser/src/channel.setup.test.ts`, `channel.sendpayload.test.ts`, `channel.directory.test.ts`, `monitor.account-scope.test.ts`, `monitor.group-gating.test.ts`, `tool.test.ts`, `reaction.test.ts`, `doctor.test.ts`, and `probe.test.ts` exercise plugin-flow behavior.
- No current live Zalo Personal account scenario was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/zalouser/src/accounts.test.ts`, `zalo-js.credentials.test.ts`, `zca-client.test.ts`, `group-policy.test.ts`, `send.test.ts`, `message-sid.test.ts`, `text-styles.test.ts`, `status-issues.test.ts`, `security-audit.test.ts`, and setup test helpers cover focused account, credential, client, policy, send, identity, text, status, and security behavior.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "zalouser QR login zca-js group auth dangerous name matching" --json --limit 6`
- `gitcrawl search openclaw/openclaw --query "zalouser" --json --limit 8`

Results:

- The feature-specific query returned no hits.
- The broad zalouser query returned open hits including `#82543` start-account hang after re-login, `#84924` inbound photo attachments, `#84770` document media duplicate delivery, `#85039` markdown rendering normalization, `#87237` and `#86854` quote metadata forwarding, `#86851` quote metadata issue, and `#86561` group invite link action.

### Discrawl queries

Query:

- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 6 "zalouser QR login zca-js group auth"`
- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 8 "zalouser"`
- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 8 "Zalo Personal"`

Results:

- The feature-specific query returned no results.
- The `zalouser` query returned install timing notes, timeout-cleanup review context, mention-policy routing fixes, and PR `#69643` documenting Zalo profile env vars.
- The `Zalo Personal` query returned review comments about channel-prefix parsing breaking Zalo Personal sender labels, profile-env docs, and user setup output listing Zalo Personal as a selectable channel.
