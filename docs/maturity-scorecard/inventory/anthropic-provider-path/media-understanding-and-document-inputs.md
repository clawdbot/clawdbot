---
title: "Anthropic provider path - Media Inputs Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Anthropic provider path - Media Inputs Maturity Note

## Summary

Anthropic media support is a smaller, clearly bounded part of the provider
path. Docs state that the bundled Anthropic plugin registers image and PDF
understanding, source registers image capability with native PDF document input
metadata, and model metadata normalizes image-capable Claude rows. Coverage is
Beta because source and docs are clear but live Anthropic media scenario proof
is thinner than text/tool transport proof. Quality is Stable because the surface
is small, directly mapped to provider capabilities, and the archive search did
not find feature-specific user reports after freshness checks.

## Category Scope

Included in this category:

- Image input: Covers Image input across Anthropic media understanding as part of the provider path: image input support, PDF native document input metadata, default media model selection, auto-priority, and related media inputs behavior.
- PDF document input: Covers PDF document input across Anthropic media understanding as part of the provider path: image input support, PDF native document input metadata, default media model selection, auto-priority, and related media inputs behavior.
- Media model fallback: Covers Media model fallback across Anthropic media understanding as part of the provider path: image input support, PDF native document input metadata, default media model selection, auto-priority, and related media inputs behavior.
- Image tool results: Covers Image tool results across Anthropic media understanding as part of the provider path: image input support, PDF native document input metadata, default media model selection, auto-priority, and related media inputs behavior.

## Features

- Image input: Covers Image input across Anthropic media understanding as part of the provider path: image input support, PDF native document input metadata, default media model selection, auto-priority, and related media inputs behavior.
- PDF document input: Covers PDF document input across Anthropic media understanding as part of the provider path: image input support, PDF native document input metadata, default media model selection, auto-priority, and related media inputs behavior.
- Media model fallback: Covers Media model fallback across Anthropic media understanding as part of the provider path: image input support, PDF native document input metadata, default media model selection, auto-priority, and related media inputs behavior.
- Image tool results: Covers Image tool results across Anthropic media understanding as part of the provider path: image input support, PDF native document input metadata, default media model selection, auto-priority, and related media inputs behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: Docs describe image and PDF understanding; manifest and provider source register media metadata; direct transport converts image blocks; tests cover image media metadata and image tool-result payload conversion.
- Negative signals: The audit did not find a dedicated live Anthropic image/PDF scenario artifact or per-release media smoke result.
- Integration gaps: Media support is covered more by provider registration and payload tests than by end-to-end media runs.

## Quality Score

- Score: `Stable (82%)`
- Gitcrawl reports: The feature-specific GitHub issue query returned no direct Anthropic media reports after freshness checks.
- Discrawl reports: The feature-specific Discord query returned no direct Anthropic media reports after freshness checks.
- Good qualities: The capability is small, declarative, and aligned with modern Claude model metadata; source keeps media model defaults and native document input metadata in one plugin-owned surface.
- Bad qualities: Docs say image and PDF understanding, while the provider capability list is `["image"]` plus separate `nativeDocumentInputs: ["pdf"]`; that split can require careful wording as docs evolve.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test presence or absence; those are Coverage inputs only.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/anthropic-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Image input, PDF document input, Media model fallback, Image tool results.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No dedicated live Anthropic image/PDF proof was found in this audit.
- PDF support is represented as native document input metadata rather than a
  separate capability id.
- Media generation is out of scope; this component is media understanding only.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/anthropic.md` documents "Media understanding (image and PDF)", default model `claude-opus-4-7`, supported input images/PDF documents, and automatic routing through the Anthropic media understanding provider.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-agents.md` documents image resize behavior for Claude Opus 4.7 and other vision models.

### Source

- `/Users/kevinlin/code/openclaw/extensions/anthropic/openclaw.plugin.json` declares media understanding provider metadata for Anthropic with capability `image`, default image model `claude-opus-4-7`, auto priority `20`, and native document input `pdf`.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/media-understanding-provider.ts` registers `anthropicMediaUnderstandingProvider` with image capabilities, default models, auto priority, native document inputs, and `describeImage`/`describeImages` helpers.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/register.runtime.ts` normalizes modern Claude models to include image input and model-specific media input sizing.
- `/Users/kevinlin/code/openclaw/src/llm/providers/anthropic.ts` converts user image blocks and image tool-result blocks into Anthropic image content.
- `/Users/kevinlin/code/openclaw/src/agents/anthropic-transport-stream.ts` performs transport-side image and tool-result conversion for Anthropic Messages payloads.

### Integration tests

- `/Users/kevinlin/code/openclaw/test/scripts/package-acceptance-workflow.test.ts` includes live Anthropic profile wiring but does not by itself prove image/PDF scenarios.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/anthropic/index.test.ts` covers stale text-only modern Claude vision row normalization and media metadata merge for `claude-opus-4-7`.
- `/Users/kevinlin/code/openclaw/src/agents/anthropic-transport-stream.test.ts` covers image tool-result conversion and image payload shape.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/model.provider-runtime.test-support.ts` defines Anthropic vision model prefixes used in provider runtime test support.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "Anthropic media image PDF Claude"`

Results:

- Returned no direct results for Anthropic media/image/PDF reports.

### Discrawl queries

Query: `discrawl search --limit 10 "Anthropic media understanding image PDF Claude"`

Results:

- Returned no direct results for Anthropic media/image/PDF reports.
