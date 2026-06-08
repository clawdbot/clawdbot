---
title: "Image/video/music generation tools - Image Generation Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Image/video/music generation tools - Image Generation Maturity Note

## Summary

The image runtime is the strongest part of this surface. It handles
text-to-image, reference-image editing, multi-image inputs, output format,
background hints, size and aspect-ratio normalization, provider result
validation, base64/data URL parsing, MIME detection, and provider attempt
metadata.

Coverage is Stable because docs, runtime source, asset shaping, live sweeps, and
QA scenarios cover the main image generation and edit paths. Quality is Beta
because the core runtime is cohesive, but iterative-edit identifiers,
provider-specific metadata, and auth/provider compatibility are still active
operational risks.

## Category Scope

Included in this category:

- text-to-image: Covers text-to-image across image generation and editing runtime behavior after a provider candidate has been selected: request normalization, timeout handling, reference-image inputs, image response parsing, and related image generation and editing behavior.
- reference-image editing: Covers reference-image editing across image generation and editing runtime behavior after a provider candidate has been selected: request normalization, timeout handling, reference-image inputs, image response parsing, and related image generation and editing behavior.
- output hints: Covers output hints across image generation and editing runtime behavior after a provider candidate has been selected: request normalization, timeout handling, reference-image inputs, image response parsing, and related image generation and editing behavior.
- action=status: Covers action=status across image generation and editing runtime behavior after a provider candidate has been selected: request normalization, timeout handling, reference-image inputs, image response parsing, and related image generation and editing behavior.
- provider attempt metadata: Covers provider attempt metadata across image generation and editing runtime behavior after a provider candidate has been selected: request normalization, timeout handling, reference-image inputs, image response parsing, and related image generation and editing behavior.
- OpenAI/Codex OAuth: Covers OpenAI/Codex OAuth across provider registrations and auth paths for image generation and editing, including OpenAI/Codex OAuth, OpenRouter, xAI, and related image providers and auth behavior.
- API-key OpenAI: Covers API-key OpenAI across provider registrations and auth paths for image generation and editing, including OpenAI/Codex OAuth, OpenRouter, xAI, and related image providers and auth behavior.
- OpenRouter/xAI/fal/LiteLLM/DeepInfra/Google/MiniMax/ComfyUI auth: Covers OpenRouter/xAI/fal/LiteLLM/DeepInfra/Google/MiniMax/ComfyUI auth across provider registrations and auth paths for image generation and editing, including OpenAI/Codex OAuth, OpenRouter, xAI, and related image providers and auth behavior.
- provider error diagnostics: Covers provider error diagnostics across provider registrations and auth paths for image generation and editing, including OpenAI/Codex OAuth, OpenRouter, xAI, and related image providers and auth behavior.

## Features

- text-to-image: Covers text-to-image across image generation and editing runtime behavior after a provider candidate has been selected: request normalization, timeout handling, reference-image inputs, image response parsing, and related image generation and editing behavior.
- reference-image editing: Covers reference-image editing across image generation and editing runtime behavior after a provider candidate has been selected: request normalization, timeout handling, reference-image inputs, image response parsing, and related image generation and editing behavior.
- output hints: Covers output hints across image generation and editing runtime behavior after a provider candidate has been selected: request normalization, timeout handling, reference-image inputs, image response parsing, and related image generation and editing behavior.
- action=status: Covers action=status across image generation and editing runtime behavior after a provider candidate has been selected: request normalization, timeout handling, reference-image inputs, image response parsing, and related image generation and editing behavior.
- provider attempt metadata: Covers provider attempt metadata across image generation and editing runtime behavior after a provider candidate has been selected: request normalization, timeout handling, reference-image inputs, image response parsing, and related image generation and editing behavior.
- OpenAI/Codex OAuth: Covers OpenAI/Codex OAuth across provider registrations and auth paths for image generation and editing, including OpenAI/Codex OAuth, OpenRouter, xAI, and related image providers and auth behavior.
- API-key OpenAI: Covers API-key OpenAI across provider registrations and auth paths for image generation and editing, including OpenAI/Codex OAuth, OpenRouter, xAI, and related image providers and auth behavior.
- OpenRouter/xAI/fal/LiteLLM/DeepInfra/Google/MiniMax/ComfyUI auth: Covers OpenRouter/xAI/fal/LiteLLM/DeepInfra/Google/MiniMax/ComfyUI auth across provider registrations and auth paths for image generation and editing, including OpenAI/Codex OAuth, OpenRouter, xAI, and related image providers and auth behavior.
- provider error diagnostics: Covers provider error diagnostics across provider registrations and auth paths for image generation and editing, including OpenAI/Codex OAuth, OpenRouter, xAI, and related image providers and auth behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals: Image docs cover parameters and provider behavior; source implements validation, normalization, parsing, and attempt metadata; QA and live tests cover generation and roundtrip usage.
- Negative signals: Runtime coverage is stronger for successful standard outputs than for provider-specific response drift, iterative edit chains, and metadata persistence.
- Integration gaps: Add a live edit-chain scenario that preserves provider image identifiers and validates a follow-up edit against the prior generated image.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: Image search returned #85466 requesting image-generation provider usage metadata and #79360 requesting Responses image generation IDs for iterative edits.
- Discrawl reports: Discord search found operator reports where image generation failed because worker auth differed from Codex/OpenAI credential handling or OpenRouter auth was missing.
- Good qualities: The runtime validates that providers return images, captures ignored overrides, normalizes output assets, and reports provider attempts.
- Bad qualities: Image generation still relies on provider-specific response shapes and auth behavior, and the runtime does not yet make iterative-edit provenance first class across providers.
- Excluded from quality: Unit, integration, live, and QA test breadth were treated as Coverage inputs only; tests did not raise or lower this Quality score.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/image-video-music-generation-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for text-to-image, reference-image editing, output hints, action=status, provider attempt metadata, OpenAI/Codex OAuth, API-key OpenAI, OpenRouter/xAI/fal/LiteLLM/DeepInfra/Google/MiniMax/ComfyUI auth, provider error diagnostics.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Iterative edit IDs and provider usage metadata are not fully surfaced.
- Provider auth and endpoint differences can dominate user-visible success even when runtime request shaping is sound.
- Response parsing supports common OpenAI-compatible shapes but remains exposed to upstream schema drift.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/image-generation.md:11` describes image generate/edit behavior and async completion.
- `/Users/kevinlin/code/openclaw/docs/tools/image-generation.md:132` documents image tool parameters.
- `/Users/kevinlin/code/openclaw/docs/tools/image-generation.md:179` documents unsupported parameter dropping and normalization.
- `/Users/kevinlin/code/openclaw/docs/tools/image-generation.md:253` documents image editing support and input limits.
- `/Users/kevinlin/code/openclaw/docs/tools/image-generation.md:270` documents OpenAI image generation details for model, background, prompt, count, size, quality, format, and references.
- `/Users/kevinlin/code/openclaw/docs/cli/infer.md:184` documents image generate and edit CLI usage.

### Source

- `/Users/kevinlin/code/openclaw/src/image-generation/runtime.ts:45` lists runtime image generation providers.
- `/Users/kevinlin/code/openclaw/src/image-generation/runtime.ts:52` builds image provider candidates from model override and config.
- `/Users/kevinlin/code/openclaw/src/image-generation/runtime.ts:94` applies timeout and override normalization before provider invocation.
- `/Users/kevinlin/code/openclaw/src/image-generation/runtime.ts:128` validates image results and records normalization metadata.
- `/Users/kevinlin/code/openclaw/src/image-generation/runtime.ts:146` records provider attempts and throws aggregated failures.
- `/Users/kevinlin/code/openclaw/src/image-generation/image-assets.ts:34` infers image MIME and file extension.
- `/Users/kevinlin/code/openclaw/src/image-generation/image-assets.ts:81` parses image data URLs.
- `/Users/kevinlin/code/openclaw/src/image-generation/image-assets.ts:148` parses OpenAI-compatible image responses.

### Integration tests

- `/Users/kevinlin/code/openclaw/test/image-generation.runtime.live.test.ts:196` resolves auth, registers plugins, calls live image generation providers, and checks returned MIME and buffers.
- `/Users/kevinlin/code/openclaw/qa/scenarios/media/native-image-generation.md:34` verifies tool inventory, planned tool usage, and saved media path.
- `/Users/kevinlin/code/openclaw/qa/scenarios/media/image-generation-roundtrip.md:36` verifies generated image reattachment and description.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/openclaw-tools.image-generation.test.ts:1` runs shared image generation tool registration tests.
- `/Users/kevinlin/code/openclaw/src/agents/tools/media-generate-background-shared.test.ts:14` covers generated media lifecycle behavior used by image generation.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "image generation" --json`

Results:

- Returned #85466 on capturing image-generation provider usage metadata, #79360 on exposing Responses image generation IDs for iterative edits, #76690 on Codex OAuth image tool availability, #83857 on xAI image generation behavior, and #84627 on xAI SSRF/private-network blocking.

Query: `gitcrawl search openclaw/openclaw --query "image generation edit reference images transparent background gpt-image" --json`

Results:

- Returned no direct hits for the exact phrase, suggesting the documented edit parameter contract is less represented in archived issue titles than provider/auth behavior.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "image_generate"`

Results:

- Found Discord reports for invalid access token failures, OpenRouter missing authentication, Codex/OpenAI credential-source mismatch, and image-generation endpoint routing.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "image generation edit reference images transparent background gpt-image"`

Results:

- Returned no direct hits for the exact phrase.
