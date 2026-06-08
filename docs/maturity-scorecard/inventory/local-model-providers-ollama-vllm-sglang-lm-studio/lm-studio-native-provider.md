---
title: "Local model providers: Ollama, vLLM, SGLang, LM Studio - LM Studio Native Provider Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Local model providers: Ollama, vLLM, SGLang, LM Studio - LM Studio Native Provider Maturity Note

## Summary

The LM Studio provider is a bundled, enabled-by-default provider plugin with
interactive and non-interactive setup, model discovery, synthetic local auth,
model preload, streaming usage compatibility, and a memory embedding adapter.
Its docs and source are materially stronger than a generic proxy entry, but
archive evidence still shows endpoint mismatch, resource-pressure, and timeout
confusion in real use.

## Category Scope

This category covers the LM Studio provider plugin, `/providers/lmstudio`
docs, model discovery from LM Studio APIs, auth behavior for local and
authenticated instances, preload/JIT behavior, OpenAI-compatible streaming,
and LM Studio memory embeddings.

## Features

- LM Studio setup: Covers LM Studio setup across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.
- Model discovery and auth: Covers Model discovery and auth across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.
- Model preload and JIT loading: Covers Model preload and JIT loading across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.
- Streaming compatibility: Covers Streaming compatibility across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.
- LM Studio embeddings: Covers LM Studio embeddings across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals:
  - `/Users/kevinlin/code/openclaw/extensions/lmstudio/openclaw.plugin.json:2`
    declares provider id `lmstudio`, enabled-by-default status, streaming usage
    support, setup env vars, non-secret auth marker, and memory embedding
    contract.
  - `/Users/kevinlin/code/openclaw/extensions/lmstudio/index.ts:55`
    registers the provider; line 56 registers the memory embedding provider;
    lines 69-89 wire setup and discovery.
  - `/Users/kevinlin/code/openclaw/extensions/lmstudio/src/models.fetch.ts:74`
    fetches `/api/v1/models`, and line 183 starts native model-load preflight.
  - `/Users/kevinlin/code/openclaw/extensions/lmstudio/src/stream.ts:176`
    wraps the base stream with plain-text local tool-call compatibility and
    preload behavior.
- Negative signals:
  - The audit found strong component-level tests but no dedicated live LM
    Studio test file equivalent to the Ollama live test.
  - Runtime behavior depends on external LM Studio state: model loaded or
    loadable, authentication mode, JIT/TTL settings, and system memory.
- Integration gaps:
  - Add a live or fixture-backed LM Studio scenario covering setup, catalog
    discovery, preload fallback, an agent turn, and memory embedding use.

## Quality Score

- Score: `Beta (78%)`
- Gitcrawl reports:
  - Query `LM Studio local provider` returned issue #80495 for environment
    variable expansion and API endpoint mismatch, PR #77053 for opt-in idle TTL
    through the native load API, issue #87616 for fast LLM request timeouts, and
    PR #75198 for provider-qualified aliases.
  - Query `LM Studio timeout local provider` returned issue #87616 for LM Studio
    timeout behavior.
- Discrawl reports:
  - Query `LM Studio local provider` returned maintainer discussion that local
    model calls to LM Studio/Ollama/vLLM/llama-server were denied by SSRF guard
    until narrow exact-origin trust was added.
  - Query `LM Studio timeout local provider` returned repeated community
    evidence around LM Studio timeout/resource-pressure confusion, including
    model-load guardrail failures.
- Good qualities:
  - The plugin normalizes user-copied LM Studio URLs, supports synthetic local
    auth, preloads models when appropriate, and degrades preload failures without
    blocking the underlying stream.
  - Documentation now distinguishes unauthenticated local servers, auth-enabled
    servers, LAN/tailnet hosts, JIT loading, and streaming usage recovery.
- Bad qualities:
  - LM Studio's external state remains high variance; unloaded models,
    insufficient memory, and endpoint/auth mismatch produce user confusion.
  - The native provider is still a local runtime integration rather than a fully
    controlled service, so operator clarity matters more than usual.
- Excluded from quality:
  - Test coverage, integration depth, and lack of tests were not used as
    Quality inputs.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/local-model-providers-ollama-vllm-sglang-lm-studio.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for LM Studio setup, Model discovery and auth, Model preload and JIT loading, Streaming compatibility, LM Studio embeddings.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Live verification for LM Studio should cover both authenticated and
  unauthenticated local servers.
- Operator docs could better connect LM Studio preload/JIT failures to
  actionable memory and model-size guidance.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/lmstudio.md:11` starts the LM
  Studio quick start; lines 33-41 document optional authentication.
- `/Users/kevinlin/code/openclaw/docs/providers/lmstudio.md:61` documents
  non-interactive onboarding; lines 84-94 explain model IDs and profile writes.
- `/Users/kevinlin/code/openclaw/docs/providers/lmstudio.md:101` documents
  streaming usage compatibility.
- `/Users/kevinlin/code/openclaw/docs/providers/lmstudio.md:180` documents JIT
  loading and disabling OpenClaw preload.
- `/Users/kevinlin/code/openclaw/docs/providers/lmstudio.md:199` documents
  LAN/tailnet LM Studio hosts and exact-origin trust.

### Source

- `/Users/kevinlin/code/openclaw/extensions/lmstudio/openclaw.plugin.json:25`
  declares `lmstudio-local` as a non-secret auth marker.
- `/Users/kevinlin/code/openclaw/extensions/lmstudio/index.ts:92` synthesizes
  local auth when needed.
- `/Users/kevinlin/code/openclaw/extensions/lmstudio/src/models.ts:293`
  resolves LM Studio server base URLs and normalizes `/v1`/`/api/v1`.
- `/Users/kevinlin/code/openclaw/extensions/lmstudio/src/models.fetch.ts:183`
  ensures a model is loaded before inference.
- `/Users/kevinlin/code/openclaw/extensions/lmstudio/src/embedding-provider.ts:67`
  creates the LM Studio memory embedding provider and preloads the embedding
  model.

### Integration tests

- No dedicated live LM Studio test file was found in this audit.
- `/Users/kevinlin/code/openclaw/extensions/lmstudio/src/stream.test.ts:179`
  exercises preload before inference against a mocked runtime.
- `/Users/kevinlin/code/openclaw/extensions/lmstudio/src/setup.test.ts:1454`
  covers discovered-provider config paths.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/lmstudio/index.test.ts:36` verifies
  URL canonicalization.
- `/Users/kevinlin/code/openclaw/extensions/lmstudio/index.test.ts:54`
  verifies synthetic placeholder auth for configured local models.
- `/Users/kevinlin/code/openclaw/extensions/lmstudio/src/models.test.ts:256`
  verifies LM Studio model discovery and metadata mapping.
- `/Users/kevinlin/code/openclaw/extensions/lmstudio/src/stream.test.ts:498`
  verifies streaming usage compatibility is forced before the underlying stream.
- `/Users/kevinlin/code/openclaw/extensions/lmstudio/src/setup.test.ts:800`
  verifies blank API key acceptance for local unauthenticated LM Studio.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "LM Studio local provider" --json --limit 5`

Results:

- Returned issue #80495 on LM Studio provider endpoint/auth mismatch, PR
  #77053 for native load API idle TTL, issue #87616 on fast local timeout
  behavior, and PR #75198 around provider-qualified aliases.

Query: `gitcrawl search openclaw/openclaw --query "LM Studio timeout local provider" --json --limit 5`

Results:

- Returned issue #87616, reporting a fast timeout while routing to local LM
  Studio, plus a session-isolated app-server client PR touching LM Studio
  provider expectations.

### Discrawl queries

Query: `discrawl search --mode hybrid --limit 5 "LM Studio local provider"`

Results:

- Returned maintainer discussion for draft PR #80751 about SSRF guard blocking
  localhost model calls to LM Studio, Ollama, vLLM, or llama-server and the need
  for exact-origin local provider trust.

Query: `discrawl search --mode hybrid --limit 5 "LM Studio timeout local provider"`

Results:

- Returned community and maintainer reports that local/self-hosted pain clusters
  around tool-calling reliability, timeouts, private LAN endpoints, and LM
  Studio model-load resource guardrail failures.
