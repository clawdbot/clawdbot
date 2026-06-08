---
title: "Media understanding and media generation - Video Understanding and Direct Video Analysis Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Media understanding and media generation - Video Understanding and Direct Video Analysis Maturity Note

## Summary

Video understanding exists as a shared media-understanding capability with provider registration, CLI-style describe paths, Qwen/Google/Moonshot provider support, size limits, and reply-context insertion. It remains alpha-quality because direct video upload parity and client-path support are explicitly still uneven in the archives.

## Category Scope

This category covers video summarization before reply routing, provider/CLI video media entries, size and timeout controls, proxy support, video request construction, and direct video analysis paths. It does not score video generation.

## Features

- Video Understanding: Covers Video Understanding across video summarization before reply routing, provider/CLI video media entries, size and timeout controls, proxy support, video request construction, and direct video analysis paths. It does not score video generation.
- Direct Video Analysis: Covers Direct Video Analysis across video summarization before reply routing, provider/CLI video media entries, size and timeout controls, proxy support, video request construction, and direct video analysis paths. It does not score video generation.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: Docs and source describe video media-understanding models, provider support, size caps, proxy support, and fallback behavior. Tests cover runner video behavior and provider request construction.
- Negative signals: Video is newer and narrower than image/audio; direct video upload through chat/message upload surfaces is explicitly not uniformly implemented.
- Integration gaps: The strongest evidence is source and targeted tests, with less recurring scenario proof across Control UI, WebChat, channel uploads, and provider-specific video models.

## Quality Score

- Score: `Alpha (62%)`
- Gitcrawl reports: #27482 remains open for direct video upload through chat/message upload; #38623 was closed as implemented for shared provider video analysis; #78797 tracks native audio/video understanding; #72092/#72031 show auth-mode consistency issues across image/audio/video paths.
- Discrawl reports: Archive result on #27482 says current main has video media-understanding plumbing and CLI `video describe`, but Control UI and gateway attachment paths remain image-oriented and drop or coerce non-image attachments.
- Good qualities: Provider support is explicit, fallback/skip behavior is shared with the media runner, and the feature reuses best-effort media-understanding semantics instead of blocking replies.
- Bad qualities: User-facing video behavior is fragmented: provider analysis exists, but upload/attachment surfaces and client parity lag behind the core runner.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow test presence or absence.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/media-understanding-and-media-generation.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Video Understanding, Direct Video Analysis.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Direct video upload via chat/message surfaces is still not consistently available.
- Provider-specific constraints and upload forms are not yet hidden behind a stable user path.
- The docs explain configuration, but they do not present a broad operator scorecard for video attachment support by client/channel.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/nodes/media-understanding.md` documents `tools.media.video`, provider/CLI entries, video maxBytes defaults, provider support matrix, and proxy support.
- `/Users/kevinlin/code/openclaw/docs/tools/media-overview.md` lists video media understanding in the capability matrix.
- `/Users/kevinlin/code/openclaw/docs/nodes/images.md` describes image/video descriptions preserving captions for command parsing in the inbound media pipeline.

### Source

- `/Users/kevinlin/code/openclaw/src/media-understanding/video.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/openai-compatible-video.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/runner.video.test.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/entry-capabilities.ts`
- `/Users/kevinlin/code/openclaw/src/media/video-dimensions.ts`
- `/Users/kevinlin/code/openclaw/src/media/ffmpeg-exec.ts`

### Integration tests

- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/get-reply-run.media-only.test.ts` includes media-only reply-run handling relevant to video attachment preservation.
- `/Users/kevinlin/code/openclaw/src/cli/program.nodes-media.e2e.test.ts` covers CLI media node paths.
- `/Users/kevinlin/code/openclaw/src/gateway/control-ui-assistant-media.e2e.test.ts` covers Control UI assistant media, though archive evidence says direct video upload remains weaker than image.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/media-understanding/runner.video.test.ts`
- `/Users/kevinlin/code/openclaw/src/media/video-dimensions.test.ts`
- `/Users/kevinlin/code/openclaw/src/media/ffmpeg-exec.test.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/runtime.test.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/provider-capability-registry.test.ts`

### Gitcrawl queries

Query:

```bash
gitcrawl search openclaw/openclaw --query "video media understanding" --json
```

Results:

- Returned #78797 native audio/video understanding, #75005 plugin/no-auth media providers, #73817 private endpoints, #27482 direct video upload, #72092 auth mode for image and audio/video, #62924 chosen model reporting, and #38623 direct video upload/model support context.

### Discrawl queries

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "video media understanding" --limit 5
```

Results:

- Returned #38623 closed as implemented for shared media-understanding provider video analysis and Qwen registration.
- Returned #27482 review stating video media-understanding and CLI `video describe` exist, but Control UI and Gateway attachment paths remain image-oriented for direct upload.
