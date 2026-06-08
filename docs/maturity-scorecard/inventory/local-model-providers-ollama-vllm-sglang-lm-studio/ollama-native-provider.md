---
title: "Local model providers: Ollama, vLLM, SGLang, LM Studio - Native Provider Plugins Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Local model providers: Ollama, vLLM, SGLang, LM Studio - Native Provider Plugins Maturity Note

## Summary

Ollama is the most deeply integrated local provider in this surface: the plugin
uses native Ollama API semantics, has discovery, setup, stream, web-search,
vision, embedding, policy, WSL2-risk, and live-test coverage, and docs warn
against the `/v1` OpenAI-compatible path for tool calling. Quality is reduced by
the volume of lived operational issues around unreachable local endpoints,
cron/fallback behavior, cloud cooldowns, native/local mode confusion, and memory
embedding cutovers.

## Category Scope

Included in this category:

- Ollama setup and model pulling: Covers Ollama setup and model pulling across native Ollama chat/model discovery, cloud+local/local-only setup, local auth markers, model pulling, and related ollama native provider behavior.
- Model discovery: Covers Model discovery across native Ollama chat/model discovery, cloud+local/local-only setup, local auth markers, model pulling, and related ollama native provider behavior.
- Streaming and vision: Covers Streaming and vision across native Ollama chat/model discovery, cloud+local/local-only setup, local auth markers, model pulling, and related ollama native provider behavior.
- Ollama embeddings: Covers Ollama embeddings across native Ollama chat/model discovery, cloud+local/local-only setup, local auth markers, model pulling, and related ollama native provider behavior.
- Web-search support: Covers Web-search support across native Ollama chat/model discovery, cloud+local/local-only setup, local auth markers, model pulling, and related ollama native provider behavior.
- LM Studio setup: Covers LM Studio setup across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.
- Model discovery and auth: Covers Model discovery and auth across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.
- Model preload and JIT loading: Covers Model preload and JIT loading across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.
- Streaming compatibility: Covers Streaming compatibility across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.
- LM Studio embeddings: Covers LM Studio embeddings across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.

## Features

- Ollama setup and model pulling: Covers Ollama setup and model pulling across native Ollama chat/model discovery, cloud+local/local-only setup, local auth markers, model pulling, and related ollama native provider behavior.
- Model discovery: Covers Model discovery across native Ollama chat/model discovery, cloud+local/local-only setup, local auth markers, model pulling, and related ollama native provider behavior.
- Streaming and vision: Covers Streaming and vision across native Ollama chat/model discovery, cloud+local/local-only setup, local auth markers, model pulling, and related ollama native provider behavior.
- Ollama embeddings: Covers Ollama embeddings across native Ollama chat/model discovery, cloud+local/local-only setup, local auth markers, model pulling, and related ollama native provider behavior.
- Web-search support: Covers Web-search support across native Ollama chat/model discovery, cloud+local/local-only setup, local auth markers, model pulling, and related ollama native provider behavior.
- LM Studio setup: Covers LM Studio setup across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.
- Model discovery and auth: Covers Model discovery and auth across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.
- Model preload and JIT loading: Covers Model preload and JIT loading across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.
- Streaming compatibility: Covers Streaming compatibility across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.
- LM Studio embeddings: Covers LM Studio embeddings across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (86%)`
- Positive signals:
  - `/Users/kevinlin/code/openclaw/extensions/ollama/openclaw.plugin.json:2`
    declares the `ollama` provider, enabled-by-default plugin, model-catalog
    entry, local auth marker, setup env var, memory embedding, and web-search
    contracts.
  - `/Users/kevinlin/code/openclaw/extensions/ollama/index.ts:128` registers
    the provider; lines 132-143 register memory embedding, media understanding,
    web search, and WSL2 crash-loop checks.
  - `/Users/kevinlin/code/openclaw/docs/providers/ollama.md:180` documents
    implicit model discovery; lines 255-280 document live test commands for
    local and cloud Ollama.
  - `/Users/kevinlin/code/openclaw/extensions/ollama/ollama.live.test.ts:161`
    live-tests `infer model run`; lines 196-254 live-test native streaming; and
    lines 271-329 live-test embeddings and web search.
- Negative signals:
  - Some behavior is intentionally split between native Ollama and
    OpenAI-compatible Ollama config, increasing operator foot-guns.
  - Live coverage depends on an external Ollama runtime and env gates, so it is
    not always exercised in ordinary CI.
- Integration gaps:
  - Add routine CI or scheduled live proof for the native local text path,
    exact model selection, cloud+local mode, and fallback semantics.

## Quality Score

- Score: `Beta (78%)`
- Gitcrawl reports:
  - Query `Ollama local provider` returned issue #79329 about cron preflight
    skipping a run when local primary was unreachable, issue #74986 about
    `infer model run --local` hangs, and issue #81214 around subagent runtime
    using local/remote Ollama.
  - Query `Ollama cron local unreachable` returned issue #79329 and PR #82887,
    which fixed cron fallback preflight behavior.
- Discrawl reports:
  - Query `Ollama local provider` returned community confirmation of testing
    with a real local Ollama provider.
  - Query `Ollama cron local unreachable` returned support guidance around
    `ollama list`, Docker/Podman `127.0.0.1` mismatch, gateway status, model
    status, and last cron-run inspection.
- Good qualities:
  - Native API guidance directly avoids the common `/v1` raw-tool-call failure.
  - The provider handles local/LAN auth markers, cloud mode, discovery, model
    metadata, vision, embeddings, web search, and WSL2-specific risk.
- Bad qualities:
  - A stopped local daemon, Docker host mismatch, wrong model id, or cloud/local
    mode mismatch can still create confusing failure states.
  - Archive evidence includes multiple recent bugs or support threads around
    local reachability, cron fallback behavior, hangs, and cooldowns.
- Excluded from quality:
  - Test coverage, integration depth, and lack of tests were not used as
    Quality inputs.

## Completeness Score

- Score: `Stable (86%)`
- Surface instructions: evaluated against `references/completeness/local-model-providers-ollama-vllm-sglang-lm-studio.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Ollama setup and model pulling, Model discovery, Streaming and vision, Ollama embeddings, Web-search support, LM Studio setup, Model discovery and auth, Model preload and JIT loading, Streaming compatibility, LM Studio embeddings.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Cron and background workflows should continue to get clearer operator
  messages when a local Ollama primary is down but fallbacks exist.
- The docs could better expose one diagnostic decision tree for native Ollama
  versus OpenAI-compatible Ollama mistakes.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/ollama.md:10` describes native
  API integration for cloud and local/self-hosted servers.
- `/Users/kevinlin/code/openclaw/docs/providers/ollama.md:12` warns remote
  users not to use the `/v1` OpenAI-compatible URL because it breaks tool
  calling.
- `/Users/kevinlin/code/openclaw/docs/providers/ollama.md:180` documents
  implicit provider discovery and `/api/tags`/`/api/show` metadata.
- `/Users/kevinlin/code/openclaw/docs/providers/ollama.md:248` documents
  isolated cron preflight behavior for unreachable local Ollama endpoints.
- `/Users/kevinlin/code/openclaw/docs/providers/ollama.md:294` documents
  Ollama vision and image-description support.

### Source

- `/Users/kevinlin/code/openclaw/extensions/ollama/index.ts:132` registers the
  memory embedding provider; line 133 registers media understanding; line 142
  registers web search.
- `/Users/kevinlin/code/openclaw/extensions/ollama/src/discovery-shared.ts:117`
  classifies local Ollama base URLs.
- `/Users/kevinlin/code/openclaw/extensions/ollama/provider-discovery.ts:39`
  runs provider discovery through the plugin-catalog path.
- `/Users/kevinlin/code/openclaw/extensions/ollama/runtime-api.ts:3` exports
  native stream, compat, and num-ctx wrapper APIs.
- `/Users/kevinlin/code/openclaw/extensions/ollama/src/embedding-provider.ts`
  owns Ollama memory embedding client behavior.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/ollama/ollama.live.test.ts:161`
  live-tests local CLI `infer model run`.
- `/Users/kevinlin/code/openclaw/extensions/ollama/ollama.live.test.ts:196`
  live-tests native chat with a custom provider prefix.
- `/Users/kevinlin/code/openclaw/extensions/ollama/ollama.live.test.ts:271`
  live-tests embeddings through the current Ollama endpoint.
- `/Users/kevinlin/code/openclaw/extensions/ollama/ollama.live.test.ts:301`
  live-tests Ollama web-search fallback endpoints.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/ollama/provider-discovery.test.ts:136`
  verifies native `api: "ollama"` implicit provider injection.
- `/Users/kevinlin/code/openclaw/extensions/ollama/provider-discovery.test.ts:178`
  verifies context-window discovery from `/api/show`.
- `/Users/kevinlin/code/openclaw/extensions/ollama/src/setup.test.ts:450`
  verifies `/api/show` context windows during setup.
- `/Users/kevinlin/code/openclaw/extensions/ollama/src/stream-runtime.test.ts:76`
  covers native Ollama chat request construction.
- `/Users/kevinlin/code/openclaw/extensions/ollama/src/embedding-provider.test.ts:104`
  verifies `/api/embed` embedding calls and vector normalization.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "Ollama local provider" --json --limit 5`

Results:

- Returned issue #79329 on cron local-provider reachability, PR #85373 on
  resolved model runtime through auth, issue #74986 on `infer model run
--local` hangs, PR #87558 on dense local-provider streaming, and issue #81214
  on subagent/runtime use of Ollama.

Query: `gitcrawl search openclaw/openclaw --query "Ollama cron local unreachable" --json --limit 5`

Results:

- Returned issue #79329 and PR #82887, the fix for preflighting model fallbacks
  before cron skip behavior.

### Discrawl queries

Query: `discrawl search --mode hybrid --limit 5 "Ollama local provider"`

Results:

- Returned recent community messages mentioning real local Ollama provider
  testing.

Query: `discrawl search --mode hybrid --limit 5 "Ollama cron local unreachable"`

Results:

- Returned support guidance that distinguishes wrong model id, missing
  env/config, Docker base URL mismatch, and unreachable Ollama host.
