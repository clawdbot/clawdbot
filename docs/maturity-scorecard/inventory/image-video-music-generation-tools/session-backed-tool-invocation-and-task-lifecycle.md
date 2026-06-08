---
title: "Image/video/music generation tools - Task Lifecycle and Delivery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Image/video/music generation tools - Task Lifecycle and Delivery Maturity Note

## Summary

The session-backed invocation path is implemented as a shared media task
lifecycle. The media tools can start background generation, record task
metadata, send keepalives, support duplicate-safe status checks, wake the
conversation on completion or failure, and use a direct fallback when generated
media was not delivered through the message tool.

Coverage is Stable because docs, source, and tests cover the lifecycle across
task creation, completion, failure, and fallback delivery. Quality is Alpha
because recent archive reports still show generated media success can look like
failure when the completion delivery path breaks or when deferred media tools
are not visible enough to the agent.

## Category Scope

Included in this category:

- background task creation: Covers background task creation across `image_generate`, `video_generate`, and `music_generate` tool exposure, background task scheduling, and related async task lifecycle behavior.
- task status/list/show/cancel: Covers task status/list/show/cancel across `image_generate`, `video_generate`, and `music_generate` tool exposure, background task scheduling, and related async task lifecycle behavior.
- duplicate guards: Covers duplicate guards across `image_generate`, `video_generate`, and `music_generate` tool exposure, background task scheduling, and related async task lifecycle behavior.
- progress keepalive: Covers progress keepalive across `image_generate`, `video_generate`, and `music_generate` tool exposure, background task scheduling, and related async task lifecycle behavior.
- completion/failure wake: Covers completion/failure wake across `image_generate`, `video_generate`, and `music_generate` tool exposure, background task scheduling, and related async task lifecycle behavior.
- no-session inline fallback: Covers no-session inline fallback across `image_generate`, `video_generate`, and `music_generate` tool exposure, background task scheduling, and related async task lifecycle behavior.
- local media persistence: Covers local media persistence across generated image/audio/video artifact objects, MIME and filename inference, local media paths, hosted media URLs, and related generated media delivery behavior.
- MIME/filename inference: Covers MIME/filename inference across generated image/audio/video artifact objects, MIME and filename inference, local media paths, hosted media URLs, and related generated media delivery behavior.
- Hosted URL fallback: Covers hosted URL fallback across generated image/audio/video artifact objects, MIME and filename inference, local media paths, hosted media URLs, and related generated media delivery behavior.
- message-tool handoff: Covers message-tool handoff across generated image/audio/video artifact objects, MIME and filename inference, local media paths, hosted media URLs, and related generated media delivery behavior.
- idempotent missing-media fallback: Covers idempotent missing-media fallback across generated image/audio/video artifact objects, MIME and filename inference, local media paths, hosted media URLs, and related generated media delivery behavior.
- channel attachment proof: Covers channel attachment proof across generated image/audio/video artifact objects, MIME and filename inference, local media paths, hosted media URLs, and related generated media delivery behavior.

## Features

- background task creation: Covers background task creation across `image_generate`, `video_generate`, and `music_generate` tool exposure, background task scheduling, and related async task lifecycle behavior.
- task status/list/show/cancel: Covers task status/list/show/cancel across `image_generate`, `video_generate`, and `music_generate` tool exposure, background task scheduling, and related async task lifecycle behavior.
- duplicate guards: Covers duplicate guards across `image_generate`, `video_generate`, and `music_generate` tool exposure, background task scheduling, and related async task lifecycle behavior.
- progress keepalive: Covers progress keepalive across `image_generate`, `video_generate`, and `music_generate` tool exposure, background task scheduling, and related async task lifecycle behavior.
- completion/failure wake: Covers completion/failure wake across `image_generate`, `video_generate`, and `music_generate` tool exposure, background task scheduling, and related async task lifecycle behavior.
- no-session inline fallback: Covers no-session inline fallback across `image_generate`, `video_generate`, and `music_generate` tool exposure, background task scheduling, and related async task lifecycle behavior.
- local media persistence: Covers local media persistence across generated image/audio/video artifact objects, MIME and filename inference, local media paths, hosted media URLs, and related generated media delivery behavior.
- MIME/filename inference: Covers MIME/filename inference across generated image/audio/video artifact objects, MIME and filename inference, local media paths, hosted media URLs, and related generated media delivery behavior.
- Hosted URL fallback: Covers hosted URL fallback across generated image/audio/video artifact objects, MIME and filename inference, local media paths, hosted media URLs, and related generated media delivery behavior.
- message-tool handoff: Covers message-tool handoff across generated image/audio/video artifact objects, MIME and filename inference, local media paths, hosted media URLs, and related generated media delivery behavior.
- idempotent missing-media fallback: Covers idempotent missing-media fallback across generated image/audio/video artifact objects, MIME and filename inference, local media paths, hosted media URLs, and related generated media delivery behavior.
- channel attachment proof: Covers channel attachment proof across generated image/audio/video artifact objects, MIME and filename inference, local media paths, hosted media URLs, and related generated media delivery behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (80%)`
- Positive signals: Shared lifecycle source and tests cover task start, active-task status, wake delivery, failure delivery, and direct generated-media fallback.
- Negative signals: Coverage is concentrated in the shared lifecycle and delivery helpers; channel-specific runtime proof and full end-to-end user workflows remain thinner.
- Integration gaps: Add a channel-level media generation scenario that verifies the task ledger, completion wake, message-tool attachment evidence, and fallback non-duplication in one flow.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: Searches returned #86279 on keeping media generation success despite delivery failure, #86034 where generation succeeded but completion delivery looked like failure, and #77265 where `agent --deliver` returned a media URL without delivering Telegram media.
- Discrawl reports: Discord search found generated-media completion reports where media handoff routed back but channel delivery was flaky or fell back to a generated filename/path.
- Good qualities: The lifecycle is shared across image, video, and music, with idempotency keys and missing-media detection to reduce duplicate or lost deliveries.
- Bad qualities: The user-visible operation still depends on multi-step wake, message-tool evidence, and channel delivery state, so a provider success can be obscured by delivery behavior.
- Excluded from quality: Unit, integration, live, and QA test breadth were treated as Coverage inputs only; tests did not raise or lower this Quality score.

## Completeness Score

- Score: `Stable (80%)`
- Surface instructions: evaluated against `references/completeness/image-video-music-generation-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for background task creation, task status/list/show/cancel, duplicate guards, progress keepalive, completion/failure wake, no-session inline fallback, local media persistence, MIME/filename inference, Hosted URL fallback, message-tool handoff, idempotent missing-media fallback, channel attachment proof.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- A provider can complete successfully while user-visible delivery still fails or looks failed.
- Deferred media tool affordances can keep the tool from being invoked in the first place.
- The lifecycle has several recovery paths, which improves resilience but increases operator diagnostic complexity.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/media-overview.md:88` explains async versus synchronous media generation and fallback delivery.
- `/Users/kevinlin/code/openclaw/docs/tools/image-generation.md:11` describes image generation as an asynchronous background task with completion delivery.
- `/Users/kevinlin/code/openclaw/docs/tools/video-generation.md:57` documents async video generation flow, task id, wake, message tool, fallback, and storage.
- `/Users/kevinlin/code/openclaw/docs/tools/video-generation.md:86` documents task lifecycle and status.
- `/Users/kevinlin/code/openclaw/docs/tools/music-generation.md:15` documents background task, ledger, wake, message-tool delivery, and fallback.
- `/Users/kevinlin/code/openclaw/docs/tools/music-generation.md:185` documents async behavior, duplicate prevention, status, and no-session fallback.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/openclaw-tools.media-factory-plan.ts:167` gates optional image, video, and music tools.
- `/Users/kevinlin/code/openclaw/src/agents/tools/media-generate-background-shared.ts:103` creates task runs and records media task metadata.
- `/Users/kevinlin/code/openclaw/src/agents/tools/media-generate-background-shared.ts:176` sends progress keepalives.
- `/Users/kevinlin/code/openclaw/src/agents/tools/media-generate-background-shared.ts:200` completes or fails task runs.
- `/Users/kevinlin/code/openclaw/src/agents/tools/media-generate-background-shared.ts:254` builds message-tool-required completion instructions.
- `/Users/kevinlin/code/openclaw/src/agents/tools/media-generate-background-shared.ts:350` schedules background completion and wake delivery.
- `/Users/kevinlin/code/openclaw/src/agents/tools/media-generate-tool-actions-shared.ts:118` returns active task status and duplicate guard results.
- `/Users/kevinlin/code/openclaw/src/agents/subagent-announce-delivery.ts:770` directly sends generated media when the announce agent does not deliver it.

### Integration tests

- `/Users/kevinlin/code/openclaw/qa/scenarios/media/native-image-generation.md:4` defines a native image generation scenario with tool inventory and saved-media success criteria.
- `/Users/kevinlin/code/openclaw/qa/scenarios/media/image-generation-roundtrip.md:4` verifies generated media can be reattached and described.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/tools/media-generate-background-shared.test.ts:14` keeps a generated-media task active until wake delivery completes.
- `/Users/kevinlin/code/openclaw/src/agents/tools/media-generate-background-shared.test.ts:78` fails the task when completion delivery cannot be confirmed.
- `/Users/kevinlin/code/openclaw/src/agents/tools/media-generate-background-shared.test.ts:129` covers wake failure behavior.
- `/Users/kevinlin/code/openclaw/src/agents/subagent-announce-delivery.test.ts:2247` avoids fallback when message-tool evidence includes generated media.
- `/Users/kevinlin/code/openclaw/src/agents/subagent-announce-delivery.test.ts:2289` covers music completion DMs requiring the message tool.
- `/Users/kevinlin/code/openclaw/src/agents/subagent-announce-delivery.test.ts:2393` covers image completion DMs requiring the message tool.
- `/Users/kevinlin/code/openclaw/src/agents/subagent-announce-delivery.test.ts:2826` covers direct delivery after active wake failure.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "image_generate video_generate music_generate background task completion delivery" --json`

Results:

- Returned #86279 on keeping media generation success when completion delivery fails.

Query: `gitcrawl search openclaw/openclaw --query "generated media delivery message tool completion" --json`

Results:

- Returned #86279, #87741 on fallback after generated media handoff locks, #74041 on routing generated media through assistant delivery, and #86034 on generation success looking like completion delivery failure.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "generated media completion delivery"`

Results:

- Found maintainer discussion on generated-media handoff locks, flaky media delivery, fallback to filename/path output, and duplicate generated-media delivery fixes.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "music_generate"`

Results:

- Found maintainer discussion on deferred media tools, including `music_generate`, needing stronger discoverability.
