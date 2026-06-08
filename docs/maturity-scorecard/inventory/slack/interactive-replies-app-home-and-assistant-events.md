---
title: "Slack - Interactive Replies, App Home, and Assistant Events Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Slack - Interactive Replies, App Home, and Assistant Events Maturity Note

## Summary

Slack supports App Home, assistant thread events, block actions, modal submissions, plugin-owned interactive routing, legacy Slack-specific interactive replies, and newer shared presentation blocks. Coverage is Beta because source/unit coverage is broad and native approvals exercise the interaction path, while live proof for App Home, assistant event variants, and plugin-owned modals is thinner. Quality is held down by active issues around interaction thread status and legacy/deprecated Slack-only controls.

## Category Scope

This category covers App Home publish/open behavior, Slack assistant thread started/context-changed events, block actions, modal submissions, external arg menus, plugin interactive handler routing, shared presentation controls, legacy Slack buttons/select directives, and interaction-generated system events.

## Features

- Interactive Replies: Covers Interactive Replies across App Home publish/open behavior, Slack assistant thread started/context-changed events, block actions, modal submissions, and related interactive replies, app home, and assistant events behavior.
- App Home: Covers App Home across App Home publish/open behavior, Slack assistant thread started/context-changed events, block actions, modal submissions, and related interactive replies, app home, and assistant events behavior.
- Assistant Events: Covers Assistant Events across App Home publish/open behavior, Slack assistant thread started/context-changed events, block actions, modal submissions, and related interactive replies, app home, and assistant events behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: Unit tests cover App Home, assistant events, block actions, interactions, modal metadata, interactive replies, block fallback limits, and interaction thread routing; approval live scenarios exercise Slack Block Kit button paths.
- Negative signals: Live coverage for App Home, assistant app threads, plugin-owned modals, external option menus, and legacy Slack-only controls is not part of the standard Slack live lane.
- Integration gaps: Add live scenarios for App Home open, assistant-thread context changed, block-action status/typing, plugin modal submit/close, external select menus, and legacy directive fallback.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: `#82886`, `#82895`, `#76185`, `#61374`, `#61502`, and `#12602` show interaction status/thread routing and Block Kit feature pressure.
- Discrawl reports: `Slack interactive reply clicks do not show assistant status/typing` appears in gitcrawl, while feature-specific discrawl query returned no focused Discord-archive messages beyond command/approval discussions.
- Good qualities: Docs now distinguish deprecated Slack-only directives from shared presentation controls and explain plugin modal routing with redacted system events.
- Bad qualities: The surface mixes old Slack-only syntax, shared presentation controls, plugin-owned modals, and Slack assistant events, which makes user expectations and routing state hard to explain.
- Excluded from quality: Unit-test count, live-lane breadth, and integration depth.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/slack.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Interactive Replies, App Home, Assistant Events.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add live App Home and assistant-thread scenarios.
- Add a plugin-owned modal sample with live Slack submit/close verification.
- Reduce reliance on legacy `[[slack_buttons]]` and `[[slack_select]]` directives in favor of shared presentation controls.

## Evidence

### Docs

- `docs/channels/slack.md` documents App Home/assistant manifest fields, interactive replies, plugin-owned modal submissions, Block Kit callback routing, and deprecation guidance for Slack-only directives.
- `docs/channels/slack.md` also documents App Home safe default view behavior and assistant thread routing.

### Source

- `extensions/slack/src/monitor/events/home.ts`, `assistant.ts`, and `interactions.ts` handle App Home, assistant thread events, and interactions.
- `extensions/slack/src/monitor/events/interactions.block-actions.ts` and `interactions.modal.ts` handle block actions and modals.
- `extensions/slack/src/interactive-dispatch.ts`, `interactive-replies.ts`, `shared-interactive.test.ts`, `blocks-input.ts`, `blocks-render.ts`, and `modal-metadata.ts` implement interactive rendering and plugin dispatch.
- `extensions/slack/src/monitor/message-handler/prepare.ts` restores assistant thread context and builds system events.

### Integration tests

- `extensions/qa-lab/src/live-transports/slack/slack-live.runtime.ts` includes native approval scenarios that verify pending and resolved Slack Block Kit approval UI.
- No standard live App Home, assistant, plugin-modal, or legacy interactive-reply scenario was found.

### Unit tests

- `extensions/slack/src/monitor/events/home.test.ts`, `assistant.test.ts`, `interactions.test.ts`, `message-subtype-handlers.test.ts`, and `system-event-test-harness.ts` cover Slack event handling.
- `extensions/slack/src/interactive-replies.test.ts`, `shared-interactive.test.ts`, `blocks.test.ts`, `actions.blocks.test.ts`, and `message-action-dispatch.test.ts` cover interactive rendering and dispatch.
- `extensions/slack/src/monitor/message-handler/prepare.test.ts` and `prepare-thread-context.test.ts` cover assistant/thread context integration.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "slack interactive app home assistant" --json`
- `gitcrawl search openclaw/openclaw --query "Slack" --json`

Results:

- The focused interaction query returned no hits.
- The broad Slack query returned `#82886` interactive reply clicks missing assistant status/typing, `#82895` preserve interaction thread status, `#76185` route block-action events to thread sessions, `#61374` wake sessions for interactive block actions, and `#12602` Slack Block Kit support for agent messages.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Slack interactive replies block actions app home assistant"`

Results:

- Returned no focused messages in the Discord archive. Related command and approval searches include interaction callback troubleshooting for Slack approval buttons.
