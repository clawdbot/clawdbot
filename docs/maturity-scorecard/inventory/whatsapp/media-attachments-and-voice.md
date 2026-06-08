---
title: "WhatsApp - Media and Rich Content Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# WhatsApp - Media and Rich Content Maturity Note

## Summary

WhatsApp media attachments and voice are Beta for Coverage and Stable for
Quality. Source contracts are strong for inbound downloads, quoted media,
outbound image/audio/video/document payloads, voice-note conversion, media caps,
filename handling, and local-root safety. Coverage stays Beta because current
live proof does not span the full media matrix.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Media and Rich Content`
- Merged from: `Media Attachments`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Inbound media download: Inbound media download and placeholder construction, quoted media extraction, and file handoff.
- Outbound image: Outbound image, audio, video, document, and voice-note payload construction.

## Features

- Inbound media download: Inbound media download and placeholder construction, quoted media extraction, and file handoff.
- Outbound image: Outbound image, audio, video, document, and voice-note payload construction.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: docs describe inbound media, quoted media, outbound media,
  size limits, captions, fallbacks, and troubleshooting; source has explicit
  contracts for inbound and outbound media and unit/runtime tests across common
  payload types.
- Negative signals: Gitcrawl and Discrawl returned no current media-specific
  hits, and the strongest evidence is source/test-contract based rather than
  current live WhatsApp media runs.
- Integration gaps: no located live matrix proves inbound image/document/audio,
  quoted media, outbound image/audio/video/document, voice-note conversion, and
  oversize fallback together.

## Quality Score

- Score: `Stable (80%)`
- Gitcrawl reports: `whatsapp media voice note document image` returned no hits.
- Discrawl reports: `whatsapp media voice note document image` returned `null`.
- Good qualities: media boundaries are explicit, inbound download sizes are
  capped, local file loading is rooted, text is sanitized, voice conversion is
  isolated behind media contracts, filenames are normalized, and retryable
  outbound media failures are handled separately.
- Bad qualities: live provider acceptance is still Baileys/WhatsApp dependent,
  voice notes depend on host media tooling, and operator docs do not enumerate a
  current live media compatibility matrix.
- Excluded from quality: unit, integration, e2e, live, and real runtime-flow
  test coverage did not raise or lower this Quality score.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/whatsapp.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Inbound media download, Outbound image.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add recurring live proof for inbound and outbound image, audio, voice, video,
  document, quoted media, and oversize fallback.
- Document the practical media compatibility matrix, including host ffmpeg
  expectations for voice-note conversion.
- Improve operator diagnostics for provider-accepted media versus media rejected
  by WhatsApp/Baileys.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:330` documents inbound envelope construction, quoted media, media placeholders, group history, and read receipts.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:421` documents outbound media behavior, text chunking, size limits, and fallback behavior.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:455` documents reply quoting, reactions, and status/ack reactions.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:669` documents provider acceptance troubleshooting.

### Source

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/media.ts:51` downloads inbound media with max-byte limits and MIME fallback.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/media.ts:103` downloads quoted media.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/extract.ts:270` builds media placeholders for inbound context.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/outbound-media-contract.ts:65` sanitizes text for outbound media.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/outbound-media-contract.ts:84` resolves media URLs and local media payloads.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/outbound-media-contract.ts:114` builds image, audio, video, document, and voice Opus payloads.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/outbound-media-contract.ts:209` handles ffmpeg transcode for voice payloads.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/outbound-media-contract.ts:269` handles retryable outbound media behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/outbound-media.runtime.ts:3` loads outbound media from URL and local roots.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/monitor-inbox.captures-media-path-image-messages.test-support.ts:1` supports media-path image message capture.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply/deliver-reply.test.ts:514` covers media replies in the delivery pipeline.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply.web-auto-reply.compresses-common-formats-jpeg-cap.test.ts:1` covers compression behavior for common formats.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/whatsapp/whatsapp-live.runtime.ts:1192` runs the live WhatsApp QA driver and artifact flow.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/media.test.ts:97` covers media fetch, optimization, SSRF/local roots, and caps.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/media.node.test.ts:1` covers Node inbound media behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound.media.test.ts:1` covers inbound media behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/document-filename.test.ts:1` covers document filename normalization.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/send-api.test.ts:58` covers media, mentions, PTT audio, polls/reactions, newsletter, quoted remoteJid, and LID routing.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "whatsapp media voice note document image" --json`

Results:

- Returned no hits.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl --json search "whatsapp media voice note document image" --limit 5`

Results:

- Returned `null`.
