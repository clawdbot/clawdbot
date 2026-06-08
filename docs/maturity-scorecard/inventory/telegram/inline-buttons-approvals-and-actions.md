---
title: "Telegram - Native Controls and Approvals Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Telegram - Native Controls and Approvals Maturity Note

## Summary

Telegram inline buttons, exec approvals, and message actions are important and
usable, but still Beta. The component has clear docs, action gates, callback
handling, inline approval buttons, native approval runtime context, and message
tool actions for send/react/delete/edit/sticker/topic/poll. Quality remains
limited by active callback, duplicate approval, media-edit, action-gating, and
security-sensitive operator concerns.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Native Controls and Approvals`
- Merged from: `Commands and Interactive Controls`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Inline keyboard rendering: Inline keyboard rendering, callback query handling, Mini App URL buttons, and approval callbacks.
- Exec approvals in DMs: Exec approvals in DMs, channels, topics, or both; approver resolution; plugin
- Message actions: send, poll, react, delete, edit, sticker, and sticker search actions.
- Action capability discovery: Action capability discovery, gating config, account-scoped action gates, and requester trust checks.
- Native setMyCommands startup sync: Native setMyCommands startup sync, custom commands, native aliases, plugin
- Command name/description normalization: Command name/description normalization, menu budget trimming, duplicate
- Built-in commands: Built-in commands such as /help, /commands, /whoami, /status, and related command UI.
- Command authorization in DMs: Command authorization in DMs, groups, and commands addressed to other bots
- Model buttons: Model buttons and command UI helpers
- Native `setMyCommands` startup sync: Covers Native `setMyCommands` startup sync, custom commands, native aliases, plugin behavior.
- Command name/description normalization: Covers Command name/description normalization, menu budget trimming, duplicate behavior.
- Built-in commands such as `/help`: Covers Built-in commands such as `/help`, `/commands`, `/whoami`, `/status` behavior.
- Command authorization in DMs: Covers Command authorization in DMs, groups, and commands addressed to other bots behavior.
- Model buttons and command UI helpers: Evidence scope for Model buttons and command UI helpers.

## Features

- Inline keyboard rendering: Inline keyboard rendering, callback query handling, Mini App URL buttons, and approval callbacks.
- Exec approvals in DMs: Exec approvals in DMs, channels, topics, or both; approver resolution; plugin
- Message actions: send, poll, react, delete, edit, sticker, and sticker search actions.
- Action capability discovery: Action capability discovery, gating config, account-scoped action gates, and requester trust checks.
- Native setMyCommands startup sync: Native setMyCommands startup sync, custom commands, native aliases, plugin
- Command name/description normalization: Command name/description normalization, menu budget trimming, duplicate
- Built-in commands: Built-in commands such as /help, /commands, /whoami, /status, and related command UI.
- Command authorization in DMs: Command authorization in DMs, groups, and commands addressed to other bots
- Model buttons: Model buttons and command UI helpers

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals:
  inline buttons, button types, approval callbacks, exec approvals, action
  runtime, message actions, and action threading have focused tests and source
  anchors.
- Negative signals:
  live proof records inline-button metadata but does not fully exercise native
  approval clicks, action-gate combinations, media edits, or topic actions.
- Integration gaps:
  add live proof for approval DM/channel/both targets, unauthorized callback
  clicks, inline callback acknowledgements, topic actions, and media-message
  edit actions.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports:
  #64715, #76622, #76975, #74176, #70568, #75749, #86161, and #86176 show active
  or open work around keyboards, callback acknowledgement, approvals, duplicate
  delivery, and media edits.
- Discrawl reports:
  maintainer security discussion treats tool access, prompt context, and
  approvals as a high-blast-radius design area; release notes call out
  non-admin device-role approvals and durable Telegram action replies.
- Good qualities:
  action gates are account-aware, inline button scope is configurable,
  approval buttons route through native runtime context, and message actions
  expose explicit capabilities.
- Bad qualities:
  approval and action behavior is security-sensitive, callbacks can be opaque to
  users, and duplicate/fallback delivery still appears in archive history.
- Excluded from quality:
  unit coverage, integration coverage, live QA breadth, and test count were not
  used as Quality inputs.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/telegram.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Inline keyboard rendering, Exec approvals in DMs, Message actions, Action capability discovery, Native setMyCommands startup sync, Command name/description normalization, Built-in commands, Command authorization in DMs, Model buttons.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a native-approval live scenario with inline click proof and expired-click
  behavior.
- Add a generated Telegram action support matrix covering default gates and
  account overrides.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/telegram.md` documents inline
  buttons, Mini App buttons, message actions, action gates, reply threading,
  and exec approvals.
- `/Users/kevinlin/code/openclaw/docs/tools/exec-approvals.md` is the linked
  exec approvals reference.
- `/Users/kevinlin/code/openclaw/docs/tools/reactions.md` is linked for reaction
  removal semantics.

### Source

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/inline-buttons.ts`,
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/button-types.ts`, and
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/inline-keyboard.ts`
  implement inline button capability and rendering.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/approval-native.ts`,
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/approval-handler.runtime.ts`,
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/exec-approvals.ts`, and
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/exec-approval-forwarding.ts`
  implement approval routing and native approval handling.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/channel-actions.ts` and
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/action-runtime.ts`
  implement message action discovery and execution.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/action-threading.ts`
  resolves thread-aware action targets.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/telegram/telegram-live.runtime.ts`
  captures inline button labels and media kinds in observed message artifacts.
- `/Users/kevinlin/code/openclaw/scripts/e2e/npm-telegram-live-runner.ts`
  runs package-installed Telegram live scenarios that can include opt-in
  action/approval extensions.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/inline-buttons.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/button-types.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/approval-native.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/approval-handler.runtime.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/exec-approvals.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/exec-approval-resolver.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/channel-actions.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/action-runtime.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/action-threading.test.ts`

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "inline keyboard" --json`

Results:

- #64715 issue open: add native reply keyboard support to the
  message/agent send surface.
- #74176 PR open: support Mini App URL buttons.
- #76975 PR open: allow callback acknowledgement text.
- #76622 issue open: `answerCallbackQuery` called without text.
- #86161 issue open and #86176 PR open: media message edit behavior.

Query:

`gitcrawl search openclaw/openclaw --query "Telegram exec approvals" --json`

Results:

- #70568 PR open: scope ambiguous exec approvals to one account.
- #61051 PR open: Telegram admin terminal routing flow.
- #75749 issue open: plugin approval duplicate messages on Telegram.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "telegram inline button"`

Results:

- `clawtributors`, 2026-05-13: PR list included web_app button support in inline
  keyboard.
- `[openclaw] openclaw`, 2026-04-25: issue #63282 was closed after callback
  query support was confirmed.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "telegram approval"`

Results:

- `releases`, 2026-05-28: release notes called out non-admin device-role
  approvals and Telegram durable action replies.
- `maintainer-security-ops`, 2026-05-27: discussion treated tool access and
  prompt context as security-sensitive approval-adjacent architecture.
