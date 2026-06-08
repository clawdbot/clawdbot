---
title: "Gateway Web App - WebChat Conversations Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Gateway Web App - WebChat Conversations Maturity Note

## Summary

The Control UI chat experience has a broad product surface: composer controls, queue/steer/stop behavior, session and agent selectors, model and thinking pickers, attachments, tool cards, grouped messages, markdown, avatars, context usage, and responsive layout. Coverage is Beta because there are many focused UI and E2E tests, but the product matrix is wide and cross-browser proof is uneven. Quality is Alpha because archive evidence shows frequent UI regressions around rendering, pickers, avatars, images, visible tool status, and in-progress state.

## Category Scope

Included in this category:

- Send and abort: Covers Send and abort across browser chat composition and display UX after an authenticated Gateway connection exists: composer controls, slash commands, session and agent filtering, model/thinking overrides, and related chat composer and message rendering behavior.
- Session and agent picker: Covers Session and agent picker across browser chat composition and display UX after an authenticated Gateway connection exists: composer controls, slash commands, session and agent filtering, model/thinking overrides, and related chat composer and message rendering behavior.
- Model/thinking controls: Covers Model/thinking controls across browser chat composition and display UX after an authenticated Gateway connection exists: composer controls, slash commands, session and agent filtering, model/thinking overrides, and related chat composer and message rendering behavior.
- Attachments: Covers Attachments across browser chat composition and display UX after an authenticated Gateway connection exists: composer controls, slash commands, session and agent filtering, model/thinking overrides, and related chat composer and message rendering behavior.
- Markdown/tool/media rendering: Covers Markdown/tool/media rendering across browser chat composition and display UX after an authenticated Gateway connection exists: composer controls, slash commands, session and agent filtering, model/thinking overrides, and related chat composer and message rendering behavior.
- chat.history projection: Covers chat.history projection across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- chat.send lifecycle: Covers chat.send lifecycle across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- Abort/partial retention: Covers Abort/partial retention across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- Injected assistant notes: Covers Injected assistant notes across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- Reconnect continuity: Covers Reconnect continuity across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- Hosted embeds: Covers Hosted embeds across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.
- External embed gating: Covers External embed gating across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.
- Assistant media tickets: Covers Assistant media tickets across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.
- Authenticated avatars: Covers Authenticated avatars across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.
- CSP image policy: Covers CSP image policy across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.

## Features

- Send and abort: Covers Send and abort across browser chat composition and display UX after an authenticated Gateway connection exists: composer controls, slash commands, session and agent filtering, model/thinking overrides, and related chat composer and message rendering behavior.
- Session and agent picker: Covers Session and agent picker across browser chat composition and display UX after an authenticated Gateway connection exists: composer controls, slash commands, session and agent filtering, model/thinking overrides, and related chat composer and message rendering behavior.
- Model/thinking controls: Covers Model/thinking controls across browser chat composition and display UX after an authenticated Gateway connection exists: composer controls, slash commands, session and agent filtering, model/thinking overrides, and related chat composer and message rendering behavior.
- Attachments: Covers Attachments across browser chat composition and display UX after an authenticated Gateway connection exists: composer controls, slash commands, session and agent filtering, model/thinking overrides, and related chat composer and message rendering behavior.
- Markdown/tool/media rendering: Covers Markdown/tool/media rendering across browser chat composition and display UX after an authenticated Gateway connection exists: composer controls, slash commands, session and agent filtering, model/thinking overrides, and related chat composer and message rendering behavior.
- chat.history projection: Covers chat.history projection across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- chat.send lifecycle: Covers chat.send lifecycle across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- Abort/partial retention: Covers Abort/partial retention across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- Injected assistant notes: Covers Injected assistant notes across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- Reconnect continuity: Covers Reconnect continuity across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- Hosted embeds: Covers Hosted embeds across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.
- External embed gating: Covers External embed gating across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.
- Assistant media tickets: Covers Assistant media tickets across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.
- Authenticated avatars: Covers Authenticated avatars across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.
- CSP image policy: Covers CSP image policy across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: UI controller, view, chat helper, style, and browser E2E tests cover composer state, send/abort, session picker pagination, model picker, markdown, grouped rendering, tool cards, attachments, responsive layout, and avatar display.
- Negative signals: Real browser matrix, mobile layout, large transcripts, provider-specific streaming shapes, and media attachments have more regression exposure than end-to-end scenario proof.
- Integration gaps: Add cross-browser/mobile smoke for long transcripts, image/file attachments, model switching while sending, queued follow-ups, slash menu, tool card replay, and responsive controls.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: Broad Control UI/WebChat searches returned #50779 for tool-returned images, #85750 for avatar auth, #74354 for numeric message formatting, #61661 for historical routed session restore, #81760 for wrong thinking defaults, #73836 for responsiveness regression, and PRs #87673, #79747, #74274, #81795, and #49511.
- Discrawl reports: Discord search found maintainer and user reports around Control UI/chat regressions, image generation not visibly appearing in Control UI, approval modal behavior, and release traffic around faster visible replies and chat UI fixes.
- Good qualities: The UI code has explicit state machines for optimistic sends, pending ACKs, model switch promises, session picker state, attachment payload retention, render normalization, and tool card display.
- Bad qualities: The feature surface is dense and changes frequently; small regressions can make visible chat state diverge from the underlying Gateway/session state.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow proof affect Coverage only.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/browser-control-ui-and-webchat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Send and abort, Session and agent picker, Model/thinking controls, Attachments, Markdown/tool/media rendering, chat.history projection, chat.send lifecycle, Abort/partial retention, Injected assistant notes, Reconnect continuity, Hosted embeds, External embed gating, Assistant media tickets, Authenticated avatars, CSP image policy.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Mobile browser and PWA layout proof lags desktop Chromium proof.
- Chat attachments and generated-media rendering remain recurring user-visible issue sources.
- Model/thinking/session picker interactions need broader release scenarios for multi-agent and provider-scoped catalogs.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md` documents chat controls, upload behavior, duplicate collapse, model/thinking pickers, session filtering, `/new`, `/reset`, `/stop`, context usage, and Talk adjacent controls.
- `/Users/kevinlin/code/openclaw/docs/web/webchat.md` documents display normalization, reasoning exclusion, media transcript supplements, and read-only behavior when disconnected.
- `/Users/kevinlin/code/openclaw/docs/start/getting-started.md` presents Control UI chat as the first-run user path.

### Source

- `/Users/kevinlin/code/openclaw/ui/src/ui/app-chat.ts` coordinates composer send/abort, queues, session refresh, model switch waits, and chat avatar refresh.
- `/Users/kevinlin/code/openclaw/ui/src/ui/views/chat.ts` renders the chat view, composer, Talk controls, attachments, and transcript layout.
- `/Users/kevinlin/code/openclaw/ui/src/ui/chat/session-controls.ts` implements session, agent, model, and thinking selectors.
- `/Users/kevinlin/code/openclaw/ui/src/ui/chat/attachment-payload-store.ts` and `/Users/kevinlin/code/openclaw/ui/src/ui/chat/attachment-support.ts` handle browser attachment payloads.
- `/Users/kevinlin/code/openclaw/ui/src/ui/chat/tool-cards.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/chat/grouped-render.ts`, and `/Users/kevinlin/code/openclaw/ui/src/ui/markdown.ts` render tool and markdown content.

### Integration tests

- `/Users/kevinlin/code/openclaw/ui/src/ui/e2e/chat-flow.e2e.test.ts` covers mocked browser chat send, delayed ACK, errors, and retry behavior.
- `/Users/kevinlin/code/openclaw/ui/src/ui/e2e/chat-picker-pagination.e2e.test.ts` covers picker pagination.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/chat-webchat-media.test.ts` covers media display payloads used by WebChat.

### Unit tests

- `/Users/kevinlin/code/openclaw/ui/src/ui/app-chat.test.ts` covers send, abort, queue, model switch, and session behavior.
- `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/chat.test.ts` covers client-side chat state.
- `/Users/kevinlin/code/openclaw/ui/src/ui/views/chat.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/chat/run-controls.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/chat/grouped-render.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/chat/tool-cards.test.ts`, and `/Users/kevinlin/code/openclaw/ui/src/ui/chat/chat-responsive.browser.test.ts` cover renderer details.
- `/Users/kevinlin/code/openclaw/ui/src/ui/app-render.assistant-avatar.test.ts` and `/Users/kevinlin/code/openclaw/ui/src/ui/chat/chat-avatar.test.ts` cover avatar rendering.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "Control UI"`

Results:

- Returned open #50779, #85750, #74354, #61661, #81760, #73836, #83494, #80039, #68248, and other Control UI issues.

Query: `gitcrawl --json search prs -R openclaw/openclaw "Control UI"`

Results:

- Returned open PRs #87673, #79747, #74274, #81795, #49511, #80192, #80388, #87147, #73894, and others.

Query: `gitcrawl --json search issues -R openclaw/openclaw "control ui chat composer attachments model picker session picker"`

Results:

- Returned `[]`.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 20 "Control UI"`

Results:

- Found user report that generated images in Control UI ended with no visible attachment until explicitly linked.
- Found maintainer traffic around Control UI skill cards, approval modal dismissal, and release notes naming Control UI/chat regressions.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "control ui chat composer attachments model picker session picker"`

Results:

- Returned no rows.
