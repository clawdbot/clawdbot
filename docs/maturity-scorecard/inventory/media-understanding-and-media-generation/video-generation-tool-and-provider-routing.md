---
title: "Media understanding and media generation - Video Generation Tool and Provider Routing Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Media understanding and media generation - Video Generation Tool and Provider Routing Maturity Note

## Summary

Video generation is a broad but fast-moving tool surface. It supports text-to-video, image-to-video, video-to-video, reference role hints, provider-specific capability normalization, background tasks, and provider URL fallback. Quality is beta/alpha-edge because provider mode support and delivery behavior vary substantially.

## Category Scope

This category covers `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, provider option validation, generated-video persistence, URL-only outputs, background task lifecycle, status/list actions, and SDK provider registration. It does not score video understanding.

## Features

- Video generation tool invocation: Covers Video generation tool invocation across `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, and related video generation tool and provider routing behavior.
- Mode and provider capability selection: Covers Mode and provider capability selection across `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, and related video generation tool and provider routing behavior.
- Reference image, video, and audio inputs: Covers Reference image, video, and audio inputs across `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, and related video generation tool and provider routing behavior.
- Provider option validation: Covers Provider option validation across `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, and related video generation tool and provider routing behavior.
- Video task lifecycle and status: Covers Video task lifecycle and status across `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, and related video generation tool and provider routing behavior.
- Generated video persistence and delivery: Covers Generated video persistence and delivery across `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, and related video generation tool and provider routing behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Public docs enumerate many providers, modes, input limits, role hints, async task lifecycle, status/list actions, CLI task inspection, and provider capability matrices. Source has dedicated runtime, capability normalization, tool, status, background task, and SDK exports.
- Negative signals: Provider-specific mode support is complex and uneven; live lanes intentionally skip some mode/provider combinations.
- Integration gaps: End-to-end recurring proof for every provider/mode/client combination is not present, especially for video-to-video and remote-URL-only constraints.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: #79535 reports OpenRouter video generation silently failing; #45655 reports Poe video-output models accepted but failing at runtime; #86034/#86279 show completion delivery failure after successful media generation; #87741 adds fallback when generated-media handoff locks.
- Discrawl reports: Media-generation delivery query shows multiple Discord/Molty reports where generation or completion woke correctly but visible attachment delivery failed. Video-specific discrawl query returned no additional targeted hits.
- Good qualities: Mode resolution is explicit, provider capabilities are machine-readable, unsupported overrides are surfaced, oversized local persistence can fall back to provider URLs, and duplicate active task calls return status.
- Bad qualities: Provider capability drift is high, model support differs by input mode and URL/path constraints, and user success still depends on async delivery through the message tool.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow test presence or absence.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/media-understanding-and-media-generation.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Video generation tool invocation, Mode and provider capability selection, Reference image, video, and audio inputs, Provider option validation, Video task lifecycle and status, Generated video persistence and delivery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Video-to-video remains provider- and input-path constrained.
- Hosted provider capability drift creates frequent mismatch risk between docs, config, and runtime behavior.
- Delivery bugs can make provider success look like generation failure to users.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/video-generation.md` documents `video_generate`, async behavior, task lifecycle, providers, modes, role hints, capabilities, tool parameters, normalization, and fallback semantics.
- `/Users/kevinlin/code/openclaw/docs/tools/media-overview.md` summarizes video generation and async media behavior.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/tools/video-generate-tool.ts`
- `/Users/kevinlin/code/openclaw/src/agents/tools/video-generate-tool.actions.ts`
- `/Users/kevinlin/code/openclaw/src/agents/tools/video-generate-background.ts`
- `/Users/kevinlin/code/openclaw/src/video-generation/runtime.ts`
- `/Users/kevinlin/code/openclaw/src/video-generation/capabilities.ts`
- `/Users/kevinlin/code/openclaw/src/video-generation/capability-overlays.ts`
- `/Users/kevinlin/code/openclaw/src/video-generation/duration-support.ts`
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/video-generation.ts`
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/video-generation-core.ts`

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/openclaw-tools.video-generation.test.ts`
- `/Users/kevinlin/code/openclaw/src/video-generation/live-test-helpers.test.ts`
- `/Users/kevinlin/code/openclaw/src/media-generation/provider-capabilities.contract.test.ts`

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/tools/video-generate-tool.test.ts`
- `/Users/kevinlin/code/openclaw/src/agents/tools/video-generate-tool.status.test.ts`
- `/Users/kevinlin/code/openclaw/src/agents/tools/video-generate-background.test.ts`
- `/Users/kevinlin/code/openclaw/src/video-generation/runtime.test.ts`
- `/Users/kevinlin/code/openclaw/src/video-generation/provider-registry.test.ts`
- `/Users/kevinlin/code/openclaw/src/video-generation/capabilities.test.ts`
- `/Users/kevinlin/code/openclaw/src/video-generation/capability-overlays.test.ts`

### Gitcrawl queries

Query:

```bash
gitcrawl search openclaw/openclaw --query "video generation OpenRouter silently fails" --json
```

Results:

- Returned #79535 reporting OpenRouter video generation silently failing and music generation not shipped at that time.

Query:

```bash
gitcrawl search openclaw/openclaw --query "video generation" --json
```

Results:

- Returned #79535, #64607 inline media display, #45655 Poe image/video output model runtime failure, #86279 delivery failure after generation success, and provider mode/capability-adjacent PRs.

### Discrawl queries

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "video generation OpenRouter silently fails" --limit 5
```

Results:

- Returned no targeted Discord hits.

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "media generation completion delivery" --limit 5
```

Results:

- Returned multiple channel reports where async generated media completion succeeded but visible attachment delivery failed, including MP3/music examples; the same shared media-generation delivery lifecycle applies to video.
