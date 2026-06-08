---
title: "Discord - Message and Media Delivery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Discord - Message and Media Delivery Maturity Note

## Summary

This note migrates archived maturity evidence for `Discord` / `Outbound Message Rendering and Delivery` into the current process-version-3 scorecard inventory.

## Category Scope

Included in this category:

- Direct and thread sends: Covers Direct and thread sends across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior.
- Text chunking and reply mode: Covers Text chunking and reply mode across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior.
- Draft and progress edits: Covers Draft and progress edits across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior.
- Mention and embed rendering: Covers Mention and embed rendering across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior.
- REST retry and final delivery: Covers REST retry and final delivery across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior.
- File uploads: Outbound file uploads from URLs and local paths, including delivery constraints and follow-up behavior.
- Component file and media-gallery blocks: Component v2 file and media-gallery blocks for Discord media delivery.
- Video caption follow-up: Video caption handling and follow-up media-only delivery in Discord conversations.
- Voice-message upload: Discord voice-message sends with OGG/Opus conversion, waveform generation, duration metadata, and upload URL handling.
- Inbound attachment context: Inbound attachment context made available to Discord replies and agent turns.

## Features

- Direct and thread sends: Covers Direct and thread sends across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior.
- Text chunking and reply mode: Covers Text chunking and reply mode across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior.
- Draft and progress edits: Covers Draft and progress edits across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior.
- Mention and embed rendering: Covers Mention and embed rendering across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior.
- REST retry and final delivery: Covers REST retry and final delivery across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior.
- File uploads: Outbound file uploads from URLs and local paths, including delivery constraints and follow-up behavior.
- Component file and media-gallery blocks: Component v2 file and media-gallery blocks for Discord media delivery.
- Video caption follow-up: Video caption handling and follow-up media-only delivery in Discord conversations.
- Voice-message upload: Discord voice-message sends with OGG/Opus conversion, waveform generation, duration metadata, and upload URL handling.
- Inbound attachment context: Inbound attachment context made available to Discord replies and agent turns.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`

Coverage is strong for the main runtime path. The source tree has real Discord send/readback coverage through the macOS Parallels e2e script, QA-lab live scenarios for canary replies, thread/file replies, status reactions, and mention-gated flows, plus runtime-flow tests for draft preview finalization, standard fallback delivery, reply reference use, media/error fallback, progress edits, chunked final output, and shared durable delivery.

Coverage is not higher because the live/e2e proof is not a single end-to-end matrix that exercises every risky outbound option together. Chunking, `replyToMode`, embed suppression, mention alias rewriting, reconnect/retry behavior, streaming progress drafts, and media follow-up each have evidence, but several are proven by runtime-flow or adapter-level harnesses rather than by a live Discord transport run. Gitcrawl also still has open runtime reports around reconnect delivery loss, progress draft gaps, and TTS/voice-triggered outbound failure, so the integration surface is broad but not fully sealed by live proof.

## Quality Score

- Score: `Beta (76%)`

The implementation has a coherent architecture: Discord uses the shared outbound pipeline, returns receipts, applies explicit message flags, chunks text before hitting Discord limits, suppresses URL embeds by default, supports explicit embeds and component v2 payloads, rewrites configured mention aliases, preserves reply references across chunked sends, emits live draft/progress edits, and wraps direct outbound sends with REST retry handling. Error handling is also useful in practice: missing permission, blocked DM, thread-send, attachment, and channel visibility failures are mapped to actionable Discord-specific errors.

Quality is held at Beta by current operational risk, not by test count. Gitcrawl and discrawl both show active or recent delivery-quality issues: reconnect windows can drop outbound messages without a durable queue, progress mode can produce dead air or overwrite prior reasoning text, partial/block streaming can show misleading mid-output fragments, cron/TTS paths can report success while Discord delivery does not happen, and reply mention behavior remains ambiguous for some native reply modes. There is also an open security/quality report about metadata leakage in Discord thread delivery, even though current source now routes final front-channel payloads through sanitizer paths. These are user-visible delivery and rendering risks in the active channel surface.

Quality inputs deliberately exclude unit test volume, missing tests, and general integration depth. The score is based on architecture, current source behavior, documented semantics, and live/archive reports of outbound rendering and delivery failures.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/discord.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Direct and thread sends, Text chunking and reply mode, Draft and progress edits, Mention and embed rendering, REST retry and final delivery, File uploads, Component file and media-gallery blocks, Video caption follow-up, Voice-message upload, Inbound attachment context.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- See the score-specific negative signals and archived evidence below.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:212` documents per-call token selection for advanced outbound sends and account-specific retry policy.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:343` states Discord component v2 interaction results route back to the same conversation and follow `replyToMode`.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:648` documents `channels.discord.replyToMode`.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:667` documents default generated-link embed suppression, per-account overrides, per-message `suppressEmbeds: false`, and the distinction from explicit embeds.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:684` documents streaming draft replies and the `off`, `partial`, `block`, and `progress` modes.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:979` documents `mentionAliases` for deterministic outbound mentions.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1117` lists outbound message actions including `sendMessage`, `editMessage`, `deleteMessage`, and `threadReply`.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1137` documents components v2 payload support, legacy embeds, and URL preview suppression defaults.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1716` groups the config reference for `replyToMode`, `textChunkLimit`, `chunkMode`, `maxLinesPerMessage`, streaming settings, media, and retry.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-channel-outbound.md:2` describes the shared outbound lifecycle API for durable sends, receipts, live preview, and reply pipeline helpers.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-channel-outbound.md:14` splits responsibilities between the core queue/durability/retry/hooks/receipts layer and the plugin-native send/edit/delete layer.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-channel-outbound.md:95` documents draft streaming, progress helpers, and sent/suppressed/failed payload outcomes.

### Source

- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.message-request.ts:47` builds Discord message payloads, handles component v2 payloads, embeds, files, flags, and reply references with `fail_if_not_exists: false`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/chunk.ts:148` chunks outbound text by character and soft line limits while preserving fenced code blocks.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.shared.ts:157` maps Discord send failures into actionable errors for missing permissions, blocked DMs, thread send permission, and attachment permission.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.shared.ts:296` sends chunked text, applies components and embeds only to the first chunk, preserves flags, and carries reply references across chunks.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.shared.ts:355` sends media with caption splitting, reply references, follow-up chunks, and returned platform message ids.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.outbound.ts:148` resolves Discord outbound config, account, chunking, max lines, embed suppression, mention aliases, channel recipients, and text/media send paths.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.outbound.ts:187` handles forum/media channel thread-starter sends and follow-up delivery into the created thread.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/mentions.ts:94` rewrites configured/cache-backed plain-text mention aliases while preserving unknown handles, reserved mentions, and code spans.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/draft-stream.ts:55` creates and edits live draft previews with Discord size caps, reply references, `allowed_mentions: { parse: [] }`, and embed suppression flags.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.draft-preview.ts:46` resolves streaming modes and creates draft preview controllers for partial, block, and progress behavior.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.process.ts:599` finalizes a safe draft preview by edit, otherwise falls back to standard Discord delivery for media, errors, explicit reply tags, or multi-chunk output.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/reply-delivery.ts:158` sanitizes front-channel payloads and delegates final replies through the shared durable message batch sender.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/outbound-adapter.ts:106` exposes Discord direct delivery capabilities, text chunker, sanitizer, durable-final capability flags, and send hooks.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/outbound-adapter.ts:167` wraps direct text sends with `withDiscordDeliveryRetry` and preserves webhook/thread identity when available.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/delivery-retry.ts:10` defines Discord delivery retry defaults and transient retry classification for 429 and 5xx REST failures.
- `/Users/kevinlin/code/openclaw/src/channels/turn/durable-delivery.ts:126` implements final-only durable inbound reply delivery through `sendDurableMessageBatch`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/channel.ts:85` registers the Discord message adapter with draft preview, preview finalization, progress updates, and durable-final capabilities.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/parallels/macos-discord.ts:27` configures Discord in a macOS guest, runs `doctor --fix`, restarts the gateway, probes channel status, sends a real Discord message, waits for host API visibility, posts host inbound, and reads the message back in the guest.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:49` defines live Discord scenarios for canary replies, mention gating, thread reply file attachments, and status reactions.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:289` checks that a Discord canary driver mention receives the expected marker reply from the system under test.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:356` covers thread reply filePath attachment behavior in the live Discord runtime.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/live-smoke.live.test.ts:7` provides a gated live smoke for resolving bot identity and gateway metadata.
- `/Users/kevinlin/code/openclaw/scripts/dev/discord-acp-plain-language-smoke.ts:685` sends a live driver message through Discord token/webhook/OpenClaw CLI paths and validates returned message ids.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.process.test.ts:1848` covers runtime-flow finalization through preview edit when the final response fits a single chunk.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.process.test.ts:1866` covers progress streaming into Discord draft previews and final preview edit behavior.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.process.test.ts:1981` covers multi-chunk final fallback to standard delivery.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.process.test.ts:2036` covers draft cleanup when fallback final delivery fails.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.process.test.ts:2088` covers explicit reply-tag fallback to standard delivery.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.process.test.ts:2109` covers media final fallback to normal delivery and draft cleanup.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/reply-delivery.test.ts:107` covers the bridge from regular Discord replies to shared outbound with `replyToMode`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/reply-delivery.test.ts:469` covers bound thread replies rewriting parent target, thread, persona, and session context.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/durable-delivery.test.ts:43` covers durable final delivery fanning out planned chunks and retrying a transient second-chunk failure.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/discord/src/channel.message-adapter.test.ts:78` proves durable-final capability flags for text, media, poll, payload, silent, replyTo, thread, and hooks.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/channel.message-adapter.test.ts:227` proves live preview and finalizer capabilities.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/draft-stream.test.ts:26` covers preview create/edit on the same message with reply references.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/draft-stream.test.ts:60` covers preview mention suppression with `allowed_mentions`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/draft-stream.test.ts:91` covers preview link embed suppression.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.sends-basic-channel-messages.test.ts:196` covers basic sends and default embed suppression.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.sends-basic-channel-messages.test.ts:221` covers per-message and per-account `suppressEmbeds` overrides.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.sends-basic-channel-messages.test.ts:269` covers silent sends and explicit embed sends.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.sends-basic-channel-messages.test.ts:304` covers mention rewrite through cache, aliases, and default account selection.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.sends-basic-channel-messages.test.ts:384` covers forum auto-thread delivery and long forum follow-up chunking.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.sends-basic-channel-messages.test.ts:455` covers user DM and bare numeric targets.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.sends-basic-channel-messages.test.ts:491` covers missing permission hints.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.sends-basic-channel-messages.test.ts:559` covers media delivery.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.sends-basic-channel-messages.test.ts:663` covers reply references across chunks and media caption split follow-ups.

### Gitcrawl queries

- `gitcrawl doctor --json` verified gitcrawl `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, and `repository_count=2`.
- `gitcrawl search issues "Discord outbound message delivery chunk replyToMode suppressEmbeds mentions retry" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20` returned no direct hits.
- `gitcrawl search issues "Discord preview streaming progress draft edit final delivery" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20` returned one Mattermost false-positive, not Discord outbound evidence.
- `gitcrawl search issues "Discord delivery failed reply duplicate missing permissions chunk embeds" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20` returned no direct hits.
- `gitcrawl search issues "Discord durable delivery retry outbound message send" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20` returned `#85422`, a model fallback issue with channel symptoms but not a Discord outbound root cause.
- `gitcrawl search openclaw/openclaw --query "Discord replyToMode" --json` surfaced `#51534` requesting explicit mention injection for guild replies, `#80234` on implicit bot reply mentions, `#74077` on preview streaming mode commands, and related routing/config issues.
- `gitcrawl search openclaw/openclaw --query "Discord suppressEmbeds" --json` returned no hits.
- `gitcrawl search openclaw/openclaw --query "Discord streaming progress draft" --json` surfaced `#83307` assistant commentary in progress drafts, `#85465` progress final/status command output fixes, `#83983` reasoning stream overwrite, `#78561` misleading partial/block fragments, and `#87704` progress mode dead-air behavior.
- `gitcrawl search openclaw/openclaw --query "Discord outbound delivery" --json` surfaced `#84952` cron announce failure through Discord voice outbound adapter, `#56610` delivery queue/retry on WebSocket reconnect, `#81226` missed-message backfill after reconnect, `#39847` metadata leak in outbound delivery, `#80445` duplicate visible `message.send` deliveries, and related delivery/routing hardening issues.
- `gitcrawl threads openclaw/openclaw --numbers 51534,80234,83307,83983,78561,87704,56610,84952,39847,85465 --include-closed --json` confirmed open reports for reply mention ambiguity, progress draft/rendering gaps, reconnect delivery loss, TTS/voice outbound failure, and metadata leakage.
- `gitcrawl threads openclaw/openclaw --numbers 84952,85422,80445,81226 --include-closed --json` confirmed the voice/TTS outbound adapter failure and reconnect/duplicate-delivery concerns, with some PR evidence explicitly described as non-production proof.

### Discrawl queries

- `discrawl status --json` was verified live during this audit. The requested recorded freshness is kept exactly in Archive Freshness; live status also reported state `current`, the same sync/count fields, and share remote `git@github.com-personal:openclaw/discord-store.git`.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "Discord outbound delivery"` found recent operational discussion of Discord TTS saying a local opus file was created while `lastOutboundAt` did not change and no Discord outbound/media send appeared in gateway logs; it also found older upgrade/reconnect reports, a beta2 inbound/outbound visible reply pass, and GitHub comments closing shared outbound pipeline and restart-safe dispatcher work.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "Discord replyToMode"` found PR discussion that `replyToMode: "all"` no longer consumes reply state, user configs setting `replyToMode: "off"` to avoid native reply pings, and related route resolver discussion.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "Discord progress draft"` found current discussion about Discord streaming commentary in `mode: "progress"`, closed issues for live tool/progress draft previews and final preview edits, and older history showing streaming-mode config migration from legacy `streamMode`.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "Discord delivery retry queue"` found closed duplicate delivery/retry hardening work, the open reconnect queue/retry issue, and older delivery-queue references for pending outbound recovery.
