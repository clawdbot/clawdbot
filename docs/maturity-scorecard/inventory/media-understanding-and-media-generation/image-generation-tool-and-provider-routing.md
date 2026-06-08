---
title: "Media understanding and media generation - Media Generation Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Media understanding and media generation - Media Generation Maturity Note

## Summary

Image generation has a mature-looking user surface: public docs, many providers, async session delivery, status/list actions, reference-image editing, provider capability normalization, and SDK provider registration. Quality is constrained by provider-auth variance, Codex OAuth routing issues, completion delivery coupling, and model/provider capability drift.

## Category Scope

Included in this category:

- Image generation tool invocation: Covers Image generation tool invocation across `image_generate`, model selection, provider registration, provider capability listing, and related image generation tool and provider routing behavior.
- Provider and model selection: Covers Provider and model selection across `image_generate`, model selection, provider registration, provider capability listing, and related image generation tool and provider routing behavior.
- Reference image editing: Covers Reference image editing across `image_generate`, model selection, provider registration, provider capability listing, and related image generation tool and provider routing behavior.
- Generated image task lifecycle: Covers Generated image task lifecycle across `image_generate`, model selection, provider registration, provider capability listing, and related image generation tool and provider routing behavior.
- Generated image persistence and delivery: Covers Generated image persistence and delivery across `image_generate`, model selection, provider registration, provider capability listing, and related image generation tool and provider routing behavior.
- Music generation tool invocation: Covers Music generation tool invocation across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Provider and model selection: Covers Provider and model selection across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Lyrics, instrumental, duration, and format controls: Covers Lyrics, instrumental, duration, and format controls across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Reference inputs where supported: Covers Reference inputs where supported across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Music task lifecycle and duplicate status: Covers Music task lifecycle and duplicate status across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Generated audio persistence and delivery: Covers Generated audio persistence and delivery across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Video generation tool invocation: Covers Video generation tool invocation across `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, and related video generation tool and provider routing behavior.
- Mode and provider capability selection: Covers Mode and provider capability selection across `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, and related video generation tool and provider routing behavior.
- Reference image, video, and audio inputs: Covers Reference image, video, and audio inputs across `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, and related video generation tool and provider routing behavior.
- Provider option validation: Covers Provider option validation across `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, and related video generation tool and provider routing behavior.
- Video task lifecycle and status: Covers Video task lifecycle and status across `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, and related video generation tool and provider routing behavior.
- Generated video persistence and delivery: Covers Generated video persistence and delivery across `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, and related video generation tool and provider routing behavior.

## Features

- Image generation tool invocation: Covers Image generation tool invocation across `image_generate`, model selection, provider registration, provider capability listing, and related image generation tool and provider routing behavior.
- Provider and model selection: Covers Provider and model selection across `image_generate`, model selection, provider registration, provider capability listing, and related image generation tool and provider routing behavior.
- Reference image editing: Covers Reference image editing across `image_generate`, model selection, provider registration, provider capability listing, and related image generation tool and provider routing behavior.
- Generated image task lifecycle: Covers Generated image task lifecycle across `image_generate`, model selection, provider registration, provider capability listing, and related image generation tool and provider routing behavior.
- Generated image persistence and delivery: Covers Generated image persistence and delivery across `image_generate`, model selection, provider registration, provider capability listing, and related image generation tool and provider routing behavior.
- Music generation tool invocation: Covers Music generation tool invocation across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Provider and model selection: Covers Provider and model selection across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Lyrics, instrumental, duration, and format controls: Covers Lyrics, instrumental, duration, and format controls across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Reference inputs where supported: Covers Reference inputs where supported across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Music task lifecycle and duplicate status: Covers Music task lifecycle and duplicate status across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Generated audio persistence and delivery: Covers Generated audio persistence and delivery across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
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

- Score: `Stable (84%)`
- Positive signals: Docs cover setup, providers, capability matrix, parameters, fallbacks, timeouts, image editing, status/list actions, and provider-specific notes. Source has tool, runtime, provider registry, openai-compatible provider, background task lifecycle, and SDK exports.
- Negative signals: Provider-specific live behavior varies and the provider matrix changes quickly; not every provider path has visible recurring scenario proof.
- Integration gaps: Async visible-delivery proof is shared with the media delivery component and has known archive friction.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: #76690 and #85797 show Codex OAuth/image generation availability mismatches; #86034/#86279 show generated-media success being conflated with delivery failure; #79360 asks to expose Responses image IDs for iterative edits; #86493/#86605 show provider registration gaps; #84627 shows xAI SSRF/private-network configuration issues.
- Discrawl reports: Maintainer archive reports Codex OAuth image generation behavior, timeout default tuning (#75337), and concern over accidental API billing versus OAuth. Broader discrawl media-generation results show delivery handoff bugs after provider success.
- Good qualities: The tool validates hard capability limits, reports ignored overrides, has list/status actions, deduplicates active tasks, and blocks remote URLs in sandboxed contexts.
- Bad qualities: Provider auth source selection and provider registration remain easy to misconfigure, and the end-to-end user result still depends on async message delivery after generation succeeds.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow test presence or absence.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/media-understanding-and-media-generation.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Image generation tool invocation, Provider and model selection, Reference image editing, Generated image task lifecycle, Generated image persistence and delivery, Music generation tool invocation, Provider and model selection, Lyrics, instrumental, duration, and format controls, Reference inputs where supported, Music task lifecycle and duplicate status, Generated audio persistence and delivery, Video generation tool invocation, Mode and provider capability selection, Reference image, video, and audio inputs, Provider option validation, Video task lifecycle and status, Generated video persistence and delivery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Iterative image edits lack provider-returned generation ID exposure in the public tool path.
- OAuth/API-key routing is still a source of confusion and bugs.
- Provider capability and timeout defaults need continuous maintenance as hosted APIs change.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/image-generation.md` documents `image_generate`, async task behavior, provider setup, provider capabilities, reference-image editing, timeout behavior, normalization, and examples.
- `/Users/kevinlin/code/openclaw/docs/tools/media-overview.md` lists image generation and provider capabilities.
- `/Users/kevinlin/code/openclaw/docs/tools/skills.md` and `/Users/kevinlin/code/openclaw/docs/tools/skills-config.md` advise using the core `image_generate` path for stock image generation.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/tools/image-generate-tool.ts`
- `/Users/kevinlin/code/openclaw/src/agents/tools/image-generate-tool.actions.ts`
- `/Users/kevinlin/code/openclaw/src/agents/tools/image-generate-background.ts`
- `/Users/kevinlin/code/openclaw/src/image-generation/runtime.ts`
- `/Users/kevinlin/code/openclaw/src/image-generation/provider-registry.ts`
- `/Users/kevinlin/code/openclaw/src/image-generation/openai-compatible-image-provider.ts`
- `/Users/kevinlin/code/openclaw/src/image-generation/image-assets.ts`
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/image-generation.ts`
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/image-generation-core.ts`

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/openclaw-tools.image-generation.test.ts`
- `/Users/kevinlin/code/openclaw/src/agents/tools/image-tool.providers.live.test.ts`
- `/Users/kevinlin/code/openclaw/src/agents/tools/image-tool.ollama.live.test.ts`
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-subscribe.tools.media.test.ts`

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/tools/image-generate-tool.test.ts`
- `/Users/kevinlin/code/openclaw/src/agents/tools/image-generate-tool.actions.ts` has status/list support covered by nearby tool tests.
- `/Users/kevinlin/code/openclaw/src/image-generation/runtime.test.ts`
- `/Users/kevinlin/code/openclaw/src/image-generation/provider-registry.test.ts`
- `/Users/kevinlin/code/openclaw/src/image-generation/openai-compatible-image-provider.test.ts`
- `/Users/kevinlin/code/openclaw/src/image-generation/image-assets.test.ts`
- `/Users/kevinlin/code/openclaw/src/test-utils/generation-live-test-helpers.ts`

### Gitcrawl queries

Query:

```bash
gitcrawl search openclaw/openclaw --query "image generation Codex OAuth" --json
```

Results:

- Returned #76690 for `openai/gpt-image-2` via Codex OAuth tool-not-found, #85797 for capability image generate requiring API key despite working OAuth path, #72087 for Linux dist/entry Codex OAuth image generation breakage, #79360 for Responses image generation IDs, and #87051 for OAuth profile propagation affecting image-generation work.

Query:

```bash
gitcrawl search openclaw/openclaw --query "image generation" --json
```

Results:

- Returned provider metadata (#85466), generation/delivery failure separation (#86034/#86279), xAI and StepFun provider issues (#83857/#86493/#86605), and OpenRouter/hosted provider capability requests.

### Discrawl queries

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "image generation Codex OAuth" --limit 5
```

Results:

- Returned maintainer archive with Peter-merged #77388 for fal GPT Image 2/NB2 edit routing, #80687 for media-generation timeouts, and user-facing discussion of Codex OAuth versus API billing for image generation.
- Returned 2026-05-01 maintainer note that image generation failures seen with `openai/gpt-image-2` via Codex OAuth used 120s/180s timeouts and non-OpenAI hosted defaults needed raising.
