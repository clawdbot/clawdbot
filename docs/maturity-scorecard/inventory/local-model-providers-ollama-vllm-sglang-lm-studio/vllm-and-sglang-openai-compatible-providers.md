---
title: "Local model providers: Ollama, vLLM, SGLang, LM Studio - vLLM and SGLang OpenAI-Compatible Providers Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Local model providers: Ollama, vLLM, SGLang, LM Studio - vLLM and SGLang OpenAI-Compatible Providers Maturity Note

## Summary

vLLM and SGLang are first-class bundled provider plugins, but they intentionally
share the self-hosted OpenAI-compatible setup/discovery path. That gives them a
real onboarding and model discovery story while leaving much of the hardest
runtime behavior to backend-specific chat templates, tool-call parsers, and
operator configuration. vLLM has additional thinking-policy support; SGLang is
thinner and more generic.

## Category Scope

This category covers bundled `vllm` and `sglang` provider plugins, docs,
default env/base URL behavior, `/v1/models` discovery, non-interactive setup,
vLLM thinking controls, proxy-style request semantics, and known OpenAI
Chat-Completions compatibility edges.

## Features

- Bundled provider setup: Covers Bundled provider setup across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- Model Discovery Endpoint: Covers Model Discovery Endpoint across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- Non-interactive configuration: Covers Non-interactive configuration across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- vLLM thinking controls: Covers vLLM thinking controls across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- OpenAI-compatible chat and tool semantics: Covers OpenAI-compatible chat and tool semantics across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- SGLang compatibility guidance: Covers SGLang compatibility guidance across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals:
  - `/Users/kevinlin/code/openclaw/extensions/vllm/openclaw.plugin.json:2`
    and `/Users/kevinlin/code/openclaw/extensions/sglang/openclaw.plugin.json:2`
    define enabled-by-default bundled providers with OpenAI-compatible
    streaming usage support.
  - `/Users/kevinlin/code/openclaw/extensions/vllm/index.ts:26` and
    `/Users/kevinlin/code/openclaw/extensions/sglang/index.ts:25` register
    provider setup, discovery, auth choices, and model-picker metadata.
  - `/Users/kevinlin/code/openclaw/src/plugins/provider-self-hosted-setup.ts:138`
    discovers OpenAI-compatible `/models` catalogs using guarded fetch.
  - `/Users/kevinlin/code/openclaw/extensions/vllm/stream.ts:123` wraps vLLM
    stream payloads for Qwen/Nemotron thinking controls.
- Negative signals:
  - The audit did not find vLLM or SGLang live tests analogous to the Ollama
    live test.
  - SGLang currently has a much thinner implementation surface than vLLM:
    discovery/setup and replay-policy behavior without provider-specific
    transport wrappers.
- Integration gaps:
  - Add local fake-server or live opt-in tests for `/v1/models`,
    `/v1/chat/completions`, streaming usage, and a tool-call-capable model path
    for both vLLM and SGLang.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports:
  - Query `vLLM tool calls raw text` returned open issue #87687 for vLLM
    streaming parser dropping `tool_calls` when `reasoning_content` streams
    first, plus a related embedding-query PR.
  - Query `SGLang OpenAI-compatible local` returned issue #81961 and PR #68019
    but little SGLang-specific defect evidence.
- Discrawl reports:
  - Query `vLLM tool calls raw text` returned issue #49508 and support threads
    describing vLLM/Qwen raw `<tool_call>` XML/text output and tool parser
    requirements.
  - Query `SGLang OpenAI-compatible local` returned messages saying vLLM and
    SGLang are supported generally, but may not be the best fit for constrained
    devices and can add compatibility pain.
- Good qualities:
  - The providers use a shared, explicit setup path with correct
    `openai-completions` defaults, provider-specific env vars, dynamic discovery
    opt-in, and streaming usage flags.
  - vLLM has targeted Qwen and Nemotron thinking wrappers, avoiding a generic
    one-size-fits-all request payload.
- Bad qualities:
  - vLLM tool-calling reliability depends heavily on upstream parser/template
    startup flags, and archive evidence shows raw tool-call text still reaches
    users.
  - SGLang is documented and discoverable, but source coverage is mostly generic
    OpenAI-compatible plumbing with limited provider-specific resilience.
- Excluded from quality:
  - Test coverage, integration depth, and lack of tests were not used as
    Quality inputs.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/local-model-providers-ollama-vllm-sglang-lm-studio.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Bundled provider setup, Model Discovery Endpoint, Non-interactive configuration, vLLM thinking controls, OpenAI-compatible chat and tool semantics, SGLang compatibility guidance.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- vLLM needs clearer operator proof around tool-call parser startup and
  reasoning-content streaming.
- SGLang needs either more provider-specific runtime handling or explicit docs
  explaining that it is currently a thin OpenAI-compatible provider path.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/vllm.md:9` states OpenClaw
  connects to vLLM with `openai-completions`.
- `/Users/kevinlin/code/openclaw/docs/providers/vllm.md:64` documents implicit
  model discovery from `GET /v1/models`.
- `/Users/kevinlin/code/openclaw/docs/providers/vllm.md:130` documents
  proxy-style behavior; lines 146-207 document Qwen/Nemotron thinking controls.
- `/Users/kevinlin/code/openclaw/docs/providers/vllm.md:230` documents Qwen
  tool-call parser/template requirements and `tool_choice: "required"`.
- `/Users/kevinlin/code/openclaw/docs/providers/sglang.md:9` states SGLang uses
  the OpenAI-compatible `openai-completions` provider family with discovery.

### Source

- `/Users/kevinlin/code/openclaw/extensions/vllm/defaults.ts:1` declares the
  default vLLM base URL and env var.
- `/Users/kevinlin/code/openclaw/extensions/sglang/defaults.ts:1` declares the
  default SGLang base URL and env var.
- `/Users/kevinlin/code/openclaw/extensions/vllm/models.ts:12` discovers vLLM
  models from a self-hosted `/models` endpoint.
- `/Users/kevinlin/code/openclaw/extensions/sglang/models.ts:12` discovers
  SGLang models from a self-hosted `/models` endpoint.
- `/Users/kevinlin/code/openclaw/extensions/vllm/thinking-policy.ts:54`
  exposes binary thinking profiles for configured vLLM models.
- `/Users/kevinlin/code/openclaw/extensions/sglang/index.ts:91` reports missing
  auth/setup guidance for SGLang.

### Integration tests

- No vLLM or SGLang live test was found in this audit.
- `/Users/kevinlin/code/openclaw/src/plugins/provider-self-hosted-setup.test.ts:88`
  tests the shared OpenAI-compatible model discovery path with a mocked local
  `/v1/models` server response.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/plugins/provider-self-hosted-setup.test.ts:399`
  verifies non-interactive vLLM and SGLang config plus auth-profile writes.
- `/Users/kevinlin/code/openclaw/extensions/vllm/provider-discovery.contract.test.ts:12`
  verifies vLLM provider registration and thinking-profile hook exposure.
- `/Users/kevinlin/code/openclaw/extensions/vllm/stream.test.ts:46` verifies
  Qwen chat-template thinking payloads.
- `/Users/kevinlin/code/openclaw/extensions/vllm/stream.test.ts:156` verifies
  Nemotron thinking-off payload injection.
- `/Users/kevinlin/code/openclaw/extensions/sglang/index.test.ts:5` verifies
  SGLang replay-policy behavior.
- `/Users/kevinlin/code/openclaw/extensions/sglang/provider-discovery.contract.test.ts`
  verifies SGLang provider discovery contract behavior.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "vLLM tool calls raw text" --json --limit 5`

Results:

- Returned open issue #87687, "vllm openai-completions streaming parser drops
  tool_calls when reasoning_content streams first for gpt-oss-120b at large
  systemPrompt".

Query: `gitcrawl search openclaw/openclaw --query "SGLang OpenAI-compatible local" --json --limit 5`

Results:

- Returned issue #81961 around model-provider dashboard UX and PR #68019 with
  SGLang/vLLM model examples in memory-core work, but no concrete SGLang
  runtime defect in the first five hits.

### Discrawl queries

Query: `discrawl search --mode hybrid --limit 5 "vLLM tool calls raw text"`

Results:

- Returned issue #49508 and support discussion explaining vLLM/Qwen raw
  `<tool_call>` XML/text output and the need for upstream tool-call parser and
  chat-template configuration.

Query: `discrawl search --mode hybrid --limit 5 "SGLang OpenAI-compatible local"`

Results:

- Returned messages confirming local discovery/setup support for vLLM/SGLang
  and community guidance that these providers are supported but can add
  compatibility pain on constrained hardware.
