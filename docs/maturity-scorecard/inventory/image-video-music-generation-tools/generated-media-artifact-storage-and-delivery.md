---
title: "Image/video/music generation tools - Generated Media Delivery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Image/video/music generation tools - Generated Media Delivery Maturity Note

## Summary

Generated media delivery has a real shared architecture: generated image,
audio, and video assets carry buffers, paths, URLs, MIME metadata, filenames,
and message attachment lines; completion delivery is routed through a
message-tool-required handoff; direct fallback sends missing media with an
idempotency key.

Coverage is Beta because source and tests cover asset extraction and delivery
fallbacks, but full channel-level artifact storage and delivery proof is uneven.
Quality is Alpha because recent GitHub and Discord archives show media handoff
locks, delivery failure after provider success, duplicate fallback concerns, and
missing message-tool delivery evidence.

## Category Scope

This category covers generated image/audio/video artifact objects, MIME and
filename inference, local media paths, hosted media URLs, generated attachment
lines, message-tool-required completion handoff, direct fallback delivery,
idempotency, missing-media detection, and active requester wake behavior.

## Features

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

- Score: `Beta (78%)`
- Positive signals: Source covers media URL extraction, attachment rendering, image/audio asset shaping, task handoff instructions, fallback delivery, and multiple missing-media delivery cases.
- Negative signals: Most delivery proof is shared helper/unit coverage; fewer scenario-level checks prove actual channel attachment rendering after provider completion.
- Integration gaps: Add channel-specific generated-media proof for image, video, and music that records final message payload evidence and verifies no duplicate fallback delivery.

## Quality Score

- Score: `Alpha (65%)`
- Gitcrawl reports: Delivery searches returned #86279 on preserving generation success when delivery fails, #87741 on fallback after generated-media handoff locks, #86034 on generation success looking like failure, #74041 on routing generated media through assistant delivery, and #77265 on media URL payloads without Telegram media delivery.
- Discrawl reports: Discord search found generated-media delivery discussions about flaky handoff, fallback to generated filename/path output, and duplicate media delivery fixes.
- Good qualities: The fallback path is explicit, idempotent, and checks for missing generated media instead of blindly duplicating attachments.
- Bad qualities: Delivery depends on task wake, message-tool evidence, channel send behavior, and generated attachment parsing, so it remains one of the highest-risk operational paths.
- Excluded from quality: Unit, integration, live, and QA test breadth were treated as Coverage inputs only; tests did not raise or lower this Quality score.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/image-video-music-generation-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for local media persistence, MIME/filename inference, Hosted URL fallback, message-tool handoff, idempotent missing-media fallback, channel attachment proof.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Successful provider output can still fail to reach the user as a channel attachment.
- The system has recovery logic, but handoff state is difficult to inspect after the fact.
- Some channel-specific delivery bugs are outside the shared provider runtime but still affect the user-perceived maturity of media generation.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/media-overview.md:88` describes async generation and fallback delivery.
- `/Users/kevinlin/code/openclaw/docs/tools/video-generation.md:57` documents managed media storage and URL fallback.
- `/Users/kevinlin/code/openclaw/docs/tools/music-generation.md:15` documents task ledger, wake, message-tool delivery, fallback, and private route warning.
- `/Users/kevinlin/code/openclaw/docs/tools/image-generation.md:11` documents async image generation and message-tool completion delivery.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/generated-attachments.ts:5` defines generated attachment objects.
- `/Users/kevinlin/code/openclaw/src/agents/generated-attachments.ts:15` extracts media URLs.
- `/Users/kevinlin/code/openclaw/src/agents/generated-attachments.ts:40` renders generated attachment lines.
- `/Users/kevinlin/code/openclaw/src/image-generation/image-assets.ts:112` builds generated image assets from base64 data.
- `/Users/kevinlin/code/openclaw/src/music-generation/provider-assets.ts:50` extracts generated music file candidates.
- `/Users/kevinlin/code/openclaw/src/music-generation/provider-assets.ts:78` downloads generated music assets.
- `/Users/kevinlin/code/openclaw/src/agents/tools/media-generate-background-shared.ts:254` builds message-tool-required reply instructions.
- `/Users/kevinlin/code/openclaw/src/agents/subagent-announce-delivery.ts:770` sends direct fallback generated media with an idempotency key.
- `/Users/kevinlin/code/openclaw/src/agents/subagent-announce-delivery.ts:1089` limits direct fallback to inactive or failed-wake paths with missing media.

### Integration tests

- `/Users/kevinlin/code/openclaw/qa/scenarios/media/native-image-generation.md:4` requires generated image media to be saved or delivered.
- `/Users/kevinlin/code/openclaw/qa/scenarios/media/image-generation-roundtrip.md:4` verifies generated media can be reattached and described.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/subagent-announce-delivery.test.ts:2247` avoids direct fallback when generated media was already delivered by the message tool.
- `/Users/kevinlin/code/openclaw/src/agents/subagent-announce-delivery.test.ts:2497` directly delivers generated media when the announce agent replies text-only.
- `/Users/kevinlin/code/openclaw/src/agents/subagent-announce-delivery.test.ts:2590` directly delivers generated media in group completions missing message-tool delivery.
- `/Users/kevinlin/code/openclaw/src/agents/subagent-announce-delivery.test.ts:2714` directly delivers only missing media after partial delivery.
- `/Users/kevinlin/code/openclaw/src/agents/subagent-announce-delivery.test.ts:2774` keeps the active requester path from unnecessary fallback.
- `/Users/kevinlin/code/openclaw/src/agents/subagent-announce-delivery.test.ts:2826` covers direct delivery after active wake failure.
- `/Users/kevinlin/code/openclaw/src/agents/tools/media-generate-background-shared.test.ts:78` fails the task when completion delivery cannot be confirmed.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "generated media delivery message tool completion" --json`

Results:

- Returned #86279, #87741, #74041, #86034, #87466, and #87141 across generated media delivery, fallback, and payload robustness.

Query: `gitcrawl search openclaw/openclaw --query "media generation succeeds completion delivery fails" --json`

Results:

- Returned #86034 on media generation success followed by completion delivery failure.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "generated media completion delivery"`

Results:

- Found maintainer discussion on media handoff locks, fallback after flaky media delivery, filename/path fallback output, and duplicate generated media delivery fixes.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "image_generate"`

Results:

- Found operator reports where generation and delivery failures were difficult to distinguish from provider auth or worker credential issues.
