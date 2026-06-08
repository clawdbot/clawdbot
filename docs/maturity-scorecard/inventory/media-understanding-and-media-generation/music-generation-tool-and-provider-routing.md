---
title: "Media understanding and media generation - Music Generation Tool and Provider Routing Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Media understanding and media generation - Music Generation Tool and Provider Routing Maturity Note

## Summary

Music generation is implemented as a shared async media-generation tool with provider selection, fallback, task status, image-edit modes for capable providers, and direct inline fallback outside session-backed runs. It scores lower than image/video generation because the provider set is smaller, the feature shipped later, and archive records show delivery detachment and prior "not shipped" confusion.

## Category Scope

This category covers `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, provider fallback, background task lifecycle, duplicate task status, no-session inline generation, generated audio persistence, and SDK provider registration.

## Features

- Music generation tool invocation: Covers Music generation tool invocation across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Provider and model selection: Covers Provider and model selection across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Lyrics, instrumental, duration, and format controls: Covers Lyrics, instrumental, duration, and format controls across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Reference inputs where supported: Covers Reference inputs where supported across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Music task lifecycle and duplicate status: Covers Music task lifecycle and duplicate status across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Generated audio persistence and delivery: Covers Generated audio persistence and delivery across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: Docs cover quick start, providers, capability matrix, parameters, async lifecycle, status/list actions, fallback order, and provider notes. Source has dedicated runtime, capability normalization, task lifecycle, status, and SDK surfaces.
- Negative signals: Provider count and modes are narrower than image/video generation, and live proof is less visible.
- Integration gaps: Music delivery through channels has direct archive evidence of completion detachment and attachment handoff issues.

## Quality Score

- Score: `Alpha (64%)`
- Gitcrawl reports: #79535 says OpenRouter video generation silently failed and music generation had not shipped at that point; #84506 asks MiniMax music generation to use async polling; #86034/#86279 show shared media generation delivery failure; #87741 covers generated-media handoff lock fallback.
- Discrawl reports: Multiple clawtributors/maintainers archive messages say `music_generate` completed but visible Discord delivery failed, completion detached, or the local `MEDIA:` artifact was not bridged into message attachment delivery.
- Good qualities: The tool blocks duplicate active calls, exposes task status, warns the completion agent about private final replies, and uses shared provider fallback/normalization.
- Bad qualities: Delivery semantics remain fragile in resumed/channel sessions, and the feature is newer with fewer providers and less operator muscle memory.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow test presence or absence.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/media-understanding-and-media-generation.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Music generation tool invocation, Provider and model selection, Lyrics, instrumental, duration, and format controls, Reference inputs where supported, Music task lifecycle and duplicate status, Generated audio persistence and delivery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Completion media delivery remains the most important user-visible gap.
- Provider-specific polling and long-running task semantics are still being refined.
- Docs are adequate for setup, but fewer real-world provider/channel scorecards exist than for image/TTS.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/music-generation.md` documents `music_generate`, providers, parameters, async lifecycle, task status, fallback, and provider notes.
- `/Users/kevinlin/code/openclaw/docs/tools/media-overview.md` documents music generation and async media-generation behavior.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/tools/music-generate-tool.ts`
- `/Users/kevinlin/code/openclaw/src/agents/tools/music-generate-tool.actions.ts`
- `/Users/kevinlin/code/openclaw/src/agents/tools/music-generate-background.ts`
- `/Users/kevinlin/code/openclaw/src/music-generation/runtime.ts`
- `/Users/kevinlin/code/openclaw/src/music-generation/capabilities.ts`
- `/Users/kevinlin/code/openclaw/src/music-generation/normalization.ts`
- `/Users/kevinlin/code/openclaw/src/music-generation/provider-registry.ts`
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/music-generation.ts`
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/music-generation-core.ts`

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/openclaw-tools.generation.test-support.ts`
- `/Users/kevinlin/code/openclaw/src/media-generation/provider-capabilities.contract.test.ts`
- `/Users/kevinlin/code/openclaw/src/music-generation/live-test-helpers.ts`

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/tools/music-generate-tool.test.ts`
- `/Users/kevinlin/code/openclaw/src/agents/tools/music-generate-tool.status.test.ts`
- `/Users/kevinlin/code/openclaw/src/agents/tools/music-generate-background.test.ts`
- `/Users/kevinlin/code/openclaw/src/music-generation/runtime.test.ts`
- `/Users/kevinlin/code/openclaw/src/music-generation/capabilities.test.ts`
- `/Users/kevinlin/code/openclaw/src/media-generation/runtime-shared.test.ts`

### Gitcrawl queries

Query:

```bash
gitcrawl search openclaw/openclaw --query "music generation never shipped" --json
```

Results:

- Returned #79535 reporting OpenRouter video generation silently failing and music generation not shipped at that point.

Query:

```bash
gitcrawl search openclaw/openclaw --query "media generation completion delivery" --json
```

Results:

- Returned #86034/#86279 for delivery failure after successful generation and #87741 for generated-media handoff lock fallback.

### Discrawl queries

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "media generation completion delivery" --limit 5
```

Results:

- Returned 2026-05-23 and 2026-05-15 clawtributors reports where an MP3 generation task completed or notification returned but the session lacked/failed visible message attachment delivery.
- Returned 2026-05-05 maintainer report for a completed `music_generate` task whose completion agent failed to deliver through the message tool.
