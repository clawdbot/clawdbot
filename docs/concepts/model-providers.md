---
summary: "Model provider overview with example configs + CLI flows"
read_when:
  - You need a provider-by-provider model setup reference
  - You want example configs or CLI onboarding commands for model providers
title: "Model Providers"
---

# Model providers

This page covers **LLM/model providers** (not chat channels like WhatsApp/Telegram).
For model selection rules, see [/concepts/models](/concepts/models).

## Quick rules

- Model refs use `provider/model` (example: `opencode/claude-opus-4-6`).
- If you set `agents.defaults.models`, it becomes the allowlist.
- CLI helpers: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.
- Fallback runtime rules, cooldown probes, and session-override persistence are
  documented in [/concepts/model-failover](/concepts/model-failover).
- `models.providers.*.models[].contextWindow` is native model metadata;
  `models.providers.*.models[].contextTokens` is the effective runtime cap.
- Provider plugins can inject model catalogs via `registerProvider({ catalog })`;
  OpenClaw merges that output into `models.providers` before writing
  `models.json`.
- Provider manifests can declare `providerAuthEnvVars` and
  `providerAuthAliases` so generic env-based auth probes and provider variants
  do not need to load plugin runtime. The remaining core env-var map is now
  just for non-plugin/core providers and a few generic-precedence cases such
  as Anthropic API-key-first onboarding.
- Provider plugins can also own provider runtime behavior via
  `normalizeModelId`, `normalizeTransport`, `normalizeConfig`,
  `applyNativeStreamingUsageCompat`, `resolveConfigApiKey`,
  `resolveSyntheticAuth`, `shouldDeferSyntheticProfileAuth`,
  `resolveDynamicModel`, `prepareDynamicModel`,
  `normalizeResolvedModel`, `contributeResolvedModelCompat`,
  `capabilities`, `normalizeToolSchemas`,
  `inspectToolSchemas`, `resolveReasoningOutputMode`,
  `prepareExtraParams`, `createStreamFn`, `wrapStreamFn`,
  `resolveTransportTurnState`, `resolveWebSocketSessionPolicy`,
  `createEmbeddingProvider`, `formatApiKey`, `refreshOAuth`,
  `buildAuthDoctorHint`,
  `matchesContextOverflowError`, `classifyFailoverReason`,
  `isCacheTtlEligible`, `buildMissingAuthMessage`, `suppressBuiltInModel`,
  `augmentModelCatalog`, `isBinaryThinking`, `supportsXHighThinking`,
  `resolveDefaultThinkingLevel`, `applyConfigDefaults`, `isModernModelRef`,
  `prepareRuntimeAuth`, `resolveUsageAuth`, `fetchUsageSnapshot`, and
  `onModelSelected`.
- Note: provider runtime `capabilities` is shared runner metadata (provider
  family, transcript/tooling quirks, transport/cache hints). It is not the
  same as the [public capability model](/plugins/architecture#public-capability-model)
  which describes what a plugin registers (text inference, speech, etc.).
- The bundled `codex` provider is paired with the bundled Codex agent harness.
  Use `codex/gpt-*` when you want Codex-owned login, model discovery, native
  thread resume, and app-server execution. Plain `openai/gpt-*` refs continue
  to use the OpenAI provider and the normal OpenClaw provider transport.
  Codex-only deployments can disable automatic PI fallback with
  `agents.defaults.embeddedHarness.fallback: "none"`; see
  [Codex Harness](/plugins/codex-harness).

## Plugin-owned provider behavior

Provider plugins can now own most provider-specific logic while OpenClaw keeps
the generic inference loop.

Typical split:

- `auth[].run` / `auth[].runNonInteractive`: provider owns onboarding/login
  flows for `openclaw onboard`, `openclaw models auth`, and headless setup
- `wizard.setup` / `wizard.modelPicker`: provider owns auth-choice labels,
  legacy aliases, onboarding allowlist hints, and setup entries in onboarding/model pickers
- `catalog`: provider appears in `models.providers`
- `normalizeModelId`: provider normalizes legacy/preview model ids before
  lookup or canonicalization
- `normalizeTransport`: provider normalizes transport-family `api` / `baseUrl`
  before generic model assembly; OpenClaw checks the matched provider first,
  then other hook-capable provider plugins until one actually changes the
  transport
- `normalizeConfig`: provider normalizes `models.providers.<id>` config before
  runtime uses it; OpenClaw checks the matched provider first, then other
  hook-capable provider plugins until one actually changes the config. If no
  provider hook rewrites the config, bundled Google-family helpers still
  normalize supported Google provider entries.
- `applyNativeStreamingUsageCompat`: provider applies endpoint-driven native streaming-usage compat rewrites for config providers
- `resolveConfigApiKey`: provider resolves env-marker auth for config providers
  without forcing full runtime auth loading. `amazon-bedrock` also has a
  built-in AWS env-marker resolver here, even though Bedrock runtime auth uses
  the AWS SDK default chain.
- `resolveSyntheticAuth`: provider can expose local/self-hosted or other
  config-backed auth availability without persisting plaintext secrets
- `shouldDeferSyntheticProfileAuth`: provider can mark stored synthetic profile
  placeholders as lower precedence than env/config-backed auth
- `resolveDynamicModel`: provider accepts model ids not present in the local
  static catalog yet
- `prepareDynamicModel`: provider needs a metadata refresh before retrying
  dynamic resolution
- `normalizeResolvedModel`: provider needs transport or base URL rewrites
- `contributeResolvedModelCompat`: provider contributes compat flags for its
  vendor models even when they arrive through another compatible transport
- `capabilities`: provider publishes transcript/tooling/provider-family quirks
- `normalizeToolSchemas`: provider cleans tool schemas before the embedded
  runner sees them
- `inspectToolSchemas`: provider surfaces transport-specific schema warnings
  after normalization
- `resolveReasoningOutputMode`: provider chooses native vs tagged
  reasoning-output contracts
- `prepareExtraParams`: provider defaults or normalizes per-model request params
- `createStreamFn`: provider replaces the normal stream path with a fully
  custom transport
- `wrapStreamFn`: provider applies request headers/body/model compat wrappers
- `resolveTransportTurnState`: provider supplies per-turn native transport
  headers or metadata
- `resolveWebSocketSessionPolicy`: provider supplies native WebSocket session
  headers or session cool-down policy
- `createEmbeddingProvider`: provider owns memory embedding behavior when it
  belongs with the provider plugin instead of the core embedding switchboard
- `formatApiKey`: provider formats stored auth profiles into the runtime
  `apiKey` string expected by the transport
- `refreshOAuth`: provider owns OAuth refresh when the shared `pi-ai`
  refreshers are not enough
- `buildAuthDoctorHint`: provider appends repair guidance when OAuth refresh
  fails
- `matchesContextOverflowError`: provider recognizes provider-specific
  context-window overflow errors that generic heuristics would miss
- `classifyFailoverReason`: provider maps provider-specific raw transport/API
  errors to failover reasons such as rate limit or overload
- `isCacheTtlEligible`: provider decides which upstream model ids support prompt-cache TTL
- `buildMissingAuthMessage`: provider replaces the generic auth-store error
  with a provider-specific recovery hint
- `suppressBuiltInModel`: provider hides stale upstream rows and can return a
  vendor-owned error for direct resolution failures
- `augmentModelCatalog`: provider appends synthetic/final catalog rows after
  discovery and config merging
- `isBinaryThinking`: provider owns binary on/off thinking UX
- `supportsXHighThinking`: provider opts selected models into `xhigh`
- `resolveDefaultThinkingLevel`: provider owns default `/think` policy for a
  model family
- `applyConfigDefaults`: provider applies provider-specific global defaults
  during config materialization based on auth mode, env, or model family
- `isModernModelRef`: provider owns live/smoke preferred-model matching
- `prepareRuntimeAuth`: provider turns a configured credential into a short
  lived runtime token
- `resolveUsageAuth`: provider resolves usage/quota credentials for `/usage`
  and related status/reporting surfaces
- `fetchUsageSnapshot`: provider owns the usage endpoint fetch/parsing while
  core still owns the summary shell and formatting
- `onModelSelected`: provider runs post-selection side effects such as
  telemetry or provider-owned session bookkeeping

Current bundled examples:

- `anthropic`: Claude 4.6 forward-compat fallback, auth repair hints, usage
  endpoint fetching, cache-TTL/provider-family metadata, and auth-aware global
  config defaults
- `amazon-bedrock`: provider-owned context-overflow matching and failover
  reason classification for Bedrock-specific throttle/not-ready errors, plus
  the shared `anthropic-by-model` replay family for Claude-only replay-policy
  guards on Anthropic traffic
- `anthropic-vertex`: Claude-only replay-policy guards on Anthropic-message
  traffic
- `openrouter`: pass-through model ids, request wrappers, provider capability
  hints, Gemini thought-signature sanitation on proxy Gemini traffic, proxy
  reasoning injection through the `openrouter-thinking` stream family, routing
  metadata forwarding, and cache-TTL policy
- `github-copilot`: onboarding/device login, forward-compat model fallback,
  Claude-thinking transcript hints, runtime token exchange, and usage endpoint
  fetching
- `openai`: GPT-5.4 forward-compat fallback, direct OpenAI transport
  normalization, Codex-aware missing-auth hints, Spark suppression, synthetic
  OpenAI/Codex catalog rows, thinking/live-model policy, usage-token alias
  normalization (`input` / `output` and `prompt` / `completion` families), the
  shared `openai-responses-defaults` stream family for native OpenAI/Codex
  wrappers, provider-family metadata, bundled image-generation provider
  registration for `gpt-image-1`, and bundled video-generation provider
  registration for `sora-2`
- `google` and `google-gemini-cli`: Gemini 3.1 forward-compat fallback,
  native Gemini replay validation, bootstrap replay sanitation, tagged
  reasoning-output mode, modern-model matching, bundled image-generation
  provider registration for Gemini image-preview models, and bundled
  video-generation provider registration for Veo models; Gemini CLI OAuth also
  owns auth-profile token formatting, usage-token parsing, and quota endpoint
  fetching for usage surfaces
- `moonshot`: shared transport, plugin-owned thinking payload normalization
- `kilocode`: shared transport, plugin-owned request headers, reasoning payload
  normalization, proxy-Gemini thought-signature sanitation, and cache-TTL
  policy
- `zai`: GLM-5 forward-compat fallback, `tool_stream` defaults, cache-TTL
  policy, binary-thinking/live-model policy, and usage auth + quota fetching;
  unknown `glm-5*` ids synthesize from the bundled `glm-4.7` template
- `xai`: native Responses transport normalization, `/fast` alias rewrites for
  Grok fast variants, default `tool_stream`, xAI-specific tool-schema /
  reasoning-payload cleanup, and bundled video-generation provider
  registration for `grok-imagine-video`
- `mistral`: plugin-owned capability metadata
- `opencode` and `opencode-go`: plugin-owned capability metadata plus
  proxy-Gemini thought-signature sanitation
- `alibaba`: plugin-owned video-generation catalog for direct Wan model refs
  such as `alibaba/wan2.6-t2v`
- `byteplus`: plugin-owned catalogs plus bundled video-generation provider
  registration for Seedance text-to-video/image-to-video models
- `fal`: bundled video-generation provider registration for hosted third-party
  image-generation provider registration for FLUX image models plus bundled
  video-generation provider registration for hosted third-party video models
- `cloudflare-ai-gateway`, `huggingface`, `kimi`, `nvidia`, `qianfan`,
  `stepfun`, `synthetic`, `venice`, `vercel-ai-gateway`, and `volcengine`:
  plugin-owned catalogs only
- `qwen`: plugin-owned catalogs for text models plus shared
  media-understanding and video-generation provider registrations for its
  multimodal surfaces; Qwen video generation uses the Standard DashScope video
  endpoints with bundled Wan models such as `wan2.6-t2v` and `wan2.7-r2v`
- `runway`: plugin-owned video-generation provider registration for native
  Runway task-based models such as `gen4.5`
- `minimax`: plugin-owned catalogs, bundled video-generation provider
  registration for Hailuo video models, bundled image-generation provider
  registration for `image-01`, hybrid Anthropic/OpenAI replay-policy
  selection, and usage auth/snapshot logic
- `together`: plugin-owned catalogs plus bundled video-generation provider
  registration for Wan video models
- `xiaomi`: plugin-owned catalogs plus usage auth/snapshot logic

The bundled `openai` plugin now owns both provider ids: `openai` and
`openai-codex`.

That covers providers that still fit OpenClaw's normal transports. A provider
that needs a totally custom request executor is a separate, deeper extension
surface.

## API key rotation

- Supports generic provider rotation for selected providers.
- Configure multiple keys via:
  - `OPENCLAW_LIVE_<PROVIDER>_KEY` (single live override, highest priority)
  - `<PROVIDER>_API_KEYS` (comma or semicolon list)
  - `<PROVIDER>_API_KEY` (primary key)
  - `<PROVIDER>_API_KEY_*` (numbered list, e.g. `<PROVIDER>_API_KEY_1`)
- For Google providers, `GOOGLE_API_KEY` is also included as fallback.
- Key selection order preserves priority and deduplicates values.
- Requests are retried with the next key only on rate-limit responses (for
  example `429`, `rate_limit`, `quota`, `resource exhausted`, `Too many
concurrent requests`, `ThrottlingException`, `concurrency limit reached`,
  `workers_ai ... quota limit exceeded`, or periodic usage-limit messages).
- Non-rate-limit failures fail immediately; no key rotation is attempted.
- When all candidate keys fail, the final error is returned from the last attempt.

## Built-in providers (pi-ai catalog)

OpenClaw ships with the pi‑ai catalog. These providers require **no**
`models.providers` config; just set auth + pick a model.

### OpenAI

- Provider: `openai`
- Auth: `OPENAI_API_KEY`
- Optional rotation: `OPENAI_API_KEYS`, `OPENAI_API_KEY_1`, `OPENAI_API_KEY_2`, plus `OPENCLAW_LIVE_OPENAI_KEY` (single override)
- Example models: `openai/gpt-5.4`, `openai/gpt-5.4-pro`
- CLI: `openclaw onboard --auth-choice openai-api-key`
- Default transport is `auto` (WebSocket-first, SSE fallback)
- Override per model via `agents.defaults.models["openai/<model>"].params.transport` (`"sse"`, `"websocket"`, or `"auto"`)
- OpenAI Responses WebSocket warm-up defaults to enabled via `params.openaiWsWarmup` (`true`/`false`)
- OpenAI priority processing can be enabled via `agents.defaults.models["openai/<model>"].params.serviceTier`
- `/fast` and `params.fastMode` map direct `openai/*` Responses requests to `service_tier=priority` on `api.openai.com`
- Use `params.serviceTier` when you want an explicit tier instead of the shared `/fast` toggle
- Hidden OpenClaw attribution headers (`originator`, `version`,
  `User-Agent`) apply only on native OpenAI traffic to `api.openai.com`, not
  generic OpenAI-compatible proxies
- Native OpenAI routes also keep Responses `store`, prompt-cache hints, and
  OpenAI reasoning-compat payload shaping; proxy routes do not
- `openai/gpt-5.3-codex-spark` is intentionally suppressed in OpenClaw because the live OpenAI API rejects it; Spark is treated as Codex-only

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
}
```

### Anthropic

- Provider: `anthropic`
- Auth: `ANTHROPIC_API_KEY`
- Optional rotation: `ANTHROPIC_API_KEYS`, `ANTHROPIC_API_KEY_1`, `ANTHROPIC_API_KEY_2`, plus `OPENCLAW_LIVE_ANTHROPIC_KEY` (single override)
- Example model: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice apiKey`
- Direct public Anthropic requests support the shared `/fast` toggle and `params.fastMode`, including API-key and OAuth-authenticated traffic sent to `api.anthropic.com`; OpenClaw maps that to Anthropic `service_tier` (`auto` vs `standard_only`)
- Anthropic note: Anthropic staff told us OpenClaw-style Claude CLI usage is allowed again, so OpenClaw treats Claude CLI reuse and `claude -p` usage as sanctioned for this integration unless Anthropic publishes a new policy.
- Anthropic setup-token remains available as a supported OpenClaw token path, but OpenClaw now prefers Claude CLI reuse and `claude -p` when available.

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- Provider: `openai-codex`
- Auth: OAuth (ChatGPT)
- Example model: `openai-codex/gpt-5.4`
- CLI: `openclaw onboard --auth-choice openai-codex` or `openclaw models auth login --provider openai-codex`
- Default transport is `auto` (WebSocket-first, SSE fallback)
- Override per model via `agents.defaults.models["openai-codex/<model>"].params.transport` (`"sse"`, `"websocket"`, or `"auto"`)
- `params.serviceTier` is also forwarded on native Codex Responses requests (`chatgpt.com/backend-api`)
- Hidden OpenClaw attribution headers (`originator`, `version`,
  `User-Agent`) are only attached on native Codex traffic to
  `chatgpt.com/backend-api`, not generic OpenAI-compatible proxies
- Shares the same `/fast` toggle and `params.fastMode` config as direct `openai/*`; OpenClaw maps that to `service_tier=priority`
- `openai-codex/gpt-5.3-codex-spark` remains available when the Codex OAuth catalog exposes it; entitlement-dependent
- `openai-codex/gpt-5.4` keeps native `contextWindow = 1050000` and a default runtime `contextTokens = 272000`; override the runtime cap with `models.providers.openai-codex.models[].contextTokens`
- Policy note: OpenAI Codex OAuth is explicitly supported for external tools/workflows like OpenClaw.

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
}
```

```json5
{
  models: {
    providers: {
      "openai-codex": {
        models: [{ id: "gpt-5.4", contextTokens: 160000 }],
      },
    },
  },
}
```

### Other subscription-style hosted options

- [Qwen Cloud](/providers/qwen): Qwen Cloud provider surface plus Alibaba DashScope and Coding Plan endpoint mapping
- [MiniMax](/providers/minimax): MiniMax Coding Plan OAuth or API key access
- [GLM Models](/providers/glm): Z.AI Coding Plan or general API endpoints

### OpenCode

- Auth: `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`)
- Zen runtime provider: `opencode`
- Go runtime provider: `opencode-go`
- Example models: `opencode/claude-opus-4-6`, `opencode-go/kimi-k2.5`
- CLI: `openclaw onboard --auth-choice opencode-zen` or `openclaw onboard --auth-choice opencode-go`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (API key)

- Provider: `google`
- Auth: `GEMINI_API_KEY`
- Optional rotation: `GEMINI_API_KEYS`, `GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`, `GOOGLE_API_KEY` fallback, and `OPENCLAW_LIVE_GEMINI_KEY` (single override)
- Example models: `google/gemini-3.1-pro-preview`, `google/gemini-3-flash-preview`
- Compatibility: legacy OpenClaw config using `google/gemini-3.1-flash-preview` is normalized to `google/gemini-3-flash-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`
- Direct Gemini runs also accept `agents.defaults.models["google/<model>"].params.cachedContent`
  (or legacy `cached_content`) to forward a provider-native
  `cachedContents/...` handle; Gemini cache hits surface as OpenClaw `cacheRead`

### Google Vertex and Gemini CLI

- Providers: `google-vertex`, `google-gemini-cli`
- Auth: Vertex uses gcloud ADC; Gemini CLI uses its OAuth flow
- Caution: Gemini CLI OAuth in OpenClaw is an unofficial integration. Some users have reported Google account restrictions after using third-party clients. Review Google terms and use a non-critical account if you choose to proceed.
- Gemini CLI OAuth is shipped as part of the bundled `google` plugin.
  - Install Gemini CLI first:
    - `brew install gemini-cli`
    - or `npm install -g @google/gemini-cli`
  - Enable: `openclaw plugins enable google`
  - Login: `openclaw models auth login --provider google-gemini-cli --set-default`
  - Default model: `google-gemini-cli/gemini-3-flash-preview`
  - Note: you do **not** paste a client id or secret into `openclaw.json`. The CLI login flow stores
    tokens in auth profiles on the gateway host.
  - If requests fail after login, set `GOOGLE_CLOUD_PROJECT` or `GOOGLE_CLOUD_PROJECT_ID` on the gateway host.
  - Gemini CLI JSON replies are parsed from `response`; usage falls back to
    `stats`, with `stats.cached` normalized into OpenClaw `cacheRead`.

### Z.AI (GLM)

- Provider: `zai`
- Auth: `ZAI_API_KEY`
- Example model: `zai/glm-5.1`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - Aliases: `z.ai/*` and `z-ai/*` normalize to `zai/*`
  - `zai-api-key` auto-detects the matching Z.AI endpoint; `zai-coding-global`, `zai-coding-cn`, `zai-global`, and `zai-cn` force a specific surface

### Vercel AI Gateway

- Provider: `vercel-ai-gateway`
- Auth: `AI_GATEWAY_API_KEY`
- Example model: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### Kilo Gateway

- Provider: `kilocode`
- Auth: `KILOCODE_API_KEY`
- Example model: `kilocode/kilo/auto`
- CLI: `openclaw onboard --auth-choice kilocode-api-key`
- Base URL: `https://api.kilo.ai/api/gateway/`
- Static fallback catalog ships `kilocode/kilo/auto`; live
  `https://api.kilo.ai/api/gateway/models` discovery can expand the runtime
  catalog further.
- Exact upstream routing behind `kilocode/kilo/auto` is owned by Kilo Gateway,
  not hard-coded in OpenClaw.

See [/providers/kilocode](/providers/kilocode) for setup details.

### Other bundled provider plugins

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- Example model: `openrouter/auto`
- OpenClaw applies OpenRouter's documented app-attribution headers only when
  the request actually targets `openrouter.ai`
- OpenRouter-specific Anthropic `cache_control` markers are likewise gated to
  verified OpenRouter routes, not arbitrary proxy URLs
- OpenRouter remains on the proxy-style OpenAI-compatible path, so native
  OpenAI-only request shaping (`serviceTier`, Responses `store`,
  prompt-cache hints, OpenAI reasoning-compat payloads) is not forwarded
- Gemini-backed OpenRouter refs keep proxy-Gemini thought-signature sanitation
  only; native Gemini replay validation and bootstrap rewrites stay off
- Kilo Gateway: `kilocode` (`KILOCODE_API_KEY`)
- Example model: `kilocode/kilo/auto`
- Gemini-backed Kilo refs keep the same proxy-Gemini thought-signature
  sanitation path; `kilocode/kilo/auto` and other proxy-reasoning-unsupported
  hints skip proxy reasoning injection
- MiniMax: `minimax` (API key) and `minimax-portal` (OAuth)
- Auth: `MINIMAX_API_KEY` for `minimax`; `MINIMAX_OAUTH_TOKEN` or `MINIMAX_API_KEY` for `minimax-portal`
- Example model: `minimax/MiniMax-M2.7` or `minimax-portal/MiniMax-M2.7`
- MiniMax onboarding/API-key setup writes explicit M2.7 model definitions with
  `input: ["text", "image"]`; the bundled provider catalog keeps the chat refs
  text-only until that provider config is materialized
- Moonshot: `moonshot` (`MOONSHOT_API_KEY`)
- Example model: `moonshot/kimi-k2.5`
- Kimi Coding: `kimi` (`KIMI_API_KEY` or `KIMICODE_API_KEY`)
- Example model: `kimi/kimi-code`
- Qianfan: `qianfan` (`QIANFAN_API_KEY`)
- Example model: `qianfan/deepseek-v3.2`
- Qwen Cloud: `qwen` (`QWEN_API_KEY`, `MODELSTUDIO_API_KEY`, or `DASHSCOPE_API_KEY`)
- Example model: `qwen/qwen3.5-plus`
- NVIDIA: `nvidia` (`NVIDIA_API_KEY`)
- Example model: `nvidia/nvidia/llama-3.1-nemotron-70b-instruct`
- StepFun: `stepfun` / `stepfun-plan` (`STEPFUN_API_KEY`)
- Example models: `stepfun/step-3.5-flash`, `stepfun-plan/step-3.5-flash-2603`
- Together: `together` (`TOGETHER_API_KEY`)
- Example model: `together/moonshotai/Kimi-K2.5`
- Venice: `venice` (`VENICE_API_KEY`)
- Xiaomi: `xiaomi` (`XIAOMI_API_KEY`)
- Example model: `xiaomi/mimo-v2-flash`
- Vercel AI Gateway: `vercel-ai-gateway` (`AI_GATEWAY_API_KEY`)
- Hugging Face Inference: `huggingface` (`HUGGINGFACE_HUB_TOKEN` or `HF_TOKEN`)
- Cloudflare AI Gateway: `cloudflare-ai-gateway` (`CLOUDFLARE_AI_GATEWAY_API_KEY`)
- Volcengine: `volcengine` (`VOLCANO_ENGINE_API_KEY`)
- Example model: `volcengine-plan/ark-code-latest`
- BytePlus: `byteplus` (`BYTEPLUS_API_KEY`)
- Example model: `byteplus-plan/ark-code-latest`
- xAI: `xai` (`XAI_API_KEY`)
  - Native bundled xAI requests use the xAI Responses path
  - `/fast` or `params.fastMode: true` rewrites `grok-3`, `grok-3-mini`,
    `grok-4`, and `grok-4-0709` to their `*-fast` variants
  - `tool_stream` defaults on; set
    `agents.defaults.models["xai/<model>"].params.tool_stream` to `false` to
    disable it
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- Example model: `mistral/mistral-large-latest`
- CLI: `openclaw onboard --auth-choice mistral-api-key`
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - GLM models on Cerebras use ids `zai-glm-4.7` and `zai-glm-4.6`.
  - OpenAI-compatible base URL: `https://api.cerebras.ai/v1`.
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)
- Hugging Face Inference example model: `huggingface/deepseek-ai/DeepSeek-R1`; CLI: `openclaw onboard --auth-choice huggingface-api-key`. See [Hugging Face (Inference)](/providers/huggingface).

## Providers via `models.providers` (custom/base URL)

Use `models.providers` (or `models.json`) to add **custom** providers or
OpenAI/Anthropic‑compatible proxies.

Many of the bundled provider plugins below already publish a default catalog.
Use explicit `models.providers.<id>` entries only when you want to override the
default base URL, headers, or model list.

### Moonshot AI (Kimi)

Moonshot ships as a bundled provider plugin. Use the built-in provider by
default, and add an explicit `models.providers.moonshot` entry only when you
need to override the base URL or model metadata:

- Provider: `moonshot`
- Auth: `MOONSHOT_API_KEY`
- Example model: `moonshot/kimi-k2.5`
- CLI: `openclaw onboard --auth-choice moonshot-api-key` or `openclaw onboard --auth-choice moonshot-api-key-cn`

Kimi K2 model IDs:

[//]: # "moonshot-kimi-k2-model-refs:start"

- `moonshot/kimi-k2.5`
- `moonshot/kimi-k2-thinking`
- `moonshot/kimi-k2-thinking-turbo`
- `moonshot/kimi-k2-turbo`

[//]: # "moonshot-kimi-k2-model-refs:end"

```json5
{
  agents: {
    defaults: { model: { primary: "moonshot/kimi-k2.5" } },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [{ id: "kimi-k2.5", name: "Kimi K2.5" }],
      },
    },
  },
}
```

### Kimi Coding

Kimi Coding uses Moonshot AI's Anthropic-compatible endpoint:

- Provider: `kimi`
- Auth: `KIMI_API_KEY`
- Example model: `kimi/kimi-code`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi/kimi-code" } },
  },
}
```

Legacy `kimi/k2p5` remains accepted as a compatibility model id.

### Volcano Engine (Doubao)

Volcano Engine (火山引擎) provides access to Doubao and other models in China.

- Provider: `volcengine` (coding: `volcengine-plan`)
- Auth: `VOLCANO_ENGINE_API_KEY`
- Example model: `volcengine-plan/ark-code-latest`
- CLI: `openclaw onboard --auth-choice volcengine-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "volcengine-plan/ark-code-latest" } },
  },
}
```

Onboarding defaults to the coding surface, but the general `volcengine/*`
catalog is registered at the same time.

In onboarding/configure model pickers, the Volcengine auth choice prefers both
`volcengine/*` and `volcengine-plan/*` rows. If those models are not loaded yet,
OpenClaw falls back to the unfiltered catalog instead of showing an empty
provider-scoped picker.

Available models:

- `volcengine/doubao-seed-1-8-251228` (Doubao Seed 1.8)
- `volcengine/doubao-seed-code-preview-251028`
- `volcengine/kimi-k2-5-260127` (Kimi K2.5)
- `volcengine/glm-4-7-251222` (GLM 4.7)
- `volcengine/deepseek-v3-2-251201` (DeepSeek V3.2 128K)

Coding models (`volcengine-plan`):

- `volcengine-plan/ark-code-latest`
- `volcengine-plan/doubao-seed-code`
- `volcengine-plan/kimi-k2.5`
- `volcengine-plan/kimi-k2-thinking`
- `volcengine-plan/glm-4.7`

### BytePlus (International)

BytePlus ARK provides access to the same models as Volcano Engine for international users.

- Provider: `byteplus` (coding: `byteplus-plan`)
- Auth: `BYTEPLUS_API_KEY`
- Example model: `byteplus-plan/ark-code-latest`
- CLI: `openclaw onboard --auth-choice byteplus-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "byteplus-plan/ark-code-latest" } },
  },
}
```

Onboarding defaults to the coding surface, but the general `byteplus/*`
catalog is registered at the same time.

In onboarding/configure model pickers, the BytePlus auth choice prefers both
`byteplus/*` and `byteplus-plan/*` rows. If those models are not loaded yet,
OpenClaw falls back to the unfiltered catalog instead of showing an empty
provider-scoped picker.

Available models:

- `byteplus/seed-1-8-251228` (Seed 1.8)
- `byteplus/kimi-k2-5-260127` (Kimi K2.5)
- `byteplus/glm-4-7-251222` (GLM 4.7)

Coding models (`byteplus-plan`):

- `byteplus-plan/ark-code-latest`
- `byteplus-plan/doubao-seed-code`
- `byteplus-plan/kimi-k2.5`
- `byteplus-plan/kimi-k2-thinking`
- `byteplus-plan/glm-4.7`

### Synthetic

Synthetic provides Anthropic-compatible models behind the `synthetic` provider:

- Provider: `synthetic`
- Auth: `SYNTHETIC_API_KEY`
- Example model: `synthetic/hf:MiniMaxAI/MiniMax-M2.5`
- CLI: `openclaw onboard --auth-choice synthetic-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.5" } },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [{ id: "hf:MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5" }],
      },
    },
  },
}
```

### MiniMax

MiniMax is configured via `models.providers` because it uses custom endpoints:

- MiniMax OAuth (Global): `--auth-choice minimax-global-oauth`
- MiniMax OAuth (CN): `--auth-choice minimax-cn-oauth`
- MiniMax API key (Global): `--auth-choice minimax-global-api`
- MiniMax API key (CN): `--auth-choice minimax-cn-api`
- Auth: `MINIMAX_API_KEY` for `minimax`; `MINIMAX_OAUTH_TOKEN` or
  `MINIMAX_API_KEY` for `minimax-portal`

See [/providers/minimax](/providers/minimax) for setup details, model options, and config snippets.

On MiniMax's Anthropic-compatible streaming path, OpenClaw disables thinking by
default unless you explicitly set it, and `/fast on` rewrites
`MiniMax-M2.7` to `MiniMax-M2.7-highspeed`.

Plugin-owned capability split:

- Text/chat defaults stay on `minimax/MiniMax-M2.7`
- Image generation is `minimax/image-01` or `minimax-portal/image-01`
- Image understanding is plugin-owned `MiniMax-VL-01` on both MiniMax auth paths
- Web search stays on provider id `minimax`

### Ollama

Ollama ships as a bundled provider plugin and uses Ollama's native API:

- Provider: `ollama`
- Auth: None required (local server)
- Example model: `ollama/llama3.3`
- Installation: [https://ollama.com/download](https://ollama.com/download)

```bash
# Install Ollama, then pull a model:
ollama pull llama3.3
```

```json5
{
  agents: {
    defaults: { model: { primary: "ollama/llama3.3" } },
  },
}
```

Ollama is detected locally at `http://127.0.0.1:11434` when you opt in with
`OLLAMA_API_KEY`, and the bundled provider plugin adds Ollama directly to
`openclaw onboard` and the model picker. See [/providers/ollama](/providers/ollama)
for onboarding, cloud/local mode, and custom configuration.

### vLLM

vLLM ships as a bundled provider plugin for local/self-hosted OpenAI-compatible
servers:

- Provider: `vllm`
- Auth: Optional (depends on your server)
- Default base URL: `http://127.0.0.1:8000/v1`

To opt in to auto-discovery locally (any value works if your server doesn’t enforce auth):

```bash
export VLLM_API_KEY="vllm-local"
```

Then set a model (replace with one of the IDs returned by `/v1/models`):

```json5
{
  agents: {
    defaults: { model: { primary: "vllm/your-model-id" } },
  },
}
```

See [/providers/vllm](/providers/vllm) for details.

### SGLang

SGLang ships as a bundled provider plugin for fast self-hosted
OpenAI-compatible servers:

- Provider: `sglang`
- Auth: Optional (depends on your server)
- Default base URL: `http://127.0.0.1:30000/v1`

To opt in to auto-discovery locally (any value works if your server does not
enforce auth):

```bash
export SGLANG_API_KEY="sglang-local"
```

Then set a model (replace with one of the IDs returned by `/v1/models`):

```json5
{
  agents: {
    defaults: { model: { primary: "sglang/your-model-id" } },
  },
}
```

See [/providers/sglang](/providers/sglang) for details.

### Local proxies (LM Studio, vLLM, LiteLLM, etc.)

Example (OpenAI‑compatible):

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/my-local-model" },
      models: { "lmstudio/my-local-model": { alias: "Local" } },
    },
  },
  models: {
    providers: {
      lmstudio: {
        baseUrl: "http://localhost:1234/v1",
        apiKey: "LMSTUDIO_KEY",
        api: "openai-completions",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Notes:

- For custom providers, `reasoning`, `input`, `cost`, `contextWindow`, and `maxTokens` are optional.
  When omitted, OpenClaw defaults to:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- Recommended: set explicit values that match your proxy/model limits.
- For `api: "openai-completions"` on non-native endpoints (any non-empty `baseUrl` whose host is not `api.openai.com`), OpenClaw forces `compat.supportsDeveloperRole: false` to avoid provider 400 errors for unsupported `developer` roles.
- Proxy-style OpenAI-compatible routes also skip native OpenAI-only request
  shaping: no `service_tier`, no Responses `store`, no prompt-cache hints, no
  OpenAI reasoning-compat payload shaping, and no hidden OpenClaw attribution
  headers.
- If `baseUrl` is empty/omitted, OpenClaw keeps the default OpenAI behavior (which resolves to `api.openai.com`).
- For safety, an explicit `compat.supportsDeveloperRole: true` is still overridden on non-native `openai-completions` endpoints.

## CLI examples

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

See also: [/gateway/configuration](/gateway/configuration) for full configuration examples.

## Related

- [Models](/concepts/models) — model configuration and aliases
- [Model Failover](/concepts/model-failover) — fallback chains and retry behavior
- [Configuration Reference](/gateway/configuration-reference#agent-defaults) — model config keys
- [Providers](/providers) — per-provider setup guides
