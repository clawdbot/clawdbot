---
title: "Local model providers: Ollama, vLLM, SGLang, LM Studio - Local Memory and Embeddings Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Local model providers: Ollama, vLLM, SGLang, LM Studio - Local Memory and Embeddings Maturity Note

## Summary

OpenClaw can use local providers for memory embeddings and memory flush model
selection, with Ollama and LM Studio exposing embedding provider contracts and
memory core degrading toward lexical fallback when embeddings are unavailable.
Coverage is credible for provider registration and fallback behavior, but the
overall user journey is still fragile because chat provider selection, memory
embedding model selection, vector dimensions, and rebuild behavior can diverge.

## Category Scope

Included in this category:

- Embedding provider selection: Covers Embedding provider selection across local embedding provider registration for Ollama and LM Studio, memory host embedding behavior, memory search readiness, local `memoryFlush` model overrides, and related local embeddings and memory behavior.
- Memory search readiness: Covers Memory search readiness across local embedding provider registration for Ollama and LM Studio, memory host embedding behavior, memory search readiness, local `memoryFlush` model overrides, and related local embeddings and memory behavior.
- memoryFlush model override: Covers memoryFlush model override across local embedding provider registration for Ollama and LM Studio, memory host embedding behavior, memory search readiness, local `memoryFlush` model overrides, and related local embeddings and memory behavior.
- Fallback lexical search: Covers Fallback lexical search across local embedding provider registration for Ollama and LM Studio, memory host embedding behavior, memory search readiness, local `memoryFlush` model overrides, and related local embeddings and memory behavior.
- Provider mismatch guidance: Covers Provider mismatch guidance across local embedding provider registration for Ollama and LM Studio, memory host embedding behavior, memory search readiness, local `memoryFlush` model overrides, and related local embeddings and memory behavior.

## Features

- Embedding provider selection: Covers Embedding provider selection across local embedding provider registration for Ollama and LM Studio, memory host embedding behavior, memory search readiness, local `memoryFlush` model overrides, and related local embeddings and memory behavior.
- Memory search readiness: Covers Memory search readiness across local embedding provider registration for Ollama and LM Studio, memory host embedding behavior, memory search readiness, local `memoryFlush` model overrides, and related local embeddings and memory behavior.
- memoryFlush model override: Covers memoryFlush model override across local embedding provider registration for Ollama and LM Studio, memory host embedding behavior, memory search readiness, local `memoryFlush` model overrides, and related local embeddings and memory behavior.
- Fallback lexical search: Covers Fallback lexical search across local embedding provider registration for Ollama and LM Studio, memory host embedding behavior, memory search readiness, local `memoryFlush` model overrides, and related local embeddings and memory behavior.
- Provider mismatch guidance: Covers Provider mismatch guidance across local embedding provider registration for Ollama and LM Studio, memory host embedding behavior, memory search readiness, local `memoryFlush` model overrides, and related local embeddings and memory behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals:
  - `/Users/kevinlin/code/openclaw/docs/concepts/memory.md:141` through line
    154 document memory search providers, including local, Ollama, and
    OpenAI-compatible options.
  - `/Users/kevinlin/code/openclaw/docs/concepts/memory.md:171` through line
    174 document LanceDB local Ollama embedding support.
  - `/Users/kevinlin/code/openclaw/docs/concepts/memory.md:192` through line
    210 document local `memoryFlush` model overrides.
  - `/Users/kevinlin/code/openclaw/extensions/lmstudio/src/embedding-provider.ts:67`
    through line 145 implement LM Studio embeddings and warmup behavior.
  - `/Users/kevinlin/code/openclaw/extensions/memory-core/src/memory/manager.ts:346`
    through line 359 handle local provider degradation after worker failure.
- Negative signals:
  - vLLM and SGLang are covered through OpenAI-compatible provider mechanics,
    but first-class local embedding provider evidence is much stronger for
    Ollama and LM Studio.
  - Dimension changes, provider mismatch, and fallback/rebuild behavior are
    difficult to understand from a single user-facing page.
- Integration gaps:
  - Add a smoke that configures local chat plus local embeddings, indexes a
    small memory set, verifies vector dimensions, restarts with an unavailable
    embedding provider, and checks lexical fallback messaging.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports:
  - Query `local embeddings Ollama mixed OpenAI vector` returned issue #83333,
    showing user pressure around local embeddings and mixed provider/vector
    configuration.
  - Query `Ollama LM Studio memory embeddings local provider` returned issue
    #81961, which also requested a dashboard for managing local providers.
- Discrawl reports:
  - Query `local embeddings Ollama mixed OpenAI vector` returned guidance about
    hosted OpenAI embeddings, QMD local models, and dimension mismatch.
  - Query `Ollama LM Studio memory embeddings local provider` returned support
    threads about local chat versus memory embeddings and local provider
    mismatch.
- Good qualities:
  - Memory core degrades rather than hard failing in several embedding
    unavailable paths, and docs acknowledge local embedding providers directly.
  - Ollama and LM Studio expose provider contracts for memory embedding instead
    of treating embeddings as an unrelated external service.
- Bad qualities:
  - The local chat provider and local memory embedding provider are still
    separate user concepts, which makes mixed-provider and dimension mismatch
    failures easy to create.
  - Archive evidence shows users need help distinguishing "local model for
    chat" from "local model for memory embeddings".
- Excluded from quality:
  - Embedding provider test coverage and memory-host test depth were not used
    as Quality inputs.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/local-model-providers-ollama-vllm-sglang-lm-studio.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Embedding provider selection, Memory search readiness, memoryFlush model override, Fallback lexical search, Provider mismatch guidance.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No single local-model setup flow was found that configures chat, embeddings,
  memory flush, vector dimension expectations, and fallback behavior together.
- vLLM and SGLang local embedding guidance is less direct than Ollama and LM
  Studio guidance.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/concepts/memory.md:141` documents memory
  search provider options.
- `/Users/kevinlin/code/openclaw/docs/concepts/memory.md:171` documents local
  Ollama embedding support with LanceDB.
- `/Users/kevinlin/code/openclaw/docs/concepts/memory.md:192` documents
  local-model `memoryFlush` overrides.
- `/Users/kevinlin/code/openclaw/docs/gateway/doctor.md:512` documents memory
  search readiness checks.

### Source

- `/Users/kevinlin/code/openclaw/extensions/lmstudio/openclaw.plugin.json:51`
  declares LM Studio memory embedding capability.
- `/Users/kevinlin/code/openclaw/extensions/ollama/openclaw.plugin.json:45`
  declares Ollama memory and web-search contracts.
- `/Users/kevinlin/code/openclaw/extensions/lmstudio/src/embedding-provider.ts:67`
  implements LM Studio embeddings.
- `/Users/kevinlin/code/openclaw/extensions/ollama/index.ts:132` registers
  Ollama memory embedding support.
- `/Users/kevinlin/code/openclaw/extensions/ollama/index.ts:247` wires the
  Ollama embedding provider.
- `/Users/kevinlin/code/openclaw/extensions/memory-core/src/memory/manager.ts:346`
  marks local providers degraded after worker failure.
- `/Users/kevinlin/code/openclaw/extensions/memory-core/src/memory/manager.ts:1009`
  handles embedding-unavailable fallback.

### Integration tests

- `/Users/kevinlin/code/openclaw/packages/memory-host-sdk/src/host/embeddings.test.ts:339`
  covers worker-process embedding behavior.
- `/Users/kevinlin/code/openclaw/extensions/memory-core/src/memory/manager-sync-ops.ts:1398`
  aborts when a configured embedding provider is unavailable.

### Unit tests

- `/Users/kevinlin/code/openclaw/packages/memory-host-sdk/src/host/embeddings.test.ts:72`
  covers local embedding provider default model handling.
- `/Users/kevinlin/code/openclaw/packages/memory-host-sdk/src/host/embeddings.test.ts:156`
  covers sequential batch behavior.
- `/Users/kevinlin/code/openclaw/packages/memory-host-sdk/src/host/embeddings.test.ts:189`
  covers model path and cache behavior.
- `/Users/kevinlin/code/openclaw/extensions/ollama/src/embedding-provider.test.ts:104`
  covers calls to `/api/embed` and local origin routing.
- `/Users/kevinlin/code/openclaw/extensions/ollama/src/embedding-provider.test.ts:149`
  covers cloud origin handling.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "local embeddings Ollama mixed OpenAI vector" --json --limit 5`

Results:

- Returned issue #83333, relevant to mixed local embedding and vector
  configuration.

Query: `gitcrawl search openclaw/openclaw --query "Ollama LM Studio memory embeddings local provider" --json --limit 5`

Results:

- Returned issue #81961, which requests a model-provider management surface
  including local providers.

### Discrawl queries

Query: `discrawl search --mode hybrid --limit 5 "local embeddings Ollama mixed OpenAI vector"`

Results:

- Returned support guidance about hosted OpenAI embeddings, QMD local models,
  and dimension mismatch.

Query: `discrawl search --mode hybrid --limit 5 "Ollama LM Studio memory embeddings local provider"`

Results:

- Returned support threads about local chat versus memory embeddings and local
  provider mismatch.
