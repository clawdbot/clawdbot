---
title: "Image/video/music generation tools - Image Providers and Auth Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Image/video/music generation tools - Image Providers and Auth Maturity Note

## Summary

Image provider integration breadth is solid: OpenAI, OpenAI Codex, OpenRouter,
xAI, fal, LiteLLM, DeepInfra, Google, MiniMax, and other bundled plugins expose
image generation through the shared provider contract. Provider auth also has
shared profile/env resolution and provider registration paths.

Coverage is Beta because multiple providers are registered, documented, and
live-swept, but provider-specific behavior and auth combinations remain broad.
Quality is Alpha because active GitHub and Discord archive reports include
Codex OAuth image tool failures, OpenRouter missing-auth failures, xAI
private-network/SSRF blocking, and MiniMax token-plan routing breakage.

## Category Scope

This category covers provider registrations and auth paths for image
generation and editing, including OpenAI/Codex OAuth, OpenRouter, xAI, fal,
LiteLLM, DeepInfra, Google, MiniMax, auth profile/env resolution, provider
request compatibility, and provider response shaping.

## Features

- OpenAI/Codex OAuth: Covers OpenAI/Codex OAuth across provider registrations and auth paths for image generation and editing, including OpenAI/Codex OAuth, OpenRouter, xAI, and related image providers and auth behavior.
- API-key OpenAI: Covers API-key OpenAI across provider registrations and auth paths for image generation and editing, including OpenAI/Codex OAuth, OpenRouter, xAI, and related image providers and auth behavior.
- OpenRouter/xAI/fal/LiteLLM/DeepInfra/Google/MiniMax/ComfyUI auth: Covers OpenRouter/xAI/fal/LiteLLM/DeepInfra/Google/MiniMax/ComfyUI auth across provider registrations and auth paths for image generation and editing, including OpenAI/Codex OAuth, OpenRouter, xAI, and related image providers and auth behavior.
- provider error diagnostics: Covers provider error diagnostics across provider registrations and auth paths for image generation and editing, including OpenAI/Codex OAuth, OpenRouter, xAI, and related image providers and auth behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Provider docs enumerate image support, source registers multiple bundled providers, shared auth discovery feeds provider selection, and live tests sweep configured image providers.
- Negative signals: Coverage is not equally deep for every provider's auth path, edit capability, private-network rule, and endpoint-specific response shape.
- Integration gaps: Add a per-provider image auth matrix that verifies OpenAI Codex OAuth, API-key OpenAI, OpenRouter, xAI, fal, and LiteLLM with one generate and one edit-capability assertion where supported.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports: Image searches returned #76690 on Codex OAuth image generation failing because the tool was not found, #84627 on xAI `image_generate` being blocked by SSRF/private-network behavior, #86493 and #86605 around StepFun provider registration, and #83030 on OpenRouter ReCraft support.
- Discrawl reports: Discord search found reports of invalid image access tokens, OpenRouter missing authentication, and image worker credential-source mismatch.
- Good qualities: Provider registration is explicit and the shared runtime records provider attempts and ignored overrides.
- Bad qualities: Provider auth and endpoint behavior are still the largest source of user-visible image failures, especially when workers use a different credential path than the interactive model.
- Excluded from quality: Unit, integration, live, and QA test breadth were treated as Coverage inputs only; tests did not raise or lower this Quality score.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/image-video-music-generation-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for OpenAI/Codex OAuth, API-key OpenAI, OpenRouter/xAI/fal/LiteLLM/DeepInfra/Google/MiniMax/ComfyUI auth, provider error diagnostics.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- OpenAI/Codex OAuth behavior is not consistently transparent to the user.
- OpenRouter and xAI failures can look like generic image-generation failures rather than provider-specific auth or network-policy failures.
- Provider-specific capability drift can make a configured model look available before it fails at request time.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/image-generation.md:76` lists image provider routes and supported providers.
- `/Users/kevinlin/code/openclaw/docs/tools/image-generation.md:122` documents provider capabilities.
- `/Users/kevinlin/code/openclaw/docs/tools/image-generation.md:327` documents OpenRouter image models.
- `/Users/kevinlin/code/openclaw/docs/tools/image-generation.md:360` documents xAI image generation and unsupported native-only controls.
- `/Users/kevinlin/code/openclaw/docs/tools/media-overview.md:55` summarizes media provider capability coverage.

### Source

- `/Users/kevinlin/code/openclaw/extensions/openai/index.ts:47` registers OpenAI provider, Codex provider, image generation, speech/media, and video generation.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/index.ts:194` registers OpenRouter media understanding, image, music, video, video catalog, and speech.
- `/Users/kevinlin/code/openclaw/extensions/fal/index.ts:13` registers fal provider, image, music, and video generation.
- `/Users/kevinlin/code/openclaw/extensions/xai/index.ts:234` registers xAI web search, media understanding, video, image, speech, and STT.
- `/Users/kevinlin/code/openclaw/extensions/litellm/index.ts:95` registers LiteLLM catalog and image generation.
- `/Users/kevinlin/code/openclaw/src/media-generation/runtime-shared.ts:100` resolves auth profile and environment-backed provider state.

### Integration tests

- `/Users/kevinlin/code/openclaw/test/image-generation.runtime.live.test.ts:196` live-sweeps configured image providers and validates MIME and buffer output.
- `/Users/kevinlin/code/openclaw/scripts/test-live-media.ts:31` includes image live suite provider lists.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/media-generation/provider-capabilities.contract.test.ts:54` enforces bundled provider capability declarations.
- `/Users/kevinlin/code/openclaw/src/agents/openclaw-tools.image-generation.test.ts:1` exercises image tool registration through shared test support.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "image generation provider openai openrouter xai litellm fal" --json`

Results:

- Returned no direct hits for the exact phrase.

Query: `gitcrawl search openclaw/openclaw --query "image generation" --json`

Results:

- Returned #76690, #84627, #86493, #86605, #83030, #83857, and other image-provider or auth-related reports.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "image_generate"`

Results:

- Found invalid access token, OpenRouter missing-auth, Codex/OpenAI credential-source mismatch, and MiniMax token-plan image generation routing reports.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "image generation provider openai openrouter xai litellm fal"`

Results:

- Returned no direct hits for the exact provider list phrase.
