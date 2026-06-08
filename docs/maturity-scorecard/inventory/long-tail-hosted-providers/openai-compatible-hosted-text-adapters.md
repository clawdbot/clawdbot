---
title: "Long-tail hosted providers - Hosted LLM Providers Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Long-tail hosted providers - Hosted LLM Providers Maturity Note

## Summary

OpenAI-compatible hosted text adapters are Beta for Coverage and Alpha for
Quality. Many providers have manifests, catalogs, request metadata, unit
coverage, and targeted live tests, but provider-specific reasoning, tool-call,
search, streaming, and model-catalog behavior keeps the quality score below
Beta.

## Category Scope

Included in this category:

- Bedrock setup: Covers Bedrock setup across Amazon Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel AI Gateway, and related cloud and gateway providers behavior.
- Gateway/proxy routing: Covers Gateway/proxy routing across Amazon Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel AI Gateway, and related cloud and gateway providers behavior.
- Copilot/OpenCode hosted access: Covers Copilot/OpenCode hosted access across Amazon Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel AI Gateway, and related cloud and gateway providers behavior.
- Proxy capability diagnostics: Covers Proxy capability diagnostics across Amazon Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel AI Gateway, and related cloud and gateway providers behavior.
- Hosted text completion: Covers Hosted text completion across hosted text providers that mostly use OpenAI-compatible routes or close variants: DeepSeek, Groq, Mistral, Together, and related openai-compatible hosted text providers behavior.
- Tool-call and streaming compatibility: Covers Tool-call and streaming compatibility across hosted text providers that mostly use OpenAI-compatible routes or close variants: DeepSeek, Groq, Mistral, Together, and related openai-compatible hosted text providers behavior.
- Model catalog resolution: Covers Model catalog resolution across hosted text providers that mostly use OpenAI-compatible routes or close variants: DeepSeek, Groq, Mistral, Together, and related openai-compatible hosted text providers behavior.
- Provider-specific request shaping: Covers Provider-specific request shaping across hosted text providers that mostly use OpenAI-compatible routes or close variants: DeepSeek, Groq, Mistral, Together, and related openai-compatible hosted text providers behavior.
- Regional provider setup: Covers Regional provider setup across Qwen, Alibaba, Tencent, Qianfan, and related regional hosted llm providers behavior.
- Region and plan routing: Covers Region and plan routing across Qwen, Alibaba, Tencent, Qianfan, and related regional hosted llm providers behavior.
- Regional live smoke: Covers Regional live smoke across Qwen, Alibaba, Tencent, Qianfan, and related regional hosted llm providers behavior.
- Account prerequisite diagnostics: Covers Account prerequisite diagnostics across Qwen, Alibaba, Tencent, Qianfan, and related regional hosted llm providers behavior.

## Features

- Bedrock setup: Covers Bedrock setup across Amazon Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel AI Gateway, and related cloud and gateway providers behavior.
- Gateway/proxy routing: Covers Gateway/proxy routing across Amazon Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel AI Gateway, and related cloud and gateway providers behavior.
- Copilot/OpenCode hosted access: Covers Copilot/OpenCode hosted access across Amazon Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel AI Gateway, and related cloud and gateway providers behavior.
- Proxy capability diagnostics: Covers Proxy capability diagnostics across Amazon Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel AI Gateway, and related cloud and gateway providers behavior.
- Hosted text completion: Covers Hosted text completion across hosted text providers that mostly use OpenAI-compatible routes or close variants: DeepSeek, Groq, Mistral, Together, and related openai-compatible hosted text providers behavior.
- Tool-call and streaming compatibility: Covers Tool-call and streaming compatibility across hosted text providers that mostly use OpenAI-compatible routes or close variants: DeepSeek, Groq, Mistral, Together, and related openai-compatible hosted text providers behavior.
- Model catalog resolution: Covers Model catalog resolution across hosted text providers that mostly use OpenAI-compatible routes or close variants: DeepSeek, Groq, Mistral, Together, and related openai-compatible hosted text providers behavior.
- Provider-specific request shaping: Covers Provider-specific request shaping across hosted text providers that mostly use OpenAI-compatible routes or close variants: DeepSeek, Groq, Mistral, Together, and related openai-compatible hosted text providers behavior.
- Regional provider setup: Covers Regional provider setup across Qwen, Alibaba, Tencent, Qianfan, and related regional hosted llm providers behavior.
- Region and plan routing: Covers Region and plan routing across Qwen, Alibaba, Tencent, Qianfan, and related regional hosted llm providers behavior.
- Regional live smoke: Covers Regional live smoke across Qwen, Alibaba, Tencent, Qianfan, and related regional hosted llm providers behavior.
- Account prerequisite diagnostics: Covers Account prerequisite diagnostics across Qwen, Alibaba, Tencent, Qianfan, and related regional hosted llm providers behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals:
  - Provider manifests exist for many OpenAI-compatible hosted text providers, including DeepSeek, Groq, Mistral, Together, xAI, DeepInfra, Fireworks, Cerebras, NVIDIA, Hugging Face, Chutes, Venice, Arcee, Kilo, OpenCode, and OpenCode Go.
  - Direct live tests exist for DeepSeek, Together, xAI, and OpenCode paths.
  - `docs/help/testing-live.md` recommends DeepSeek and optional xAI/Mistral/Cerebras in model smoke sets.
  - Unit/contract tests cover provider policy, provider request shaping, streaming, model IDs, web search, media-understanding adjuncts, and plugin registration for several adapters.
- Negative signals:
  - Live proof is uneven across the whole provider family.
  - The route is only nominally OpenAI-compatible for many providers; reasoning, tool, model ID, prefix, and search behavior still diverges.
  - Some providers rely heavily on static catalogs or runtime catalog fetches rather than a uniform recurring live lane.

## Quality Score

- Score: `Alpha (68%)`
- Good qualities:
  - Provider-owned manifests keep auth choices, provider request metadata, model catalogs, setup descriptors, and capability contracts close to the plugin.
  - DeepSeek keeps V4 catalog resolution and thinking replay behavior close to the provider adapter.
  - Together keeps catalog model metadata and OpenAI-compatible completion shaping in provider-owned code.
  - Provider docs explicitly call out compatibility quirks such as xAI Responses behavior, Kilo proxy reasoning handling, NVIDIA nested prefixes, and Cerebras base URL behavior.
- Bad qualities:
  - The shared OpenAI-compatible label hides meaningful provider-specific differences in reasoning, streaming, tool-call replay, model IDs, and safety wrappers.
  - Archive evidence shows broad multi-provider API-key and model-catalog churn.
  - Long-tail providers can change model availability and compatibility without OpenClaw source changes.
- Excluded from quality:
  - Unit, integration, and live evidence were used only for Coverage scoring.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/long-tail-hosted-providers.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Bedrock setup, Gateway/proxy routing, Copilot/OpenCode hosted access, Proxy capability diagnostics, Hosted text completion, Tool-call and streaming compatibility, Model catalog resolution, Provider-specific request shaping, Regional provider setup, Region and plan routing, Regional live smoke, Account prerequisite diagnostics.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a recurring hosted text-provider smoke lane with one representative model
  per important OpenAI-compatible provider.
- Add a generated compatibility matrix for reasoning, tool calls, image input,
  streaming, and provider-specific request shaping.
- Add archive-backed drift notes for providers with dynamic catalogs.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md:291`: bundled provider table lists DeepInfra, DeepSeek, Groq, Hugging Face, Kilo, Mistral, NVIDIA, Together, Venice, xAI, and related providers.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md:320`: quirks document provider-specific OpenRouter, Kilo, MiniMax, NVIDIA, xAI, and Cerebras behavior.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:374`: live model docs define a recommended modern smoke set rather than a fixed CI model list.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:385`: DeepSeek appears in the modern direct/gateway smoke set.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:403`: optional additional coverage includes xAI, Mistral, Cerebras, and LM Studio.

### Source

- `/Users/kevinlin/code/openclaw/extensions/deepseek/openclaw.plugin.json:2`: DeepSeek ships as a provider plugin with manifest provider/catalog/setup metadata.
- `/Users/kevinlin/code/openclaw/extensions/groq/openclaw.plugin.json:2`: Groq ships as a provider plugin with manifest provider metadata.
- `/Users/kevinlin/code/openclaw/extensions/mistral/openclaw.plugin.json:2`: Mistral ships as a provider plugin with text and audio-related metadata.
- `/Users/kevinlin/code/openclaw/extensions/together/openclaw.plugin.json:2`: Together ships as a provider plugin with catalog and setup metadata.
- `/Users/kevinlin/code/openclaw/extensions/xai/openclaw.plugin.json:2`: xAI ships as a provider plugin with text, media, speech, and search metadata.
- `/Users/kevinlin/code/openclaw/extensions/deepinfra/openclaw.plugin.json:2`: DeepInfra ships as a hosted provider plugin.
- `/Users/kevinlin/code/openclaw/extensions/cerebras/openclaw.plugin.json:2`: Cerebras ships as a hosted provider plugin.
- `/Users/kevinlin/code/openclaw/extensions/venice/openclaw.plugin.json:2`: Venice ships as a hosted provider plugin.
- `/Users/kevinlin/code/openclaw/extensions/opencode/openclaw.plugin.json:2`: OpenCode ships as a hosted provider plugin.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/deepseek/deepseek.live.test.ts:80`: DeepSeek live test returns assistant text from the bundled V4 model catalog.
- `/Users/kevinlin/code/openclaw/extensions/deepseek/deepseek.live.test.ts:102`: DeepSeek live test accepts V4 thinking replay after a prior provider tool call.
- `/Users/kevinlin/code/openclaw/extensions/together/together.live.test.ts:47`: Together live test iterates the provider catalog and checks each catalog model returns assistant text.
- `/Users/kevinlin/code/openclaw/extensions/opencode/opencode.live.test.ts:60`: OpenCode live test covers thinking replay after a tool call on a DeepSeek-backed route.
- `/Users/kevinlin/code/openclaw/extensions/xai/xai.live.test.ts:92`: xAI live coverage includes hosted speech/media paths in the same plugin family.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/deepseek/index.test.ts`: unit coverage for DeepSeek provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/deepseek/provider-policy-api.test.ts`: unit coverage for DeepSeek provider policy API.
- `/Users/kevinlin/code/openclaw/extensions/xai/plugin-registration.contract.test.ts`: contract coverage for xAI plugin registration.
- `/Users/kevinlin/code/openclaw/extensions/xai/provider-policy-api.test.ts`: unit coverage for xAI provider policy behavior.
- `/Users/kevinlin/code/openclaw/extensions/groq/index.test.ts`: unit coverage for Groq provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/mistral/model-definitions.test.ts`: unit coverage for Mistral model definitions.
- `/Users/kevinlin/code/openclaw/extensions/together/plugin-registration.contract.test.ts`: contract coverage for Together plugin registration.

### Gitcrawl queries

- `gitcrawl --json search issues -R openclaw/openclaw "DeepSeek xAI Groq Mistral Together provider"` returned `[]`.
- `gitcrawl --json search prs -R openclaw/openclaw "DeepSeek xAI Groq Mistral Together provider"` returned #67579, the multi-provider API key system PR.
- `gitcrawl --json search prs -R openclaw/openclaw "provider metadata model catalog"` returned provider metadata/catalog PRs such as #84902, #75022, #85345, #67579, #69729, and #43493.

### Discrawl queries

- `env DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search "DeepSeek xAI Groq Mistral Together provider" --limit 5` returned PR #67570 context for a multi-provider API key system across OpenAI, Anthropic, Google Gemini, Groq, Mistral, OpenRouter, DeepSeek, Together, Fireworks, Perplexity, Cohere, xAI, MiniMax, Cerebras, SambaNova, and Qwen.
- Helper Discrawl query `DeepInfra provider catalog` returned release/review history about no-auth discovery and credential-aware catalog browsing.
- Helper Discrawl query `Venice provider catalog OpenClaw` returned stale allowlist/model discovery drift and tool-support catalog mismatch history.
