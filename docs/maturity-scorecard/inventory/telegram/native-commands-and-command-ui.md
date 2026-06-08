---
title: "Telegram - Native Commands and Command UI Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Telegram - Native Commands and Command UI Maturity Note

## Summary

Telegram native commands and command UI are close to Stable on Coverage. Startup
sync registers native, custom, plugin, and skill commands; command auth and
group addressing are tested; live QA covers help, commands, whoami, status,
context, repeated auth, and other-bot command gating. Quality remains Beta due
to command menu overflow, alias/menu trimming, localized command menu changes,
and slash command dispatch churn.

## Category Scope

- Native `setMyCommands` startup sync, custom commands, native aliases, plugin
  and skill command menu entries.
- Command name/description normalization, menu budget trimming, duplicate
  handling, and cleanup when native commands are disabled.
- Built-in commands such as `/help`, `/commands`, `/whoami`, `/status`,
  `/context`, `/activation`, `/reasoning`, and device-pair commands.
- Command authorization in DMs, groups, and commands addressed to other bots.
- Model buttons and command UI helpers.

## Features

- Native setMyCommands startup sync: Native setMyCommands startup sync, custom commands, native aliases, plugin
- Command name/description normalization: Command name/description normalization, menu budget trimming, duplicate
- Built-in commands: Built-in commands such as /help, /commands, /whoami, /status, and related command UI.
- Command authorization in DMs: Command authorization in DMs, groups, and commands addressed to other bots
- Model buttons: Model buttons and command UI helpers

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals:
  live QA includes multiple command scenarios, and command registration,
  command config, group auth, aliases, menu support, and command delivery all
  have focused tests.
- Negative signals:
  live proof does not cover every plugin/skill command menu combination or every
  overflow/cleanup branch.
- Integration gaps:
  add live proof for large plugin command catalogs, localized command menu text,
  native disabled cleanup, and command menu overflow recovery.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports:
  #67782, #85493, #68833, #77513, and #81351 show active command-menu and command
  sync polish; #79310/#78347 were called out in maintainer traffic as slash or
  plugin command dispatch issues.
- Discrawl reports:
  recent maintainer traffic included command behavior fixes and release notes
  called out Telegram typing/progress/forum-topic command-adjacent polish.
- Good qualities:
  command names are normalized, conflicts are skipped, bot-addressing is
  respected, command auth is explicit, and live QA covers the primary built-in
  command flow.
- Bad qualities:
  Telegram menu limits and plugin/skill command catalogs create a high-variance
  startup surface for operators.
- Excluded from quality:
  unit coverage, integration coverage, live QA breadth, and test count were not
  used as Quality inputs.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/telegram.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Native setMyCommands startup sync, Command name/description normalization, Built-in commands, Command authorization in DMs, Model buttons.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add generated command-menu budget diagnostics for operators.
- Keep localized/custom/plugin command menu combinations in release proof.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/telegram.md` documents native
  commands, custom commands, command menu overflow, device-pair commands, and
  partial command troubleshooting.
- `/Users/kevinlin/code/openclaw/docs/channels/telegram.md` also documents
  `/activation` and `/reasoning` behavior for Telegram.

### Source

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-native-commands.ts`
  and `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-native-command-menu.ts`
  implement native command handling and menu sync.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/command-config.ts`
  normalizes custom command config.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/command-ui.ts` and
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/model-buttons.ts`
  implement command UI helpers.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-native-commands.runtime.ts`
  owns runtime command execution dependencies.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/telegram/telegram-live.runtime.ts`
  includes `telegram-help-command`, `telegram-commands-command`,
  `telegram-whoami-command`, `telegram-status-command`,
  `telegram-repeated-command-authorization`,
  `telegram-other-bot-command-gating`, and `telegram-context-command`.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-native-commands.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-native-command-menu.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot.command-menu.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-native-commands.registry.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-native-commands.group-auth.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-native-commands.skills-allowlist.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/command-ui.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/model-buttons.test.ts`

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "setMyCommands" --json`

Results:

- #67782 PR open: skip delete before non-empty command sync.
- #85493 PR open: keep native aliases out of command menus.
- #68833 PR open: preserve customCommands priority in menu budget trimming.
- #77513 PR open: sync native commands to private and group scopes.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "telegram commands"`

Results:

- `maintainers`, 2026-05-29: fixes included stale Telegram-only wording for
  `/reasoning stream` and command matching changes for `/new` and `/reset`.
- `maintainer-security-ops`, 2026-05-27: command/tool access was discussed as a
  cross-channel hardening concern.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "telegram inline button"`

Results:

- `clawtributors`, 2026-05-13: PR #81351 was listed for localized Telegram
  command menu descriptions.
