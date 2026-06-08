---
title: "OpenAI / Codex provider path - Image and Multimodal Input Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# OpenAI / Codex provider path - Image and Multimodal Input Maturity Note

## Summary

OpenAI image and multimodal input coverage is strong. Docs describe `image_generate`, OpenAI API-key and Codex OAuth routes, transparent-background handling, edit/reference limits, fallback behavior, Azure image deployments, and private endpoint policy. Source has a dedicated OpenAI image provider that chooses direct Images API versus Codex Responses backend and enforces output/size/security limits. Quality remains Beta because there is an open archive issue where the generic `image` media-understanding tool can bypass the configured Codex image route through model overrides and direct OpenAI auto-selection.

## Category Scope

Included in this category:

- Image Generation Editing: Covers Image Generation Editing across OpenAI image generation and editing, Codex OAuth image backend, transparent-background routing, Azure/private OpenAI image endpoints, and related image generation editing and multimodal input behavior.
- Multimodal Input: Covers Multimodal Input across OpenAI image generation and editing, Codex OAuth image backend, transparent-background routing, Azure/private OpenAI image endpoints, and related image generation editing and multimodal input behavior.

## Features

- Image Generation Editing: Covers Image Generation Editing across OpenAI image generation and editing, Codex OAuth image backend, transparent-background routing, Azure/private OpenAI image endpoints, and related image generation editing and multimodal input behavior.
- Multimodal Input: Covers Multimodal Input across OpenAI image generation and editing, Codex OAuth image backend, transparent-background routing, Azure/private OpenAI image endpoints, and related image generation editing and multimodal input behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (80%)`
- Positive signals: Docs and source cover the major image routes; unit tests cover provider behavior and task flow; Docker E2E covers OpenAI image auth; live media tooling can run provider-specific image tests.
- Negative signals: The Codex OAuth image path and Azure/private endpoint variants are not all represented by always-on integration tests.
- Integration gaps: Current release proof should include direct OpenAI, Codex OAuth, transparent background, edit/reference image, and configured private/Azure endpoint behavior.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: #87168 records that the `image` media-understanding tool can bypass configured Codex image route via model overrides and direct OpenAI auto-selection.
- Discrawl reports: Image-specific queries returned no direct rows. This was treated as neutral after freshness succeeded.
- Good qualities: The provider explicitly distinguishes direct API-key config from Codex OAuth profile use, enforces size/event limits, normalizes transparent-background requests, and blocks private endpoints by default.
- Bad qualities: Multiple image-capable surfaces share similar model refs, making route ownership easy to bypass accidentally.
- Excluded from quality: Image-generation unit, Docker, and live test coverage were used only for Coverage.

## Completeness Score

- Score: `Stable (80%)`
- Surface instructions: evaluated against `references/completeness/openai-codex-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Image Generation Editing, Multimodal Input.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Codex OAuth image route should be harder to bypass when an install expects subscription-backed image generation.
- The generic `image` media-understanding tool and `image_generate` route need clearer operator-visible separation.
- Azure/custom endpoint behavior needs more public release proof.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/openai.md` documents OpenAI image generation, Codex OAuth image backend, transparent-background model reroute, Azure image-generation endpoint behavior, and private endpoint opt-in.
- `/Users/kevinlin/code/openclaw/docs/tools/image-generation.md` documents `image_generate`, provider selection order, supported providers, edit/reference parameters, output hints, background handling, fallback behavior, and task wake behavior.
- `/Users/kevinlin/code/openclaw/docs/nodes/images.md` documents image node capabilities.

### Source

- `/Users/kevinlin/code/openclaw/extensions/openai/image-generation-provider.ts` implements direct OpenAI Images API, Codex Responses image backend, output/size normalization, transparent-background reroute, Azure deployment routing, private endpoint checks, SSE event parsing, and result limits.
- `/Users/kevinlin/code/openclaw/src/image-generation/runtime.ts` resolves image-generation candidates, timeouts, override normalization, provider fallback, and failure reporting.
- `/Users/kevinlin/code/openclaw/src/image-generation/openai-compatible-image-provider.ts` implements reusable OpenAI-compatible image generation/editing request construction and SSRF-aware HTTP behavior.
- `/Users/kevinlin/code/openclaw/src/agents/tools/image-generate-tool.ts` exposes the `image_generate` tool, task registration, media store integration, and session wake behavior.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/run/images.ts` detects and merges image attachments, prompt image refs, and offloaded media into agent turns.
- `/Users/kevinlin/code/openclaw/extensions/openai/openai-codex-provider.ts` restores image input capability for known modern Codex model rows.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/openai-image-auth-docker.sh` runs a mocked OpenAI image-generation auth Docker E2E.
- `/Users/kevinlin/code/openclaw/scripts/test-live-media.ts` includes the image live-media suite and provider filtering for OpenAI image generation.
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-codex-harness.live.test.ts` includes optional Codex harness image and chat-image probes.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/openai/image-generation-provider.test.ts` covers OpenAI image provider behavior.
- `/Users/kevinlin/code/openclaw/src/image-generation/runtime.test.ts` covers provider selection, fallback, timeout, and image result behavior.
- `/Users/kevinlin/code/openclaw/src/image-generation/openai-compatible-image-provider.test.ts` covers OpenAI-compatible image generate/edit request construction, auth, timeout, and response parsing.
- `/Users/kevinlin/code/openclaw/src/agents/tools/image-generate-tool.test.ts` covers the tool-facing image generation behavior.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/run/images.test.ts` covers image attachment/ref handling.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "image media-understanding tool bypass configured Codex image route"`

Results:

- Returned #87168, "`image` media-understanding tool can bypass configured Codex image route via model overrides and direct OpenAI auto-selection".

Query: `gitcrawl --json search issues -R openclaw/openclaw "gpt-image transparent background OpenAI Codex OAuth image"`

Results:

- Returned no matching rows. This was treated as neutral after successful freshness checks.

### Discrawl queries

Query: `discrawl search --limit 10 "openai image generation codex oauth gpt-image transparent background"`

Results:

- Returned no matching rows. This was treated as neutral after successful freshness checks.

Query: `discrawl search --limit 10 "gpt-image transparent background OpenAI Codex OAuth image"`

Results:

- Returned no matching rows. This was treated as neutral after successful freshness checks.
