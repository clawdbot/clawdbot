---
title: "Discord - Media and Rich Content Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Discord - Media and Rich Content Maturity Note

## Summary

Discord media handling is broad and actively maintained: normal file uploads,
component file blocks, media-gallery blocks, video caption splitting, and
Discord voice-message uploads all have explicit source paths and focused unit
coverage. Coverage is Beta because the located proof is mostly adapter/runtime
tests plus release-channel evidence, not repeated live Discord scenario proof for
all media shapes. Quality is Beta because source contracts are clear and
security posture is reasonable, but archive history still shows media delivery
regressions as an active release concern.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Media and Rich Content`
- Merged from: `Message and Media Delivery`
- Score carry-forward: conservative minimum of merged source category scores.

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
- Direct and thread sends: Covers Direct and thread sends across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior
- Text chunking and reply mode: Covers Text chunking and reply mode across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior
- Draft and progress edits: Covers Draft and progress edits across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior
- Mention and embed rendering: Covers Mention and embed rendering across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior
- REST retry and final delivery: Covers REST retry and final delivery across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior
- File uploads: Outbound file uploads from URLs and local paths, including delivery constraints and follow-up behavior
- Component file and media-gallery blocks: Component v2 file and media-gallery blocks for Discord media delivery
- Video caption follow-up: Video caption handling and follow-up media-only delivery in Discord conversations
- Voice-message upload: Discord voice-message sends with OGG/Opus conversion, waveform generation, duration metadata, and upload URL handling
- Inbound attachment context: Inbound attachment context made available to Discord replies and agent turns
- Outbound file uploads from URLs and: Covers Outbound file uploads from URLs and local paths behavior.
- Component v2 file and media-gallery blocks: Evidence scope for Component v2 file and media-gallery blocks
- Video caption handling and follow-up media-only delivery: Evidence scope for Video caption handling and follow-up media-only delivery
- Discord voice-message sends with OGG/Opus conversion: Covers Discord voice-message sends with OGG/Opus conversion, waveform generation behavior.
- Inbound media/attachment-aware debounce behavior: Evidence scope for Inbound media/attachment-aware debounce behavior
- Realtime voice-channel conversations: Covers Realtime voice-channel conversations, which are scored in the separate behavior.
- General text-only delivery: Covers General text-only delivery, component callback authorization, and channel behavior.

## Features

- Media and Rich Content: Evidence scope for Media and Rich Content.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals:
  - Docs cover component file blocks, attachment references, media-gallery blocks, and filename override behavior.
  - Docs cover Discord voice-message constraints: local file path only, no text content, OGG/Opus conversion, waveform preview, and `ffmpeg`/`ffprobe` dependency.
  - Source has a shared outbound media path that loads media through the plugin SDK, resolves filenames, builds multipart Discord file payloads, preserves reply targets, and sends follow-up text chunks after the first media caption.
  - Source has a dedicated voice-message path for URL/protocol rejection before ffmpeg/ffprobe, 48 kHz OGG/Opus normalization, waveform generation, Discord upload URL negotiation, rate-limit parsing, and SSRF-guarded upload requests.
  - Unit tests cover voice-message conversion constraints, voice upload retry on rate limits, `audioAsVoice` routing, reply preservation for voice sends, video caption splitting, component media access forwarding, and component file block handling.
- Negative signals:
  - Located live Discord QA evidence does not prove every media shape end to end against real Discord: normal file upload, component file block, media-gallery, large media cap, video caption, and voice-message upload.
  - Gitcrawl did not return a focused issue cluster for Discord media queries, but Discrawl release and maintainer catch-up reports still call message delivery/media regressions a hot area.
  - Inbound attachment handling is present for debounce and context, but the located evidence is source-level and focused tests rather than live inbound attachment-to-agent proof.
- Integration gaps:
  - Add live Discord QA for sending one image, one document, one video with caption, one component file block, one media gallery, and one voice message.
  - Add a real Discord failure-path scenario for oversized media and invalid local voice-message paths.
  - Add live inbound proof that attached files and voice-message-like media enter the agent context with the expected provenance and privacy boundaries.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports:
  - `gitcrawl search issues 'discord media OR discord attachment OR discord voice message OR discord transcribe OR discord audio' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20` returned open #40078, "Silent preflight transcription in requireMention channels", which is adjacent to media/audio preflight behavior.
  - `gitcrawl search issues '"failed-silent media" OR "media replies" OR "voice message" OR "audioAsVoice" OR "Discord voice message"' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20` returned no focused issues.
  - `gitcrawl search issues '"Discord" "media" OR "Discord" "attachment" OR "Discord" "voice" OR "media reply" OR "failed-silent"' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 40` returned no focused issues.
- Discrawl reports:
  - `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord voice message"` returned recent release discussion asking testers to exercise Discord voice and calling out Discord voice/model-picker improvements.
  - `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord media"` returned release notes for 2026.5.26 saying channel polish included WhatsApp group/media fixes and Discord voice/model-picker/caption/proxy fixes, plus media pipeline improvements through Rastermill.
  - `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "failed silent media replies Discord"` returned a maintainer catch-up note saying message delivery/media/duplicate-generation regressions remained hot and specifically mentioned failed-silent media replies.
  - `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "discord attachment"` returned general attachment/privacy discussion and release notes that grouped channel reliability and media provenance work.
- Good qualities:
  - Media loading is centralized through plugin SDK media helpers, which keeps local path access and byte caps outside ad hoc Discord-only file reads.
  - Voice-message conversion rejects URL/protocol inputs before passing paths to ffmpeg/ffprobe and stages ffmpeg output through a safe write helper.
  - Voice-message upload uses SSRF-guarded fetches for Discord attachment upload URLs and parses rate-limit responses into the shared Discord rate-limit error shape.
  - Docs are explicit about Discord voice-message constraints that commonly surprise operators: local path only and no simultaneous text content.
  - Component file attachments use Discord's `attachment://` reference model instead of silently guessing which media file a component should render.
- Bad qualities:
  - Recent release/archive notes still treat media delivery as a hot regression class, so the implementation is not yet operationally boring.
  - Voice messages depend on host `ffmpeg` and `ffprobe`; docs explain the dependency, but operator failure modes remain more brittle than ordinary file sends.
  - Live proof for component media, video captioning, and voice-message upload is not yet visible in the maintained Discord scenario set.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test presence or absence were not used to raise or lower Quality.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/discord.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Media and Rich Content.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Build a maintained live Discord media scenario matrix covering file, image,
  video, component file, media gallery, and voice-message sends.
- Add inbound attachment/media proof for model context and provenance.
- Improve operator-facing diagnostics for missing ffmpeg/ffprobe and rejected
  remote voice-message sources.
- Keep media delivery regressions visible in release scenario proof until
  archive traffic stops treating them as hot.

## Evidence

### Docs

- `docs/channels/discord.md:320` says Discord forum and media channels only accept thread posts and documents thread creation paths.
- `docs/channels/discord.md:347` lists supported component blocks, including `media-gallery` and `file`.
- `docs/channels/discord.md:359` documents file blocks, `attachment://<filename>` references, `media`/`path`/`filePath`, and filename overrides.
- `docs/channels/discord.md:1501` documents Discord voice messages, OGG/Opus conversion, waveform generation, local-path-only input, no text content, and `asVoice=true`.
- `docs/channels/discord.md:1719` lists `mediaMaxMb` as the outbound Discord upload cap.

### Source

- `extensions/discord/src/send.shared.ts:375` loads outbound media with `loadWebMedia` and SDK media access options.
- `extensions/discord/src/send.shared.ts:379` resolves upload filenames from explicit filename, media metadata, MIME extension, or a fallback.
- `extensions/discord/src/send.shared.ts:400` builds a Discord message request with text, components, embeds, flags, reply target, and multipart file payload.
- `extensions/discord/src/send.shared.ts:413` sends the first media message and then sends non-empty follow-up text chunks after the media caption.
- `extensions/discord/src/voice-message.ts:200` rejects URL/protocol voice-message inputs before ffmpeg/ffprobe.
- `extensions/discord/src/voice-message.ts:211` fast-paths OGG files only when ffprobe confirms Opus at 48 kHz.
- `extensions/discord/src/voice-message.ts:241` converts other audio to 48 kHz OGG/Opus through bounded ffmpeg execution.
- `extensions/discord/src/voice-message.ts:270` computes duration and waveform metadata.
- `extensions/discord/src/voice-message.ts:322` requests Discord attachment upload URLs for voice-message files.
- `extensions/discord/src/monitor/message-handler.ts:152` treats inbound messages with attachments or stickers as media-bearing for debounce decisions.

### Integration tests

- `extensions/qa-lab/src/mantis/discord-smoke.runtime.ts` defines a live Discord smoke runtime, but the located scenario set is broader channel/voice oriented and does not prove every media shape in this component.
- No located live/e2e test proves component file blocks, media-gallery uploads, large media rejection, video caption split, and voice-message upload against real Discord in one maintained scenario.

### Unit tests

- `extensions/discord/src/outbound-adapter.test.ts:310` covers `audioAsVoice` routing through the Discord voice send helper plus follow-up media sends.
- `extensions/discord/src/outbound-adapter.test.ts:363` and `extensions/discord/src/outbound-adapter.test.ts:388` cover reply preservation for voice-message payloads.
- `extensions/discord/src/outbound-adapter.test.ts:413` covers video captions being sent as text before a media-only video follow-up.
- `extensions/discord/src/send.components.test.ts:262` covers media access forwarding to the classic Discord send path.
- `extensions/discord/src/send.components.test.ts:373` covers spoiler file blocks staying on the component path.
- `extensions/discord/src/voice-message.test.ts:75` covers rejection of URL/protocol voice-message inputs.
- `extensions/discord/src/voice-message.test.ts:82` and `extensions/discord/src/voice-message.test.ts:105` cover OGG/Opus fast path and 48 kHz re-encoding behavior.
- `extensions/discord/src/voice-message.test.ts:189` covers voice upload retry behavior when the CDN upload is rate limited.

### Gitcrawl queries

Query:

- `gitcrawl search issues 'discord media OR discord attachment OR discord voice message OR discord transcribe OR discord audio' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`

Results:

- Returned open #40078, "Silent preflight transcription in requireMention channels", an adjacent audio/media preflight request rather than a direct outbound media failure.

Query:

- `gitcrawl search issues '"failed-silent media" OR "media replies" OR "voice message" OR "audioAsVoice" OR "Discord voice message"' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`

Results:

- Returned no focused issues.

Query:

- `gitcrawl search issues '"Discord" "media" OR "Discord" "attachment" OR "Discord" "voice" OR "media reply" OR "failed-silent"' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 40`

Results:

- Returned no focused issues.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord voice message"`

Results:

- Returned recent release/tester discussion calling out Discord voice as a feature to exercise and describing voice/model-picker fixes.

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord media"`

Results:

- Returned 2026.5.26 release notes describing broader media pipeline improvements and Discord voice/model-picker/caption/proxy fixes.

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "failed silent media replies Discord"`

Results:

- Returned a maintainer catch-up note saying message delivery/media/duplicate-generation regressions remained hot and mentioning failed-silent media replies.

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "discord attachment"`

Results:

- Returned attachment/privacy discussion and release notes referencing media provenance/channel reliability work.
