---
title: "Long-tail hosted providers - Provider Catalog and Discovery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Long-tail hosted providers - Provider Catalog and Discovery Maturity Note

## Summary

Provider registry and docs catalog is Alpha. The provider directory is broad and
the manifest/provider install catalog plumbing is real, but the catalog remains
partly hand-maintained and spread across several sources of truth.

## Category Scope

This note covers the public provider directory, provider docs links, model
provider overview tables, manifest provider metadata, model catalog metadata,
official external provider catalog entries, provider index preview rows, and
install/catalog lookup behavior.

Out of scope: local-only providers, first-party provider scorecards when scored
separately, and provider runtime behavior after a provider has already been
selected.

## Features

- Provider directory: Covers Provider directory across public provider directory, provider docs links, model provider overview tables, manifest provider metadata, and related provider catalog and discovery behavior.
- Provider install catalog: Covers Provider install catalog across public provider directory, provider docs links, model provider overview tables, manifest provider metadata, and related provider catalog and discovery behavior.
- Model catalog metadata: Covers Model catalog metadata across public provider directory, provider docs links, model provider overview tables, manifest provider metadata, and related provider catalog and discovery behavior.
- Catalog parity checks: Covers Catalog parity checks across public provider directory, provider docs links, model provider overview tables, manifest provider metadata, and related provider catalog and discovery behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (64%)`
- Positive signals:
  - `docs/providers/index.md` lists dozens of hosted provider docs, shared generation overviews, and transcription providers.
  - `docs/concepts/model-providers.md` explains plugin-owned provider behavior and has a bundled provider table with long-tail provider ids, auth env vars, and example models.
  - `docs/plugins/manifest.md` documents manifest-owned `providers`, `providerCatalogEntry`, `modelCatalog`, provider auth/env/setup metadata, contracts, and generation metadata.
  - Source merges manifest, official external provider catalog, and provider-index install metadata into provider install choices.
  - Unit and command-flow tests cover provider install metadata, provider discovery fallback, manifest provider catalog source path fallback, and `models list` provider catalog rows.
- Negative signals:
  - Catalog proof is not generated end to end from one authoritative provider metadata source.
  - The helper pass found provider pages not linked from the main provider docs list: `deepinfra`, `inworld`, and `pixverse`.
  - `OPENCLAW_PROVIDER_INDEX` is deliberately a small preview fallback with only Moonshot and DeepSeek entries in the current source.
  - Live tests prove selected provider paths, but not public docs/catalog parity for the whole hosted-provider tail.

## Quality Score

- Score: `Alpha (61%)`
- Good qualities:
  - Manifest metadata keeps provider docs, model catalogs, setup descriptors, auth metadata, contracts, and generation metadata cheaply inspectable before runtime loads.
  - Install catalog resolution has explicit merging and deduping across installed manifests, official external entries, and provider-index preview rows.
  - Docs clearly tell users that provider plugins own catalogs, auth env mapping, request normalization, failover classification, OAuth refresh, usage reporting, and reasoning profiles.
- Bad qualities:
  - Metadata is fragmented across manifests, `scripts/lib/official-external-provider-catalog.json`, `OPENCLAW_PROVIDER_INDEX`, provider-specific runtime catalog modules, and hand-maintained docs.
  - Public docs/catalog drift is already observable in this audit.
  - Archive history shows recurring provider identity, prefix, stale-model, auth, and media-provider registration confusion.
- Excluded from quality:
  - Unit, integration, and live evidence were used only for Coverage scoring.

## Completeness Score

- Score: `Alpha (64%)`
- Surface instructions: evaluated against `references/completeness/long-tail-hosted-providers.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Provider directory, Provider install catalog, Model catalog metadata, Catalog parity checks.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a provider-directory parity check that compares docs links, bundled
  manifests, official external provider entries, and provider docs files.
- Add a generated provider inventory artifact for long-tail hosted providers.
- Track provider catalog drift as an explicit scorecard freshness check.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/index.md:25`: public provider docs list starts with Alibaba, Bedrock, Bedrock Mantle, Anthropic, Arcee, Azure Speech, BytePlus, Cerebras, Chutes, Cloudflare AI Gateway, ComfyUI, DeepSeek, ElevenLabs, fal, Fireworks, GitHub Copilot, Google, Gradium, Groq, Hugging Face, Kilo, LiteLLM, MiniMax, Mistral, Moonshot, NVIDIA, OpenCode, OpenRouter, Qianfan, Qwen, Runway, SenseAudio, StepFun, Synthetic, Tencent, Together, Venice, Vercel AI Gateway, Volcengine, Vydra, xAI, Xiaomi, and Z.AI.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:80`: shared image, music, and video generation overview pages are linked from the provider directory.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:87`: transcription providers include Deepgram, ElevenLabs, Mistral, OpenAI, SenseAudio, and xAI.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md:51`: provider-specific logic lives in plugins; plugins own onboarding, catalogs, auth env mapping, request normalization, failover classification, OAuth refresh, usage reporting, and reasoning profiles.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md:291`: the "Other bundled provider plugins" table lists many long-tail providers, ids, auth env vars, and example models.
- `/Users/kevinlin/code/openclaw/docs/plugins/manifest.md:151`: manifest top-level fields include `providers`, `providerCatalogEntry`, `modelCatalog`, provider endpoints, provider request metadata, provider auth env vars, provider auth choices, setup, contracts, and generation metadata.

### Source

- `/Users/kevinlin/code/openclaw/scripts/lib/official-external-provider-catalog.json:1`: official external provider catalog currently contains five entries, including Bedrock, Bedrock Mantle, Anthropic Vertex, Codex, and PixVerse.
- `/Users/kevinlin/code/openclaw/src/model-catalog/provider-index/openclaw-provider-index.ts:3`: `OPENCLAW_PROVIDER_INDEX` is fallback preview metadata; installed plugin manifests remain authoritative.
- `/Users/kevinlin/code/openclaw/src/model-catalog/provider-index/openclaw-provider-index.ts:12`: current preview provider entries are Moonshot and DeepSeek.
- `/Users/kevinlin/code/openclaw/src/plugins/provider-install-catalog.ts:213`: provider-index install entries are built only for not-installed provider plugins with auth choices.
- `/Users/kevinlin/code/openclaw/src/plugins/provider-install-catalog.ts:278`: official external provider catalog entries are normalized into provider install catalog choices.
- `/Users/kevinlin/code/openclaw/src/plugins/provider-install-catalog.ts:342`: final provider install catalog returns manifest entries, official external entries, and provider-index entries sorted together.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/commands/models.list.e2e.test.ts:572`: command-flow coverage checks `models list --all` provider catalog rows and local-mode exclusion.
- `/Users/kevinlin/code/openclaw/src/commands/models/list.list-command.forward-compat.test.ts:381`: forward-compat tests cover manifest, provider-index, static provider catalog, configured/auth-backed, and provider-filtered list paths.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:58`: live model smoke docs split direct provider/model proof from Gateway+agent smoke.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:372`: live model matrix docs explicitly say there is no fixed CI model list.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/plugins/provider-install-catalog.test.ts:559`: unit coverage verifies official external provider install metadata.
- `/Users/kevinlin/code/openclaw/src/plugins/provider-discovery.runtime.test.ts:160`: unit coverage verifies static discovery entries and bounded fallback.
- `/Users/kevinlin/code/openclaw/src/plugins/manifest-registry.test.ts:1415`: unit coverage verifies provider catalog source path fallback and root-boundary hardening.

### Gitcrawl queries

- `gitcrawl --json search issues -R openclaw/openclaw "long-tail hosted providers provider metadata"` returned `[]`.
- `gitcrawl --json search prs -R openclaw/openclaw "provider metadata model catalog"` returned provider metadata/catalog PRs including #84581, #84902, #84997, #84566, #75022, #85345, #67579, #83292, #69729, #86670, and #43493.
- Helper query `models list provider catalog` found broad dynamic-catalog and stale-catalog history, including #10687, #74481, #74986, #81216, and #87746.
- Helper query `NVIDIA provider catalog model prefix` found #81525, a provider-prefix/catalog mismatch risk.

### Discrawl queries

- `env DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search "long-tail hosted provider metadata" --limit 5` returned `null`.
- Helper query `DeepInfra provider catalog` returned release/review history about no-auth discovery, preserve-order fallback, duplicate live fetch, and credential-aware catalog browsing.
- Helper query `Chutes provider catalog` returned review history about fast-path partial results, synthetic auth causing live catalog calls, slash-containing IDs, plugin discovery, and auth precedence.
- Helper query `Venice provider catalog OpenClaw` returned stale allowlist/model discovery drift and tool-support catalog mismatch history.
