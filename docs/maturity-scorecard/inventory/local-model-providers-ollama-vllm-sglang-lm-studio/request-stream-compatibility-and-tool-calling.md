---
title: "Local model providers: Ollama, vLLM, SGLang, LM Studio - OpenAI-Compatible Runtime Compatibility Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Local model providers: Ollama, vLLM, SGLang, LM Studio - OpenAI-Compatible Runtime Compatibility Maturity Note

## Summary

OpenClaw has mature compatibility machinery for local provider request and
stream differences: docs explain strict OpenAI-compatible backends, provider
code wraps LM Studio, Ollama, vLLM, and SGLang behavior, and tests cover raw
tool-call text, thinking flags, strict message keys, and context controls.
The remaining risk is operational: local servers still differ by model,
template, parser, and runtime flags, so users can reach raw tool-call output or
provider-specific failures even when the code path is covered.

## Category Scope

Included in this category:

- Bundled provider setup: Covers Bundled provider setup across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- Model Discovery Endpoint: Covers Model Discovery Endpoint across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- Non-interactive configuration: Covers Non-interactive configuration across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- vLLM thinking controls: Covers vLLM thinking controls across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- OpenAI-compatible chat and tool semantics: Covers OpenAI-compatible chat and tool semantics across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- SGLang compatibility guidance: Covers SGLang compatibility guidance across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- Request Stream Compatibility: Covers Request Stream Compatibility across chat and Responses-style request shaping, streaming normalization, tool-call compatibility, local-model reasoning controls, and related request stream compatibility and tool calling behavior.
- Tool Calling: Covers Tool Calling across chat and Responses-style request shaping, streaming normalization, tool-call compatibility, local-model reasoning controls, and related request stream compatibility and tool calling behavior.

## Features

- Bundled provider setup: Covers Bundled provider setup across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- Model Discovery Endpoint: Covers Model Discovery Endpoint across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- Non-interactive configuration: Covers Non-interactive configuration across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- vLLM thinking controls: Covers vLLM thinking controls across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- OpenAI-compatible chat and tool semantics: Covers OpenAI-compatible chat and tool semantics across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- SGLang compatibility guidance: Covers SGLang compatibility guidance across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- Request Stream Compatibility: Covers Request Stream Compatibility across chat and Responses-style request shaping, streaming normalization, tool-call compatibility, local-model reasoning controls, and related request stream compatibility and tool calling behavior.
- Tool Calling: Covers Tool Calling across chat and Responses-style request shaping, streaming normalization, tool-call compatibility, local-model reasoning controls, and related request stream compatibility and tool calling behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals:
  - `/Users/kevinlin/code/openclaw/docs/gateway/local-models.md:218` through
    line 260 document strict backend behavior, `requiresStringContent`, and
    tool-call compatibility.
  - `/Users/kevinlin/code/openclaw/docs/gateway/local-models.md:268` through
    line 300 document reasoning-effort and thinking controls for local
    backends.
  - `/Users/kevinlin/code/openclaw/extensions/lmstudio/src/stream.ts:176`
    through line 264 handles preload and streaming usage compatibility.
  - `/Users/kevinlin/code/openclaw/extensions/vllm/stream.ts:13` through line
    140 wraps vLLM stream behavior, including compatibility helpers.
  - `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/replay-history.ts:828`
    keeps strict OpenAI-compatible providers from receiving unsupported
    assistant metadata.
- Negative signals:
  - Tool-call success still depends on backend parser and chat-template
    configuration that OpenClaw can document and adapt to but not fully
    enforce across all local model servers.
  - SGLang shares the OpenAI-compatible path but has less provider-specific
    stream evidence than LM Studio, Ollama, and vLLM.
- Integration gaps:
  - Add a local-server fixture matrix for raw JSON, bracketed text, Harmony
    tool text, strict OpenAI-compatible message replay, and thinking controls
    across the named local provider families.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports:
  - Query `vLLM tool calls raw text` returned issue #87687 and PR #79702,
    showing real pressure around vLLM tool-call output and provider-specific
    parser/template behavior.
  - Query `local model tool calls raw JSON` returned issue #85883 and related
    tool-call failure discussions.
- Discrawl reports:
  - Query `vLLM tool calls raw text` returned support threads where local
    models emitted raw `<tool_call>` XML or text and users needed vLLM parser
    or template guidance.
  - Query `OpenAI-compatible local backend tool calls requiresStringContent`
    returned support guidance recommending `compat.requiresStringContent` for
    strict local OpenAI-compatible servers.
- Good qualities:
  - Compatibility controls are explicit and documented instead of hidden in
    provider code: `requiresStringContent`, strict keys, thinking flags, and
    backend-specific body fields can be reasoned about by operators.
  - The stream adapters isolate provider-specific quirks so higher-level agent
    code can use normalized events.
- Bad qualities:
  - Archive evidence shows users still encounter raw tool-call output and need
    model/server-specific fixes outside OpenClaw.
  - The compatibility surface is powerful but fragmented across provider docs,
    gateway docs, and provider config fields.
- Excluded from quality:
  - Test coverage and the number of stream compatibility tests were not used as
    Quality inputs.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/local-model-providers-ollama-vllm-sglang-lm-studio.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Bundled provider setup, Model Discovery Endpoint, Non-interactive configuration, vLLM thinking controls, OpenAI-compatible chat and tool semantics, SGLang compatibility guidance, Request Stream Compatibility, Tool Calling.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No single troubleshooting table maps raw tool-call symptoms to the exact
  provider setting for LM Studio, Ollama OpenAI-compatible mode, vLLM, and
  SGLang.
- SGLang-specific tool-call evidence is thinner than the shared
  OpenAI-compatible and vLLM evidence.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/gateway/local-models.md:218` documents
  strict backend and tool-call compatibility guidance.
- `/Users/kevinlin/code/openclaw/docs/gateway/local-models.md:268` documents
  local reasoning-effort controls.
- `/Users/kevinlin/code/openclaw/docs/gateway/local-models.md:302` documents
  smaller and stricter backend adjustments.
- `/Users/kevinlin/code/openclaw/docs/providers/vllm.md:230` documents Qwen
  tool-call configuration for vLLM.
- `/Users/kevinlin/code/openclaw/docs/providers/lmstudio.md:101` documents
  LM Studio streaming usage and thinking compatibility.

### Source

- `/Users/kevinlin/code/openclaw/extensions/lmstudio/src/stream.ts:176`
  handles LM Studio preload and streaming usage fields.
- `/Users/kevinlin/code/openclaw/extensions/vllm/stream.ts:13` implements the
  vLLM compatibility stream wrapper.
- `/Users/kevinlin/code/openclaw/extensions/vllm/thinking-policy.ts:54`
  decides when thinking is enabled for vLLM models.
- `/Users/kevinlin/code/openclaw/extensions/ollama/runtime-api.ts:3` exports
  Ollama runtime streaming and compatibility helpers.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/replay-history.ts:828`
  strips unsupported assistant metadata for strict providers.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/lmstudio/src/stream.test.ts:541`
  covers bracketed local-model tool-call text.
- `/Users/kevinlin/code/openclaw/extensions/lmstudio/src/stream.test.ts:596`
  covers Harmony local-model tool-call text.
- `/Users/kevinlin/code/openclaw/extensions/lmstudio/src/stream.test.ts:639`
  covers pass-through behavior for unregistered tool text.
- `/Users/kevinlin/code/openclaw/extensions/vllm/stream.test.ts:46` through
  line 118 cover vLLM stream compatibility.
- `/Users/kevinlin/code/openclaw/extensions/vllm/stream.test.ts:198` through
  line 233 cover vLLM tool-call output handling.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/ollama/src/stream-runtime.test.ts:119`
  covers the configured Ollama compatibility stream wrapper.
- `/Users/kevinlin/code/openclaw/extensions/ollama/src/stream-runtime.test.ts:158`
  covers `num_ctx` fallback handling.
- `/Users/kevinlin/code/openclaw/extensions/ollama/src/stream-runtime.test.ts:193`
  covers `thinking=false` behavior.
- `/Users/kevinlin/code/openclaw/extensions/ollama/src/stream-runtime.test.ts:402`
  covers thinking-enabled behavior.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "vLLM tool calls raw text" --json --limit 5`

Results:

- Returned issue #87687 and PR #79702, both relevant to vLLM tool-call and
  parser/template behavior.

Query: `gitcrawl search openclaw/openclaw --query "local model tool calls raw JSON" --json --limit 5`

Results:

- Returned issue #85883 and related local-model tool-call failure discussions.

### Discrawl queries

Query: `discrawl search --mode hybrid --limit 5 "vLLM tool calls raw text"`

Results:

- Returned support threads describing raw `<tool_call>` XML or text from local
  vLLM-backed models and the need for parser/template guidance.

Query: `discrawl search --mode hybrid --limit 5 "OpenAI-compatible local backend tool calls requiresStringContent"`

Results:

- Returned support guidance recommending `compat.requiresStringContent` for
  strict local OpenAI-compatible providers.
