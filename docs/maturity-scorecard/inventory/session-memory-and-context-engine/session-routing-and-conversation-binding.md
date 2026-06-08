---
title: "Session, memory, and context engine - Session Routing Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Session, memory, and context engine - Session Routing Maturity Note

## Summary

Session routing is a mature, documented control plane for deciding which
conversation bucket receives each message. The source has explicit session-key
normalization, channel conversation binding, outbound session binding, and
Gateway session resolution paths. Coverage is strongest around Gateway session
RPCs and SDK flows, while cross-channel route-interception and some plugin
binding scenarios remain active quality risks.

## Category Scope

This category covers `sessionKey` construction, target resolution, conversation
bindings, session labels, per-conversation isolation, thread binding, model
selection continuity tied to sessions, and agent/workspace store targeting.

## Features

- Session Routing: Covers Session Routing across `sessionKey` construction, target resolution, conversation bindings, session labels, per-conversation isolation, thread binding, model selection continuity tied to sessions, and agent/workspace store targeting.
- Conversation routing: Covers Conversation Binding across `sessionKey` construction, target resolution, conversation bindings, session labels, per-conversation isolation, thread binding, model selection continuity tied to sessions, and agent/workspace store targeting.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: docs define route families and persistence locations; source centralizes session-key and binding normalization; Gateway and SDK tests cover `sessions.list`, `sessions.resolve`, `sessions.patch`, `sessions.compact`, and session-scoped stream events.
- Negative signals: route interception before final session selection is still an open request, and channel/plugin binding variants have uneven real-environment proof.
- Integration gaps: add a scenario that sends the same conversation through WebChat, one channel thread, and one plugin-bound route, then proves the same expected store key, model selection, and last-route behavior.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: one open route-adjacent issue was found for pre-routing interception.
- Discrawl reports: the feature-specific Discord query returned no matching rows.
- Good qualities: the routing model is explicit, source-backed, and documented across concepts, channel-routing, and Gateway RPC surfaces.
- Bad qualities: pre-routing bridge/proxy use cases and channel plugin binding behavior still depend on specialized paths rather than one obvious operator story.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test depth.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/session-memory-and-context-engine.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Session Routing, Conversation routing.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Pre-routing interception is not first-class for channel bridge/proxy operators.
- Binding behavior is documented heavily for major channels, but the cross-plugin operator model is harder to validate from docs alone.

## Evidence

### Docs

- `docs/concepts/session.md:10` says each message is routed to a session based on origin; `docs/concepts/session.md:90` records Gateway ownership of session state.
- `docs/channels/channel-routing.md:21` defines `SessionKey`; `docs/channels/channel-routing.md:57` explains direct-message main-session sharing; `docs/channels/channel-routing.md:79` lists binding priority.
- `docs/channels/discord.md:310` documents DM, guild channel, and slash-command session keys; `docs/channels/slack.md:1020` documents Slack thread/session routing.

### Source

- `src/routing/session-key.ts:26` defines default agent and main keys; `src/routing/session-key.ts:197` builds peer session keys; `src/routing/session-key.ts:314` resolves thread session keys.
- `src/channels/conversation-resolution.ts:296` resolves command conversation targets with plugin/provider participation.
- `src/infra/outbound/session-binding-service.ts:142` registers binding adapters; `src/infra/outbound/session-binding-service.ts:354` resolves bindings by conversation.
- `src/gateway/sessions-resolve.ts:93` resolves visible session keys from key, label, or session id.

### Integration tests

- `src/gateway/server.sessions.store-rpc.test.ts:35` exercises Gateway `sessions.*` RPCs and advertised methods.
- `packages/sdk/src/index.e2e.test.ts:427` covers documented namespace helpers over a Gateway WebSocket, including sessions methods.
- `packages/sdk/src/index.e2e.test.ts:566` includes real Gateway e2e streaming with session keys.

### Unit tests

- `src/routing/session-key.test.ts` and `src/routing/session-key.continuity.test.ts` cover session-key normalization and continuity.
- `src/channels/conversation-resolution.test.ts` and `src/channels/plugins/session-conversation.test.ts` cover conversation/session resolution.
- `src/sessions/session-id-resolution.test.ts` covers ambiguous and structural session-id matching.

### Gitcrawl queries

Query:

`gitcrawl search issues "sessionKey conversation binding sessions.resolve" -R openclaw/openclaw --state all --json number,title,url,state`

Results:

- Returned 1 open issue: `#81061 Hook: before_route_inbound_message - pre-routing interception for channel bridging/proxying`.

### Discrawl queries

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "sessionKey conversation binding sessions.resolve"`

Results:

- Returned no matching rows.
