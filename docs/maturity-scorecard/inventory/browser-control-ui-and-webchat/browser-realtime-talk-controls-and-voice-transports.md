---
title: "Gateway Web App - Browser Realtime Talk Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Gateway Web App - Browser Realtime Talk Maturity Note

## Summary

Browser Talk is implemented across the Control UI composer, Gateway Talk RPCs, provider browser-session creation, WebRTC, Google Live/provider WebSocket, and Gateway relay transports. Coverage is Beta because local tests cover transport logic and server handlers, but the real browser/provider/audio matrix is still new. Quality is Beta at the lower boundary because the implementation has clear credential and relay separation, while archive evidence shows recent fixed gaps and one active issue where Talk can speak a different answer than visible Control UI text.

## Category Scope

Included in this category:

- Browser Talk start/stop: Covers Browser Talk start/stop across browser Talk controls, Talk options, OpenAI browser WebRTC, Google Live/provider WebSocket, and related browser realtime talk behavior.
- Provider session selection: Covers Provider session selection across browser Talk controls, Talk options, OpenAI browser WebRTC, Google Live/provider WebSocket, and related browser realtime talk behavior.
- Gateway relay audio: Covers Gateway relay audio across browser Talk controls, Talk options, OpenAI browser WebRTC, Google Live/provider WebSocket, and related browser realtime talk behavior.
- Tool-call consults: Covers Tool-call consults across browser Talk controls, Talk options, OpenAI browser WebRTC, Google Live/provider WebSocket, and related browser realtime talk behavior.
- Steer and cancel: Covers Steer and cancel across browser Talk controls, Talk options, OpenAI browser WebRTC, Google Live/provider WebSocket, and related browser realtime talk behavior.

## Features

- Browser Talk start/stop: Covers Browser Talk start/stop across browser Talk controls, Talk options, OpenAI browser WebRTC, Google Live/provider WebSocket, and related browser realtime talk behavior.
- Provider session selection: Covers Provider session selection across browser Talk controls, Talk options, OpenAI browser WebRTC, Google Live/provider WebSocket, and related browser realtime talk behavior.
- Gateway relay audio: Covers Gateway relay audio across browser Talk controls, Talk options, OpenAI browser WebRTC, Google Live/provider WebSocket, and related browser realtime talk behavior.
- Tool-call consults: Covers Tool-call consults across browser Talk controls, Talk options, OpenAI browser WebRTC, Google Live/provider WebSocket, and related browser realtime talk behavior.
- Steer and cancel: Covers Steer and cancel across browser Talk controls, Talk options, OpenAI browser WebRTC, Google Live/provider WebSocket, and related browser realtime talk behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: UI tests cover WebRTC, Google Live, Gateway relay, consult, cancellation, and Talk app integration; Gateway tests cover `talk.client.*`, `talk.session.*`, relay, transcription relay, provider resolution, and Talk diagnostics.
- Negative signals: Maintainer live smoke exists, but browser microphone permissions, audio devices, provider auth, WebRTC networking, Google Live tokens, and relay latency need repeated real-environment proof.
- Integration gaps: Add release smoke for browser WebRTC, provider WebSocket, Gateway relay, microphone denial, provider auth failure, barge-in, active-run steer/cancel, and transcript/audio parity.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: Talk queries returned open #85275, `Talk mode can speak a different answer than the Control UI when agent reply uses message_tool_only / delivery-mirror`, plus voice feature requests and PR #85990 for Talk final text preference.
- Discrawl reports: Discord search found prior issue comments closing older missing-browser-Talk issues as implemented, and release traffic describing Talk/voice as a fast-moving beta feature.
- Good qualities: Browser-owned sessions avoid sending provider API keys to the browser, Gateway relay keeps backend-only credentials on the Gateway, transport selection is explicit, and active-run steering/cancel APIs are modeled.
- Bad qualities: The feature is newer than core text WebChat, spans browser audio APIs plus provider-specific realtime APIs, and visible text/audio parity is still an active product edge.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow proof affect Coverage only.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/browser-control-ui-and-webchat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Browser Talk start/stop, Provider session selection, Gateway relay audio, Tool-call consults, Steer and cancel.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Browser audio environments, autoplay, permission denial, and device changes need stronger operational proof.
- Managed-room realtime Talk is explicitly not available in the browser UI yet.
- Talk final text and Control UI visible reply parity needs follow-through on archive issues.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md` documents browser Talk, transport options, OpenAI WebRTC, Google Live, Gateway relay, consult tool calls, Talk controls, maintainer live smoke, and provider credential behavior.
- `/Users/kevinlin/code/openclaw/docs/gateway/protocol.md` documents `talk.catalog`, `talk.config`, `talk.client.create`, `talk.client.toolCall`, `talk.client.steer`, `talk.session.*`, `talk.event`, and `talk.speak`.
- `/Users/kevinlin/code/openclaw/docs/nodes/talk.md` documents broader Talk provider concepts.

### Source

- `/Users/kevinlin/code/openclaw/ui/src/ui/chat/realtime-talk.ts` selects browser Talk transports and falls back to Gateway relay when appropriate.
- `/Users/kevinlin/code/openclaw/ui/src/ui/chat/realtime-talk-webrtc.ts` implements browser WebRTC media, provider events, tool calls, and audio output.
- `/Users/kevinlin/code/openclaw/ui/src/ui/chat/realtime-talk-google-live.ts` implements provider WebSocket audio.
- `/Users/kevinlin/code/openclaw/ui/src/ui/chat/realtime-talk-gateway-relay.ts` implements authenticated Gateway relay microphone/audio flow.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/talk-client.ts` and `/Users/kevinlin/code/openclaw/src/gateway/server-methods/talk-session.ts` implement browser-owned and Gateway-owned Talk RPCs.

### Integration tests

- `/Users/kevinlin/code/openclaw/ui/src/ui/realtime-talk-webrtc.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/realtime-talk-google-live.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/realtime-talk-gateway-relay.test.ts`, and `/Users/kevinlin/code/openclaw/ui/src/ui/realtime-talk-consult.test.ts` cover browser Talk transports and consult behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/talk-realtime-relay.test.ts`, `/Users/kevinlin/code/openclaw/src/gateway/server-methods/talk.test.ts`, and `/Users/kevinlin/code/openclaw/src/gateway/server-methods/talk-session.ts` cover Gateway Talk paths.
- `/Users/kevinlin/code/openclaw/scripts/dev/realtime-talk-live-smoke.ts` is the documented maintainer live smoke for OpenAI, Google Live, and Gateway relay setup.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/talk/talk-session-controller.test.ts`, `/Users/kevinlin/code/openclaw/src/talk/provider-resolver.test.ts`, `/Users/kevinlin/code/openclaw/src/talk/agent-run-control.test.ts`, and `/Users/kevinlin/code/openclaw/src/talk/diagnostics.test.ts` cover lower-level Talk runtime behavior.
- `/Users/kevinlin/code/openclaw/ui/src/ui/app.talk.test.ts` covers app-level Talk state.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "Talk mode Control UI"`

Results:

- Returned open #85275, `Talk mode can speak a different answer than the Control UI when agent reply uses message_tool_only / delivery-mirror`.
- Returned voice-adjacent issues #68896 and #73019.

Query: `gitcrawl --json search prs -R openclaw/openclaw "Talk mode Control UI"`

Results:

- Returned open PR #85990, `Prefer Talk source-reply final text`.

Query: `gitcrawl --json search issues -R openclaw/openclaw "Control UI Talk realtime WebRTC Google Live gateway relay microphone"`

Results:

- Returned `[]`.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 12 "Talk mode Control UI WebChat realtime"`

Results:

- Found archive comments closing older issues #67465 and #40242 as implemented on current main, with notes that browser Talk now has a visible Control UI surface and browser realtime session RPC.
