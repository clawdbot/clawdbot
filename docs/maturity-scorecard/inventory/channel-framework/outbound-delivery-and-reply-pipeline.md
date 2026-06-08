---
title: "Channel framework - Outbound Delivery and Reply Pipeline Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Channel framework - Outbound Delivery and Reply Pipeline Maturity Note

## Summary

Outbound delivery and reply handling has a mature shared core. The turn kernel routes assembled replies through durable outbound delivery, adapters expose text/media/poll receipt semantics, the reply pipeline supports channel transforms and typing callbacks, and the durable send context tracks render/send/edit/delete/commit/failure outcomes.

The maturity limit is provider-specific delivery edge cases. Core delivery mechanics are strong, but archive evidence shows recent fixes for empty assistant delivery, Telegram topic delivery, mixed text/tool delivery failures, and channel delivery cleanup across Telegram, iMessage, Slack, Matrix, and Discord.

## Category Scope

Included in this category:

- Automatic final reply delivery: Automatic final reply delivery and strict message-tool-only visible delivery
- Durable outbound send orchestration: Durable outbound send orchestration, receipts, partial failures, and fallback paths
- Reply pipeline transforms: Reply pipeline transforms, typing callbacks, draft streaming, and status reactions
- Provider outbound adapter bridge: Provider outbound adapter bridge and message capabilities

## Features

- Automatic final reply delivery: Automatic final reply delivery and strict message-tool-only visible delivery
- Durable outbound send orchestration: Durable outbound send orchestration, receipts, partial failures, and fallback paths
- Reply pipeline transforms: Reply pipeline transforms, typing callbacks, draft streaming, and status reactions
- Provider outbound adapter bridge: Provider outbound adapter bridge and message capabilities

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals:
  - Docs describe visible reply modes, message-tool-only suppression, native command exceptions, ambient room strict delivery, streaming/progress previews, and provider-specific delivery options (`docs/channels/groups.md:46`, `docs/channels/groups.md:54`, `docs/channels/groups.md:106`, `docs/channels/ambient-room-events.md:47`, `docs/channels/discord.md:684`, `docs/gateway/config-channels.md:807`).
  - Core source centralizes reply pipeline, durable delivery, durable send context, outbound adapter bridge, draft stream loop, status reactions, and delivery requirements.
  - Unit coverage is deep for durable delivery, send context outcomes, outbound adapter receipts, capabilities, draft streaming, and status reactions.
  - Docker and MCP channel harnesses exercise channel-shaped delivery after setup.
- Negative signals:
  - Provider-specific edge cases still surface in archive results, especially around Telegram topics and mixed text/tool delivery.
  - Visible reply modes are documented across group, ambient, provider, and config pages; the operator mental model is not centralized.
  - No current evidence shows every adapter has an equivalent durable-delivery conformance case.
- Integration gaps:
  - Live proof of delivery durability is not uniform across all official channels.
  - Message-tool-only suppression and automatic final reply behavior need a broader cross-channel E2E matrix.

## Quality Score

- Score: `Beta (75%)`
- Quality rationale:
  - Delivery outcomes are explicit: suppressed, delivered, partial failure, unsupported, and failed results are represented rather than hidden behind generic exceptions.
  - The durable send context keeps replayable rendered plans and forwards adapter receipts, which is a strong operational design for retries and debugging.
  - The framework distinguishes final assistant text, message-tool sends, draft edits, status reactions, and native command replies.
- Main quality risks:
  - Provider capabilities differ sharply, so the adapter bridge has to preserve nuanced receipt and failure behavior.
  - Operators can misconfigure visible-reply modes and observe "silent" successful turns unless docs/status explain suppression clearly.
  - Recent archive evidence shows this layer still receives multi-channel cleanup fixes.
- Quality scoring excludes test quantity; tests are recorded only as coverage evidence.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/channel-framework.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Automatic final reply delivery, Durable outbound send orchestration, Reply pipeline transforms, Provider outbound adapter bridge.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a provider conformance suite for automatic final reply, message-tool send, suppressed final, partial failure, unknown-send reconciliation, edit/delete, and media fallback.
- Consolidate visible-reply behavior into one operator table with the exact config keys and channel exceptions.
- Make delivery result summaries easier to inspect from `channels status` or turn traces.

## Evidence

### Docs

- `docs/channels/groups.md:46` through `docs/channels/groups.md:54` describe automatic visible replies and `message_tool` visible-reply mode.
- `docs/channels/groups.md:106` documents native slash command visible-reply exceptions.
- `docs/channels/ambient-room-events.md:47` and `docs/channels/ambient-room-events.md:181` document strict visible delivery for ambient rooms and suppression of final text unless the message tool posts.
- `docs/channels/discord.md:648` through `docs/channels/discord.md:684` describe reply modes, link previews, and streaming/progress delivery.
- `docs/channels/matrix.md:197` through `docs/channels/matrix.md:233` document Matrix streaming previews, tool-progress preview behavior, media final replies, and rate-limit tradeoffs.
- `docs/gateway/config-channels.md:807` through `docs/gateway/config-channels.md:809` explain the "agent ran but no visible reply" symptom and hot-reload behavior for visible-reply config.

### Source

- `src/channels/turn/kernel.ts:348` through `src/channels/turn/kernel.ts:428` assembles channel turns and routes replies through durable delivery with post-delivery observation.
- `src/channels/turn/kernel.ts:453` through `src/channels/turn/kernel.ts:764` records, dispatches, finalizes, drops, and runs channel turns across prepared/full adapter paths.
- `src/channels/message/reply-pipeline.ts:28` through `src/channels/message/reply-pipeline.ts:91` builds the reply pipeline with source delivery mode, channel transforms, typing, and lifecycle callbacks.
- `src/channels/turn/durable-delivery.ts:19` through `src/channels/turn/durable-delivery.ts:226` models delivery results, target/reply/thread resolution, support checks, and final durable send behavior.
- `src/channels/message/send.ts:40` through `src/channels/message/send.ts:102` models send result statuses; `src/channels/message/send.ts:155` through `src/channels/message/send.ts:349` implements durable send context render/preview/send/edit/delete/commit/fail orchestration.
- `src/channels/message/outbound-bridge.ts:27` through `src/channels/message/outbound-bridge.ts:167` defines outbound adapter methods, result/receipt shapes, and adapter bridge behavior.
- `src/channels/draft-stream-loop.ts:10` through `src/channels/draft-stream-loop.ts:127` implements throttled draft streaming and flush handling.
- `src/channels/status-reactions.ts:14` through `src/channels/status-reactions.ts:501` implements status reaction adapters, defaults, debounce, and terminal cleanup.

### Integration tests

- `scripts/e2e/npm-onboard-channel-agent-docker.sh:184` through `scripts/e2e/npm-onboard-channel-agent-docker.sh:201` verifies a channel turn after setup for Telegram, Discord, and Slack.
- `scripts/e2e/mcp-channels-docker.sh:29` and `scripts/e2e/mcp-channels-docker-client.ts:97` through `scripts/e2e/mcp-channels-docker-client.ts:311` exercise MCP channel send/conversation/attachment behavior in Docker.
- No all-channel live delivery conformance matrix was found.

### Unit tests

- `src/channels/turn/kernel.test.ts:201` through `src/channels/turn/kernel.test.ts:599` covers durable outbound delivery, delivery result propagation, payload preparation, unsupported/failure paths, custom delivery, legacy delivery, reply-pipeline options, and session recording before dispatch.
- `src/channels/turn/kernel.test.ts:633` through `src/channels/turn/kernel.test.ts:1147` covers prepared dispatch, bot-loop drops, observe-only dispatch, group history cleanup, preflight drops, custom adapters, and failed dispatch finalization.
- `src/channels/turn/durable-delivery.test.ts:72` through `src/channels/turn/durable-delivery.test.ts:192` covers explicit null targets, thread fallback, unknown-send reconciliation, and partial failures.
- `src/channels/message/send.test.ts:66` through `src/channels/message/send.test.ts:626` covers durable send rendering, replayable plans, signals, queue policy, multipart receipts, edit/delete, suppressed sends, hook cancellation, partial failures, and failure hooks.
- `src/channels/message/outbound-bridge.test.ts:27` through `src/channels/message/outbound-bridge.test.ts:229` covers text, rich payload, poll receipts, declared methods, receive acknowledgements, and lifecycle metadata.
- `src/channels/message/capabilities.test.ts:4` through `src/channels/message/capabilities.test.ts:43` covers durable final delivery requirements.
- `src/channels/draft-stream-loop.test.ts:30` through `src/channels/draft-stream-loop.test.ts:156` covers background flush failures and pending-text preservation.
- `src/channels/status-reactions.test.ts:198` through `src/channels/status-reactions.test.ts:654` covers reaction controller behavior, dedupe, cleanup, custom emojis, timing, errors, and constants.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "channel outbound delivery reply pipeline durable receipt" --json --limit 8`

Results:

- Returned no hits, which is neutral after freshness checks and suggests no broad current cluster with those exact framework terms.

Query: `gitcrawl search openclaw/openclaw --query "empty assistant delivery Telegram topic channel delivery" --json --limit 8`

Results:

- Returned issue #87711 about empty assistant delivery on a Telegram topic.
- Returned issue #48709 about mixed text/tool causing Telegram delivery failures.
- Returned issue #87744 about Codex-backed Telegram turns timing out.

Query: `gitcrawl search openclaw/openclaw --query "Telegram action replies durable Slack delivered finals iMessage duplicate approval sends" --json --limit 8`

Results:

- Returned no gitcrawl hits for the release-note phrasing; discrawl found the corresponding maintainer update.

### Discrawl queries

Query: `/Users/kevinlin/.local/bin/discrawl --json search "channel outbound delivery reply pipeline durable receipt" --limit 8`

Results:

- Returned null, which is neutral after freshness checks.

Query: `/Users/kevinlin/.local/bin/discrawl --json search "empty assistant delivery Telegram topic channel delivery" --limit 8`

Results:

- Returned null, which is neutral after freshness checks.

Query: `/Users/kevinlin/.local/bin/discrawl --json search "Telegram action replies durable iMessage duplicate approval sends Slack delivered finals" --limit 8`

Results:

- Returned a 2026-05-27 release note stating that channel delivery received cleanup: Telegram action replies are durable, iMessage avoids duplicate approval sends, Slack keeps delivered finals, Matrix mentions behave, and Discord recovered tool warnings stay out of successful replies.
