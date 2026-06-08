---
title: "Telegram - Channel Setup and Operations Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Telegram - Channel Setup and Operations Maturity Note

## Summary

Telegram setup is a strong Beta-to-Stable component. Public docs cover BotFather,
token placement, env fallback, account-aware token precedence, setup wizard
behavior, and startup diagnostics. The main maturity drag is operator variance:
token files, SecretRefs, multi-account defaults, and status summaries still show
up in recent archive reports.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Channel Setup and Operations`
- Merged from: `Setup and Accounts`, `Runtime Lifecycle`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- BotFather token creation: BotFather token creation and first gateway start
- TELEGRAM_BOT_TOKEN: TELEGRAM_BOT_TOKEN, botToken, tokenFile, and account-scoped token
- Setup wizard credential capture: Setup wizard credential capture, allowlist prompts, and DM policy defaults
- Startup getMe: Startup getMe, bot-info cache, account throttling, and multi-account default
- Doctor/status surfacing: Doctor/status surfacing for invalid tokens, missing defaults, and read-only
- Named account configuration: Named account configuration, default account selection, account-local group
- CLI/message-tool targets: numeric chat IDs, usernames, forum-topic
- Directory adapters: Directory adapters and configured peers/groups for user-facing target lists
- Channel status: Channel status, channels status --probe, token source summaries, liveness
- Account-scoped outbound: Account-scoped outbound, poll, media, and approval target resolution
- Long polling runner startup: Long polling runner startup, duplicate-poller protection, update offsets, and account lifecycle.
- Webhook listener startup: Webhook listener startup, secret validation, async event dispatch, and local
- Reconnect: Reconnect, recoverable network errors, stalled getUpdates, timeout clamps, and recovery handling.
- Restart: Restart and recovery behavior after token rotation, process aborts, and account reloads.
- Named account configuration: Covers Named account configuration, default account selection, account-local group behavior.
- Directory adapters and configured peers/groups for: Covers Directory adapters and configured peers/groups for user-facing target lists behavior.
- Channel status: Covers Channel status, `channels status --probe`, token source summaries, liveness behavior.
- Account-scoped outbound: Covers Account-scoped outbound, poll, media, and approval target resolution behavior.
- Long polling runner startup: Long polling runner startup, duplicate-poller protection, update offsets, and account lifecycle
- Reconnect: Reconnect, recoverable network errors, stalled getUpdates, timeout clamps, and recovery handling
- Restart: Restart and recovery behavior after token rotation, process aborts, and account reloads

## Features

- BotFather token creation: BotFather token creation and first gateway start
- TELEGRAM_BOT_TOKEN: TELEGRAM_BOT_TOKEN, botToken, tokenFile, and account-scoped token
- Setup wizard credential capture: Setup wizard credential capture, allowlist prompts, and DM policy defaults
- Startup getMe: Startup getMe, bot-info cache, account throttling, and multi-account default
- Doctor/status surfacing: Doctor/status surfacing for invalid tokens, missing defaults, and read-only
- Named account configuration: Named account configuration, default account selection, account-local group
- CLI/message-tool targets: numeric chat IDs, usernames, forum-topic
- Directory adapters: Directory adapters and configured peers/groups for user-facing target lists
- Channel status: Channel status, channels status --probe, token source summaries, liveness
- Account-scoped outbound: Account-scoped outbound, poll, media, and approval target resolution

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals:
  setup, config schema, account resolution, status, doctor, and package Telegram
  Docker flows all have source and test anchors.
- Negative signals:
  live package proof focuses on installation, onboarding, doctor, and group reply
  paths; it does not exercise every credential shape or every multi-account
  inheritance branch.
- Integration gaps:
  missing recurring live evidence for token-file SecretRefs, account-local group
  config, and default-account migration prompts across fresh and upgraded hosts.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports:
  multi-account and SecretRef reports keep this below Stable: #61012, #62985,
  #74832, #74833, and #82718.
- Discrawl reports:
  setup help traffic includes BotFather/token onboarding confusion and requests
  for live multi-account startup proof.
- Good qualities:
  token resolution is account-aware, invalid tokens fail before polling, bot-info
  cache invalidation is explicit, and the setup wizard writes numeric allowlists.
- Bad qualities:
  operators can still confuse default account selection, SecretRef status reads,
  group IDs versus user IDs, and env-only setups.
- Excluded from quality:
  unit coverage, integration coverage, live QA breadth, and test count were not
  used as Quality inputs.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/telegram.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for BotFather token creation, TELEGRAM_BOT_TOKEN, Setup wizard credential capture, Startup getMe, Doctor/status surfacing, Named account configuration, CLI/message-tool targets, Directory adapters, Channel status, Account-scoped outbound.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add release-scorecard proof for token file, SecretRef, env-only default, and
  multi-account named-account setups.
- Make default-account warnings and account-local group config easier to inspect
  in `openclaw channels status`.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/telegram.md` documents BotFather
  token creation, env fallback, account-aware token resolution, invalid-token
  diagnostics, and multi-account default-account guidance.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-channels.md` is the linked
  Telegram configuration reference.

### Source

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/setup-surface.ts`
  implements setup wizard credential and allowlist capture.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/accounts.ts` resolves
  account IDs, default-account fallback, action gates, and token sources.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/channel.ts` wires bot
  info cache, startup probes, setup adapter, status, doctor, and monitor start.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/token.ts` and
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-info-cache.ts`
  handle token and bot identity cache behavior.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/npm-telegram-live-docker.sh`
  installs the package, runs onboarding, adds Telegram, and runs doctor paths.
- `/Users/kevinlin/code/openclaw/test/scripts/npm-telegram-live.test.ts`
  asserts the installed-package Telegram Docker harness, credential aliases,
  bounded commands, and doctor/onboarding steps.
- `/Users/kevinlin/code/openclaw/scripts/e2e/npm-telegram-rtt-config.mjs`
  builds a live Telegram group config with bot tokens, group allowlists, and
  mention-gated group settings.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/accounts.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/token.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/config-schema.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/setup-surface.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/channel.gateway.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/doctor.test.ts`

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "Telegram SecretRef" --json`

Results:

- #52130 issue open: restart storm from `telegram.retry.jitter` type mismatch
  plus misleading doctor SecretRef for Telegram token.
- #74832 issue open: `openclaw status` fails on Telegram file SecretRef while
  resolving allowlist metadata.
- #74833 PR open: avoid resolving secrets for status accessors.

Query:

`gitcrawl search openclaw/openclaw --query "Telegram multi account" --json`

Results:

- #61012 issue open: Telegram multi-bot routing ignores the default account
  token for outgoing messages.
- #82718 PR open: docs clarify account-local group config.
- #64609 issue open: group/topic `systemPrompt` ignored in multi-account config
  due to inconsistent config resolution.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "telegram bot token setup"`

Results:

- `users-helping-users`, 2026-04-26: first-time setup user described creating a
  BotFather token and entering it during OpenClaw config.
- `users-helping-users`, 2026-05-12: VPS report said a fresh Telegram bot token
  worked briefly, then polling stopped responding.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "telegram multi account"`

Results:

- `clawtributors`, 2026-05-12: multi-account Telegram startup proof was called
  out as the blocker for PR #80986.
- `Vincent <> Molty - The Crustacean Kabal`, 2026-05-08: release/regression
  sweep listed Telegram multi-account token resolver among pressing issues.
