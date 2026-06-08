---
title: "Telegram - Multi Account CLI Targets and Status Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Telegram - Multi Account CLI Targets and Status Maturity Note

## Summary

Telegram multi-account routing, CLI targets, directory peers, and status are a
Beta component. The implementation supports named accounts, default-account
selection, directory peers, target parsing, username/chat ID/forum-topic targets,
message send/poll CLI, and channel status summaries. Quality is limited by open
multi-account token resolution issues, account-local group config ambiguity, and
status-summary regressions.

## Category Scope

- Named account configuration, default account selection, account-local group
  config, and account-scoped action gates.
- CLI/message-tool targets: numeric chat IDs, usernames, forum-topic
  `chat:topic` targets, reply IDs, thread IDs, pin and force-document options.
- Directory adapters and configured peers/groups for user-facing target lists.
- Channel status, `channels status --probe`, token source summaries, liveness
  issues, and runtime labels.
- Account-scoped outbound, poll, media, and approval target resolution.

## Features

- Named account configuration: Named account configuration, default account selection, account-local group
- CLI/message-tool targets: numeric chat IDs, usernames, forum-topic
- Directory adapters: Directory adapters and configured peers/groups for user-facing target lists
- Channel status: Channel status, channels status --probe, token source summaries, liveness
- Account-scoped outbound: Account-scoped outbound, poll, media, and approval target resolution

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals:
  target parsing, outbound adapter, directory config, account selection, account
  config, status, and channel gateway startup have targeted tests.
- Negative signals:
  live proof primarily uses one SUT account and one group target; it does not
  repeatedly exercise multi-bot fleets, username target writeback, directory
  lists, account-local topic config, or status probe permutations.
- Integration gaps:
  add live proof for two Telegram accounts, explicit `defaultAccount`, account
  local group config, username target writeback, topic targets, status/probe
  output, and account-scoped approval delivery.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports:
  #61012, #64609, #63380, #70568, #82718, #79797, #79553, and #69529 show
  recurring multi-account, status, and cross-provider routing risk.
- Discrawl reports:
  live multi-account startup proof blocked PR #80986, and maintainer summaries
  listed Telegram multi-account token resolver and group routing as pressing
  issues.
- Good qualities:
  account resolution is centralized, default-account warnings exist, action
  gates are account-aware, and target parsing supports topic-qualified sends.
- Bad qualities:
  multi-account behavior remains hard to reason about when default-account,
  account-local groups, target writeback, and status summaries interact.
- Excluded from quality:
  unit coverage, integration coverage, live QA breadth, and test count were not
  used as Quality inputs.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/telegram.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Named account configuration, CLI/message-tool targets, Directory adapters, Channel status, Account-scoped outbound.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a documented live multi-account proof fixture with redacted startup logs.
- Add status output that makes default account, token source, account-local group
  config, and topic target resolution inspectable in one place.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/telegram.md` documents
  multi-account default-account selection, CLI targets, forum topic targets,
  polls, action gates, and status/probe troubleshooting.
- `/Users/kevinlin/code/openclaw/docs/cli/channels.md` covers channel CLI
  surfaces.

### Source

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/accounts.ts` resolves
  selected account IDs, default account fallback, token sources, and action
  gates.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/account-selection.ts`
  and `/Users/kevinlin/code/openclaw/extensions/telegram/src/account-config.ts`
  own account selection and config merge behavior.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/targets.ts` and
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/outbound-params.ts`
  parse chat, username, and topic targets.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/directory-config.ts`
  lists configured peers and groups.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/status.ts`,
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/status-issues.ts`, and
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/channel.ts` expose
  status and gateway lifecycle state.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/npm-telegram-rtt-config.mjs`
  configures Telegram account/group targets for live RTT proof.
- `/Users/kevinlin/code/openclaw/scripts/e2e/npm-telegram-live-docker.sh`
  exercises installed package channel add, doctor, and status-related hot paths.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/accounts.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/account-inspect.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/targets.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/outbound-params.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/directory-contract.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/status.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/channel.gateway.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/action-threading.test.ts`

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "Telegram multi account" --json`

Results:

- #61012 issue open: default account token ignored for outgoing messages.
- #82718 PR open: clarify account-local group config.
- #64609 issue open: group/topic systemPrompt ignored due to inconsistent
  multi-account config resolution.
- #63380 PR open: allow `agentId` in account config for multi-account routing.
- #79553 issue open: wizard cross-overwrites credentials in multi-account
  plugins.

Query:

`gitcrawl search openclaw/openclaw --query "channelSummary telegram" --json`

Results:

- #79797 issue open: `status --json` channelSummary is empty for a configured
  active Telegram channel.
- #82600 PR open: apply plugin auto-enable during CLI plugin registry load.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "telegram multi account"`

Results:

- `clawtributors`, 2026-05-12: PR #80986 was blocked on live multi-account
  Telegram startup proof.
- `Vincent <> Molty - The Crustacean Kabal`, 2026-05-08: maintainer digest
  listed Telegram multi-account token resolver and group routing as pressing
  issues.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "telegram status channelSummary"`

Results:

- `[openclaw] openclaw`, 2026-03-16: review comments described status-summary
  regressions for env-only channel setups such as `TELEGRAM_BOT_TOKEN`.
- `models anthropic not working`, 2026-02-17: status output example included a
  configured Telegram channel summary with token source.
