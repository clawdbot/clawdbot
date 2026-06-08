---
title: "Image/video/music generation tools - Media Routing and Discovery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Image/video/music generation tools - Media Routing and Discovery Maturity Note

## Summary

Configuration and discovery are well represented across docs and source. Image,
video, and music each have explicit agent default keys, provider/model ref
parsing, ordered fallbacks, auth-backed auto discovery, catalog listing, and
tool availability gates.

Coverage is Stable because the implementation has shared runtime helpers,
provider catalogs, docs, and contract tests for the discovery path. Quality is
Beta because the model-ref and provider-discovery abstractions are coherent, but
Discord archive evidence shows deferred media tool discoverability still
confuses agents and operators.

## Category Scope

Included in this category:

- default media model config: Covers default media model config across `imageGenerationModel`, `videoGenerationModel`, `musicGenerationModel`, provider/model refs, and related model routing and tool discovery behavior.
- per-call model refs and fallbacks: Covers per-call model refs and fallbacks across `imageGenerationModel`, `videoGenerationModel`, `musicGenerationModel`, provider/model refs, and related model routing and tool discovery behavior.
- auth-backed tool discovery: Covers auth-backed tool discovery across `imageGenerationModel`, `videoGenerationModel`, `musicGenerationModel`, provider/model refs, and related model routing and tool discovery behavior.
- action=list provider inspection: Covers action=list provider inspection across `imageGenerationModel`, `videoGenerationModel`, `musicGenerationModel`, provider/model refs, and related model routing and tool discovery behavior.

## Features

- default media model config: Covers default media model config across `imageGenerationModel`, `videoGenerationModel`, `musicGenerationModel`, provider/model refs, and related model routing and tool discovery behavior.
- per-call model refs and fallbacks: Covers per-call model refs and fallbacks across `imageGenerationModel`, `videoGenerationModel`, `musicGenerationModel`, provider/model refs, and related model routing and tool discovery behavior.
- auth-backed tool discovery: Covers auth-backed tool discovery across `imageGenerationModel`, `videoGenerationModel`, `musicGenerationModel`, provider/model refs, and related model routing and tool discovery behavior.
- action=list provider inspection: Covers action=list provider inspection across `imageGenerationModel`, `videoGenerationModel`, `musicGenerationModel`, provider/model refs, and related model routing and tool discovery behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Docs cover all three model default keys, provider/model refs, provider selection order, fallbacks, auto-detection, and list actions; source centralizes candidate resolution and tool factory availability.
- Negative signals: Discovery coverage is better for registered providers than for operator-facing failure explanations when no provider is available or a deferred tool is hidden from the active tool schema.
- Integration gaps: Add a scenario that starts with no visible media tool, triggers provider discovery through deferred tool search, and confirms the agent exposes the right image, video, or music affordance.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: Broad media searches surfaced issues around provider metadata, Codex OAuth image generation availability, OpenRouter video/music behavior, and deferred media tool reuse.
- Discrawl reports: Discord search found maintainer discussion on deferred media tools where the model saw source previews but not individual `music_generate`, `video_generate`, and `image_generate` tool names.
- Good qualities: The shared model-ref resolver and provider catalog reduce duplicated provider-selection behavior across image, video, and music.
- Bad qualities: The same flexibility makes poor configuration, hidden deferred tools, and provider auth mismatches hard to diagnose from the operator side.
- Excluded from quality: Unit, integration, live, and QA test breadth were treated as Coverage inputs only; tests did not raise or lower this Quality score.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/image-video-music-generation-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for default media model config, per-call model refs and fallbacks, auth-backed tool discovery, action=list provider inspection.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Deferred media tool discovery is not self-explanatory enough when a direct tool schema is absent.
- Auto provider discovery depends on auth signals and provider snapshots that may be opaque to users.
- Provider catalog rows are useful for experts but do not always explain why a specific request will skip a provider.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/gateway/config-agents.md:390` documents `imageGenerationModel` and `videoGenerationModel` defaults in agent config examples.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-agents.md:426` documents `imageGenerationModel`, auto-detection, and typical auth values.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-agents.md:431` documents `musicGenerationModel`.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-agents.md:436` documents `videoGenerationModel`.
- `/Users/kevinlin/code/openclaw/docs/tools/image-generation.md:193` documents image provider primary/fallback config and model refs.
- `/Users/kevinlin/code/openclaw/docs/tools/video-generation.md:290` documents video model selection order and config.
- `/Users/kevinlin/code/openclaw/docs/tools/music-generation.md:223` documents music model selection, fallbacks, and auto-detection.

### Source

- `/Users/kevinlin/code/openclaw/src/media-generation/model-ref.ts:8` parses provider/model refs.
- `/Users/kevinlin/code/openclaw/src/media-generation/runtime-shared.ts:100` resolves current default providers and auth profiles.
- `/Users/kevinlin/code/openclaw/src/media-generation/runtime-shared.ts:138` builds auth-backed auto fallback refs.
- `/Users/kevinlin/code/openclaw/src/media-generation/runtime-shared.ts:182` resolves ordered model candidates from overrides, primary defaults, fallbacks, and auto detection.
- `/Users/kevinlin/code/openclaw/src/media-generation/catalog.ts:36` synthesizes static media catalog entries.
- `/Users/kevinlin/code/openclaw/src/agents/openclaw-tools.media-factory-plan.ts:167` plans optional media tools based on policy, config, snapshots, and capability availability.
- `/Users/kevinlin/code/openclaw/src/agents/tools/media-generate-tool-actions-shared.ts:41` returns provider list results with configured status, auth, modes, capabilities, and catalog rows.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/media-generation/provider-capabilities.contract.test.ts:54` checks that bundled video and music providers have capability declarations.
- `/Users/kevinlin/code/openclaw/scripts/test-live-media.ts:31` defines live media provider suites for image, music, and video.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/openclaw-tools.image-generation.test.ts:1` exercises shared image tool registration support.
- `/Users/kevinlin/code/openclaw/src/agents/openclaw-tools.video-generation.test.ts:1` exercises shared video tool registration support.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "imageGenerationModel videoGenerationModel musicGenerationModel provider discovery image_generate video_generate music_generate" --json`

Results:

- Returned no direct hits for the exact phrase, which suggests the explicit config-key contract is not a common archived complaint.

Query: `gitcrawl search openclaw/openclaw --query "image generation" --json`

Results:

- Returned #78852 on reusing media tool availability during tool prep, #78330 on exposing image generation providers over gateway RPC, and #76690 on Codex OAuth image generation failing because the tool was unavailable.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "video_generate"`

Results:

- Found maintainer discussion on deferred media tools where source previews existed but individual media tool names were not discoverable enough for `music_generate`, `video_generate`, and `image_generate`.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "image_generate"`

Results:

- Found user and maintainer reports about OpenRouter image auth, Codex/OpenAI credential source mismatch, and media tool endpoint routing.
