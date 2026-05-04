---
summary: "Model provider overview with example configs + CLI flows"
read_when:
  - You need a provider-by-provider model setup reference
  - You want example configs or CLI onboarding commands for model providers
title: "Model providers"
sidebarTitle: "Model providers"
---

Reference for **LLM/model providers** (not chat channels like WhatsApp/Telegram). For model selection rules, see [Models](/concepts/models).

## Quick rules

<AccordionGroup>
  <Accordion title="Model refs and CLI helpers">
    - Model refs use `provider/model` (example: `opencode/claude-opus-4-6`).
    - `agents.defaults.models` acts as an allowlist when set.
    - CLI helpers: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.
    - `models.providers.*.contextWindow` / `contextTokens` / `maxTokens` set provider-level defaults; `models.providers.*.models[].contextWindow` / `contextTokens` / `maxTokens` override them per model.
    - Fallback rules, cooldown probes, and session-override persistence: [Model failover](/concepts/model-failover).

  </Accordion>
  <Accordion title="Adding provider auth does not change your primary model">
    `openclaw configure` preserves an existing `agents.defaults.model.primary` when you add or reauth a provider. Provider plugins may still return a recommended default model in their auth config patch, but configure treats that as "make this model available" when a primary model already exists, not "replace the current primary model."

    To intentionally switch the default model, use `openclaw models set <provider/model>` or `openclaw models auth login --provider <id> --set-default`.

  </Accordion>
  <Accordion title="OpenAI provider/runtime split">
    OpenAI-family routes are prefix-specific:

    - `openai/<model>` plus `agents.defaults.agentRuntime.id: "codex"` uses the native Codex app-server harness. This is the usual ChatGPT/Codex subscription setup.
    - `openai-codex/<model>` uses Codex OAuth in PI.
    - `openai/<model>` without a Codex runtime override uses the direct OpenAI API-key provider in PI.

    See [OpenAI](/providers/openai) and [Codex harness](/plugins/codex-harness). If the provider/runtime split is confusing, read [Agent runtimes](/concepts/agent-runtimes) first.

    Plugin auto-enable follows the same boundary: `openai-codex/<model>` belongs to the OpenAI plugin, while the Codex plugin is enabled by `agentRuntime.id: "codex"` or legacy `codex/<model>` refs.

    GPT-5.5 is available through the native Codex app-server harness when `agentRuntime.id: "codex"` is set, through `openai-codex/gpt-5.5` in PI for Codex OAuth, and through `openai/gpt-5.5` in PI for direct API-key traffic when your account exposes it.

  </Accordion>
  <Accordion title="CLI runtimes">
    CLI runtimes use the same split: choose canonical model refs such as `anthropic/claude-*`, `google/gemini-*`, or `openai/gpt-*`, then set `agents.defaults.agentRuntime.id` to `claude-cli`, `google-gemini-cli`, or `codex-cli` when you want a local CLI backend.

    Legacy `claude-cli/*`, `google-gemini-cli/*`, and `codex-cli/*` refs migrate back to canonical provider refs with the runtime recorded separately.

  </Accordion>
</AccordionGroup>

## Plugin-owned provider behavior

Most provider-specific logic lives in provider plugins (`registerProvider(...)`) while OpenClaw keeps the generic inference loop. Plugins own onboarding, model catalogs, auth env-var mapping, transport/config normalization, tool-schema cleanup, failover classification, OAuth refresh, usage reporting, thinking/reasoning profiles, and more.

The full list of provider-SDK hooks and bundled-plugin examples lives in [Provider plugins](/plugins/sdk-provider-plugins). A provider that needs a totally custom request executor is a separate, deeper extension surface.

<Note>
Provider-owned runner behavior lives on explicit provider hooks such as replay policy, tool-schema normalization, stream wrapping, and transport/request helpers. The legacy `ProviderPlugin.capabilities` static bag is compatibility-only and is no longer read by shared runner logic.
</Note>

## API key rotation

<AccordionGroup>
  <Accordion title="Key sources and priority">
    Configure multiple keys via:

    - `OPENCLAW_LIVE_<PROVIDER>_KEY` (single live override, highest priority)
    - `<PROVIDER>_API_KEYS` (comma or semicolon list)
    - `<PROVIDER>_API_KEY` (primary key)
    - `<PROVIDER>_API_KEY_*` (numbered list, e.g. `<PROVIDER>_API_KEY_1`)

    For Google providers, `GOOGLE_API_KEY` is also included as fallback. Key selection order preserves priority and deduplicates values.

  </Accordion>
  <Accordion title="When rotation kicks in">
    - Requests are retried with the next key only on rate-limit responses (for example `429`, `rate_limit`, `quota`, `resource exhausted`, `Too many concurrent requests`, `ThrottlingException`, `concurrency limit reached`, `workers_ai ... quota limit exceeded`, or periodic usage-limit messages).
    - Non-rate-limit failures fail immediately; no key rotation is attempted.
    - When all candidate keys fail, the final error is returned from the last attempt.

  </Accordion>
</AccordionGroup>

## Built-in providers (pi-ai catalog)

OpenClaw ships with the pi‑ai catalog. These providers require **no** `models.providers` config; just set auth + pick a model.

### OpenAI

- Provider: `openai`
- Auth: `OPENAI_API_KEY`
- Optional rotation: `OPENAI_API_KEYS`, `OPENAI_API_KEY_1`, `OPENAI_API_KEY_2`, plus `OPENCLAW_LIVE_OPENAI_KEY` (single override)
- Example models: `openai/gpt-5.5`, `openai/gpt-5.4-mini`
- Verify account/model availability with `openclaw models list --provider openai` if a specific install or API key behaves differently.
- CLI: `openclaw onboard --auth-choice openai-api-key`
- Default transport is `auto` (WebSocket-first, SSE fallback)
- Override per model via `agents.defaults.models["openai/<model>"].params.transport` (`"sse"`, `"websocket"`, or `"auto"`)
- OpenAI Responses WebSocket warm-up defaults to enabled via `params.openaiWsWarmup` (`true`/`false`)
- OpenAI priority processing can be enabled via `agents.defaults.models["openai/<model>"].params.serviceTier`
- `/fast` and `params.fastMode` map direct `openai/*` Responses requests to `service_tier=priority` on `api.openai.com`
- Use `params.serviceTier` when you want an explicit tier instead of the shared `/fast` toggle
- Hidden OpenClaw attribution headers (`originator`, `version`, `User-Agent`) apply only on native OpenAI traffic to `api.openai.com`, not generic OpenAI-compatible proxies
- Native OpenAI routes also keep Responses `store`, prompt-cache hints, and OpenAI reasoning-compat payload shaping; proxy routes do not
- `openai/gpt-5.3-codex-spark` is intentionally suppressed in OpenClaw because live OpenAI API requests reject it and the current Codex catalog does not expose it

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
}
```

### Anthropic

- Provider: `anthropic`
- Auth: `ANTHROPIC_API_KEY`
- Optional rotation: `ANTHROPIC_API_KEYS`, `ANTHROPIC_API_KEY_1`, `ANTHROPIC_API_KEY_2`, plus `OPENCLAW_LIVE_ANTHROPIC_KEY` (single override)
- Example model: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice apiKey`
- Direct public Anthropic requests support the shared `/fast` toggle and `params.fastMode`, including API-key and OAuth-authenticated traffic sent to `api.anthropic.com`; OpenClaw maps that to Anthropic `service_tier` (`auto` vs `standard_only`)
- Preferred Claude CLI config keeps the model ref canonical and selects the CLI
  backend separately: `anthropic/claude-opus-4-7` with
  `agents.defaults.agentRuntime.id: "claude-cli"`. Legacy
  `claude-cli/claude-opus-4-7` refs still work for compatibility.

<Note>
Anthropic staff told us OpenClaw-style Claude CLI usage is allowed again, so OpenClaw treats Claude CLI reuse and `claude -p` usage as sanctioned for this integration unless Anthropic publishes a new policy. Anthropic setup-token remains available as a supported OpenClaw token path, but OpenClaw now prefers Claude CLI reuse and `claude -p` when available.
</Note>

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Codex OAuth

- Provider: `openai-codex`
- Auth: OAuth (ChatGPT)
- PI model ref: `openai-codex/gpt-5.5`
- Native Codex app-server harness ref: `openai/gpt-5.5` with `agents.defaults.agentRuntime.id: "codex"`
- Native Codex app-server harness docs: [Codex harness](/plugins/codex-harness)
- Legacy model refs: `codex/gpt-*`
- Plugin boundary: `openai-codex/*` loads the OpenAI plugin; the native Codex app-server plugin is selected only by the Codex harness runtime or legacy `codex/*` refs.
- CLI: `openclaw onboard --auth-choice openai-codex` or `openclaw models auth login --provider openai-codex`
- Default transport is `auto` (WebSocket-first, SSE fallback)
- Override per PI model via `agents.defaults.models["openai-codex/<model>"].params.transport` (`"sse"`, `"websocket"`, or `"auto"`)
- `params.serviceTier` is also forwarded on native Codex Responses requests (`chatgpt.com/backend-api`)
- Hidden OpenClaw attribution headers (`originator`, `version`, `User-Agent`) are only attached on native Codex traffic to `chatgpt.com/backend-api`, not generic OpenAI-compatible proxies
- Shares the same `/fast` toggle and `params.fastMode` config as direct `openai/*`; OpenClaw maps that to `service_tier=priority`
- `openai-codex/gpt-5.5` uses the Codex catalog native `contextWindow = 400000` and default runtime `contextTokens = 272000`; override the runtime cap with `models.providers.openai-codex.models[].contextTokens`
- Policy note: OpenAI Codex OAuth is explicitly supported for external tools/workflows like OpenClaw.
- For the common subscription plus native Codex runtime route, sign in with `openai-codex` auth but configure `openai/gpt-5.5` plus `agents.defaults.agentRuntime.id: "codex"`.
- Use `openai-codex/gpt-5.5` only when you want the Codex OAuth/subscription route through PI; use `openai/gpt-5.5` without the Codex runtime override when your API-key setup and local catalog expose the public API route.

```json5
{
  plugins: { entries: { codex: { enabled: true } } },
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.5" },
      agentRuntime: { id: "codex" },
    },
  },
}
```

```json5
{
  models: {
    providers: {
      "openai-codex": {
        models: [{ id: "gpt-5.5", contextTokens: 160000 }],
      },
    },
  },
}
```

### Other subscription-style hosted options

<CardGroup cols={3}>
  <Card title="GLM models" href="/providers/glm">
    Z.AI Coding Plan or general API endpoints.
  </Card>
  <Card title="MiniMax" href="/providers/minimax">
    MiniMax Coding Plan OAuth or API key access.
  </Card>
  <Card title="Qwen Cloud" href="/providers/qwen">
    Qwen Cloud provider surface plus Alibaba DashScope and Coding Plan endpoint mapping.
  </Card>
</CardGroup>

### OpenCode

- Auth: `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`)
- Zen runtime provider: `opencode`
- Go runtime provider: `opencode-go`
- Example models: `opencode/claude-opus-4-6`, `opencode-go/kimi-k2.6`
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
- Alias: `google/gemini-3.1-pro` is accepted and normalized to Google's live Gemini API id, `google/gemini-3.1-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`
- Thinking: `/think adaptive` uses Google dynamic thinking. Gemini 3/3.1 omit a fixed `thinkingLevel`; Gemini 2.5 sends `thinkingBudget: -1`.
- Direct Gemini runs also accept `agents.defaults.models["google/<model>"].params.cachedContent` (or legacy `cached_content`) to forward a provider-native `cachedContents/...` handle; Gemini cache hits surface as OpenClaw `cacheRead`

### Google Vertex and Gemini CLI

- Providers: `google-vertex`, `google-gemini-cli`
- Auth: Vertex uses gcloud ADC; Gemini CLI uses its OAuth flow

<Warning>
Gemini CLI OAuth in OpenClaw is an unofficial integration. Some users have reported Google account restrictions after using third-party clients. Review Google terms and use a non-critical account if you choose to proceed.
</Warning>

Gemini CLI OAuth is shipped as part of the bundled `google` plugin.

<Steps>
  <Step title="Install Gemini CLI">
    <Tabs>
      <Tab title="brew">
        ```bash
        brew install gemini-cli
        ```
      </Tab>
      <Tab title="npm">
        ```bash
        npm install -g @google/gemini-cli
        ```
      </Tab>
    </Tabs>
  </Step>
  <Step title="Enable plugin">
    ```bash
    openclaw plugins enable google
    ```
  </Step>
  <Step title="Login">
    ```bash
    openclaw models auth login --provider google-gemini-cli --set-default
    ```

    Default model: `google-gemini-cli/gemini-3-flash-preview`. You do **not** paste a client id or secret into `openclaw.json`. The CLI login flow stores tokens in auth profiles on the gateway host.

  </Step>
  <Step title="Set project (if needed)">
    If requests fail after login, set `GOOGLE_CLOUD_PROJECT` or `GOOGLE_CLOUD_PROJECT_ID` on the gateway host.
  </Step>
</Steps>

Gemini CLI JSON replies are parsed from `response`; usage falls back to `stats`, with `stats.cached` normalized into OpenClaw `cacheRead`.

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
- Example models: `vercel-ai-gateway/anthropic/claude-opus-4.6`, `vercel-ai-gateway/moonshotai/kimi-k2.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### Kilo Gateway

- Provider: `kilocode`
- Auth: `KILOCODE_API_KEY`
- Example model: `kilocode/kilo/auto`
- CLI: `openclaw onboard --auth-choice kilocode-api-key`
- Base URL: `https://api.kilo.ai/api/gateway/`
- Static fallback catalog ships `kilocode/kilo/auto`; live `https://api.kilo.ai/api/gateway/models` discovery can expand the runtime catalog further.
- Exact upstream routing behind `kilocode/kilo/auto` is owned by Kilo Gateway, not hard-coded in OpenClaw.

See [/providers/kilocode](/providers/kilocode) for setup details.

### Other bundled provider plugins

| Provider                | Id                               | Auth env                                                     | Example model                                 |
| ----------------------- | -------------------------------- | ------------------------------------------------------------ | --------------------------------------------- |
| BytePlus                | `byteplus` / `byteplus-plan`     | `BYTEPLUS_API_KEY`                                           | `byteplus-plan/ark-code-latest`               |
| Cerebras                | `cerebras`                       | `CEREBRAS_API_KEY`                                           | `cerebras/zai-glm-4.7`                        |
| Cloudflare AI Gateway   | `cloudflare-ai-gateway`          | `CLOUDFLARE_AI_GATEWAY_API_KEY`                              | —                                             |
| DeepInfra               | `deepinfra`                      | `DEEPINFRA_API_KEY`                                          | `deepinfra/deepseek-ai/DeepSeek-V3.2`         |
| DeepSeek                | `deepseek`                       | `DEEPSEEK_API_KEY`                                           | `deepseek/deepseek-v4-flash`                  |
| GitHub Copilot          | `github-copilot`                 | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`         | —                                             |
| Groq                    | `groq`                           | `GROQ_API_KEY`                                               | —                                             |
| Hugging Face Inference  | `huggingface`                    | `HUGGINGFACE_HUB_TOKEN` or `HF_TOKEN`                        | `huggingface/deepseek-ai/DeepSeek-R1`         |
| Kilo Gateway            | `kilocode`                       | `KILOCODE_API_KEY`                                           | `kilocode/kilo/auto`                          |
| Kimi Coding             | `kimi`                           | `KIMI_API_KEY` or `KIMICODE_API_KEY`                         | `kimi/kimi-code`                              |
| MiniMax                 | `minimax` / `minimax-portal`     | `MINIMAX_API_KEY` / `MINIMAX_OAUTH_TOKEN`                    | `minimax/MiniMax-M2.7`                        |
| Mistral                 | `mistral`                        | `MISTRAL_API_KEY`                                            | `mistral/mistral-large-latest`                |
| Moonshot                | `moonshot`                       | `MOONSHOT_API_KEY`                                           | `moonshot/kimi-k2.6`                          |
| NVIDIA                  | `nvidia`                         | `NVIDIA_API_KEY`                                             | `nvidia/nvidia/nemotron-3-super-120b-a12b`    |
| OpenRouter              | `openrouter`                     | `OPENROUTER_API_KEY`                                         | `openrouter/auto`                             |
| Qianfan                 | `qianfan`                        | `QIANFAN_API_KEY`                                            | `qianfan/deepseek-v3.2`                       |
| Qwen Cloud              | `qwen`                           | `QWEN_API_KEY` / `MODELSTUDIO_API_KEY` / `DASHSCOPE_API_KEY` | `qwen/qwen3.5-plus`                           |
| StepFun                 | `stepfun` / `stepfun-plan`       | `STEPFUN_API_KEY`                                            | `stepfun/step-3.5-flash`                      |
| Together                | `together`                       | `TOGETHER_API_KEY`                                           | `together/moonshotai/Kimi-K2.5`               |
| Venice                  | `venice`                         | `VENICE_API_KEY`                                             | —                                             |
| Vercel AI Gateway       | `vercel-ai-gateway`              | `AI_GATEWAY_API_KEY`                                         | `vercel-ai-gateway/anthropic/claude-opus-4.6` |
| Volcano Engine (Doubao) | `volcengine` / `volcengine-plan` | `VOLCANO_ENGINE_API_KEY`                                     | `volcengine-plan/ark-code-latest`             |
| xAI                     | `xai`                            | `XAI_API_KEY`                                                | `xai/grok-4.3`                                |
| Xiaomi                  | `xiaomi`                         | `XIAOMI_API_KEY`                                             | `xiaomi/mimo-v2-flash`                        |

#### Quirks worth knowing

<AccordionGroup>
  <Accordion title="OpenRouter">
    Applies its app-attribution headers and Anthropic `cache_control` markers only on verified `openrouter.ai` routes. DeepSeek, Moonshot, and ZAI refs are cache-TTL eligible for OpenRouter-managed prompt caching but do not receive Anthropic cache markers. As a proxy-style OpenAI-compatible path, it skips native-OpenAI-only shaping (`serviceTier`, Responses `store`, prompt-cache hints, OpenAI reasoning-compat). Gemini-backed refs keep proxy-Gemini thought-signature sanitation only.
  </Accordion>
  <Accordion title="Kilo Gateway">
    Gemini-backed refs follow the same proxy-Gemini sanitation path; `kilocode/kilo/auto` and other proxy-reasoning-unsupported refs skip proxy reasoning injection.
  </Accordion>
  <Accordion title="MiniMax">
    API-key onboarding writes explicit text-only M2.7 chat model definitions; image understanding stays on the plugin-owned `MiniMax-VL-01` media provider.
  </Accordion>
  <Accordion title="NVIDIA">
    Model ids use a `nvidia/<vendor>/<model>` namespace (for example `nvidia/nvidia/nemotron-...` alongside `nvidia/moonshotai/kimi-k2.5`); pickers preserve the literal `<provider>/<model-id>` composition while the canonical key sent to the API stays single-prefixed.
  </Accordion>
  <Accordion title="xAI">
    Uses the xAI Responses path. `grok-4.3` is the bundled default chat model. `/fast` or `params.fastMode: true` rewrites `grok-3`, `grok-3-mini`, `grok-4`, and `grok-4-0709` to their `*-fast` variants. `tool_stream` defaults on; disable via `agents.defaults.models["xai/<model>"].params.tool_stream=false`.
  </Accordion>
  <Accordion title="Cerebras">
    Ships as the bundled `cerebras` provider plugin. GLM uses `zai-glm-4.7`; OpenAI-compatible base URL is `https://api.cerebras.ai/v1`.
  </Accordion>
</AccordionGroup>

## Providers via `models.providers` (custom/base URL)

Use `models.providers` (or `models.json`) to add **custom** providers or OpenAI/Anthropic‑compatible proxies.

Many of the bundled provider plugins below already publish a default catalog. Use explicit `models.providers.<id>` entries only when you want to override the default base URL, headers, or model list.

Gateway model capability checks also read explicit `models.providers.<id>.models[]` metadata. If a custom or proxy model accepts images, set `input: ["text", "image"]` on that model so WebChat and node-origin attachment paths pass images as native model inputs instead of text-only media refs.

### Moonshot AI (Kimi)

Moonshot ships as a bundled provider plugin. Use the built-in provider by default, and add an explicit `models.providers.moonshot` entry only when you need to override the base URL or model metadata:

- Provider: `moonshot`
- Auth: `MOONSHOT_API_KEY`
- Example model: `moonshot/kimi-k2.6`
- CLI: `openclaw onboard --auth-choice moonshot-api-key` or `openclaw onboard --auth-choice moonshot-api-key-cn`

Kimi K2 model IDs:

[//]: # "moonshot-kimi-k2-model-refs:start"

- `moonshot/kimi-k2.6`
- `moonshot/kimi-k2.5`
- `moonshot/kimi-k2-thinking`
- `moonshot/kimi-k2-thinking-turbo`
- `moonshot/kimi-k2-turbo`

[//]: # "moonshot-kimi-k2-model-refs:end"

```json5
{
  agents: {
    defaults: { model: { primary: "moonshot/kimi-k2.6" } },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }],
      },
    },
  },
}
```

### Kimi coding

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

Onboarding defaults to the coding surface, but the general `volcengine/*` catalog is registered at the same time.

In onboarding/configure model pickers, the Volcengine auth choice prefers both `volcengine/*` and `volcengine-plan/*` rows. If those models are not loaded yet, OpenClaw falls back to the unfiltered catalog instead of showing an empty provider-scoped picker.

<Tabs>
  <Tab title="Standard models">
    - `volcengine/doubao-seed-1-8-251228` (Doubao Seed 1.8)
    - `volcengine/doubao-seed-code-preview-251028`
    - `volcengine/kimi-k2-5-260127` (Kimi K2.5)
    - `volcengine/glm-4-7-251222` (GLM 4.7)
    - `volcengine/deepseek-v3-2-251201` (DeepSeek V3.2 128K)

  </Tab>
  <Tab title="Coding models (volcengine-plan)">
    - `volcengine-plan/ark-code-latest`
    - `volcengine-plan/doubao-seed-code`
    - `volcengine-plan/kimi-k2.5`
    - `volcengine-plan/kimi-k2-thinking`
    - `volcengine-plan/glm-4.7`

  </Tab>
</Tabs>

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

Onboarding defaults to the coding surface, but the general `byteplus/*` catalog is registered at the same time.

In onboarding/configure model pickers, the BytePlus auth choice prefers both `byteplus/*` and `byteplus-plan/*` rows. If those models are not loaded yet, OpenClaw falls back to the unfiltered catalog instead of showing an empty provider-scoped picker.

<Tabs>
  <Tab title="Standard models">
    - `byteplus/seed-1-8-251228` (Seed 1.8)
    - `byteplus/kimi-k2-5-260127` (Kimi K2.5)
    - `byteplus/glm-4-7-251222` (GLM 4.7)

  </Tab>
  <Tab title="Coding models (byteplus-plan)">
    - `byteplus-plan/ark-code-latest`
    - `byteplus-plan/doubao-seed-code`
    - `byteplus-plan/kimi-k2.5`
    - `byteplus-plan/kimi-k2-thinking`
    - `byteplus-plan/glm-4.7`

  </Tab>
</Tabs>

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
- Auth: `MINIMAX_API_KEY` for `minimax`; `MINIMAX_OAUTH_TOKEN` or `MINIMAX_API_KEY` for `minimax-portal`

See [/providers/minimax](/providers/minimax) for setup details, model options, and config snippets.

<Note>
On MiniMax's Anthropic-compatible streaming path, OpenClaw disables thinking by default unless you explicitly set it, and `/fast on` rewrites `MiniMax-M2.7` to `MiniMax-M2.7-highspeed`.
</Note>

Plugin-owned capability split:

- Text/chat defaults stay on `minimax/MiniMax-M2.7`
- Image generation is `minimax/image-01` or `minimax-portal/image-01`
- Image understanding is plugin-owned `MiniMax-VL-01` on both MiniMax auth paths
- Web search stays on provider id `minimax`

### LM Studio

LM Studio ships as a bundled provider plugin which uses the native API:

- Provider: `lmstudio`
- Auth: `LM_API_TOKEN`
- Default inference base URL: `http://localhost:1234/v1`

Then set a model (replace with one of the IDs returned by `http://localhost:1234/api/v1/models`):

```json5
{
  agents: {
    defaults: { model: { primary: "lmstudio/openai/gpt-oss-20b" } },
  },
}
```

OpenClaw uses LM Studio's native `/api/v1/models` and `/api/v1/models/load` for discovery + auto-load, with `/v1/chat/completions` for inference by default. If you want LM Studio JIT loading, TTL, and auto-evict to own model lifecycle, set `models.providers.lmstudio.params.preload: false`. See [/providers/lmstudio](/providers/lmstudio) for setup and troubleshooting.

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

Ollama is detected locally at `http://127.0.0.1:11434` when you opt in with `OLLAMA_API_KEY`, and the bundled provider plugin adds Ollama directly to `openclaw onboard` and the model picker. See [/providers/ollama](/providers/ollama) for onboarding, cloud/local mode, and custom configuration.

### vLLM

vLLM ships as a bundled provider plugin for local/self-hosted OpenAI-compatible servers:

- Provider: `vllm`
- Auth: Optional (depends on your server)
- Default base URL: `http://127.0.0.1:8000/v1`

To opt in to auto-discovery locally (any value works if your server doesn't enforce auth):

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

SGLang ships as a bundled provider plugin for fast self-hosted OpenAI-compatible servers:

- Provider: `sglang`
- Auth: Optional (depends on your server)
- Default base URL: `http://127.0.0.1:30000/v1`

To opt in to auto-discovery locally (any value works if your server does not enforce auth):

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
        apiKey: "${LM_API_TOKEN}",
        api: "openai-completions",
        timeoutSeconds: 300,
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

<AccordionGroup>
  <Accordion title="Default optional fields">
    For custom providers, `reasoning`, `input`, `cost`, `contextWindow`, and `maxTokens` are optional. When omitted, OpenClaw defaults to:

    - `reasoning: false`
    - `input: ["text"]`
    - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
    - `contextWindow: 200000`
    - `maxTokens: 8192`

    Recommended: set explicit values that match your proxy/model limits.

  </Accordion>
  <Accordion title="Proxy-route shaping rules">
    - For `api: "openai-completions"` on non-native endpoints (any non-empty `baseUrl` whose host is not `api.openai.com`), OpenClaw forces `compat.supportsDeveloperRole: false` to avoid provider 400 errors for unsupported `developer` roles.
    - Proxy-style OpenAI-compatible routes also skip native OpenAI-only request shaping: no `service_tier`, no Responses `store`, no Completions `store`, no prompt-cache hints, no OpenAI reasoning-compat payload shaping, and no hidden OpenClaw attribution headers.
    - For OpenAI-compatible Completions proxies that need vendor-specific fields, set `agents.defaults.models["provider/model"].params.extra_body` (or `extraBody`) to merge extra JSON into the outbound request body.
    - For vLLM chat-template controls, set `agents.defaults.models["provider/model"].params.chat_template_kwargs`. The bundled vLLM plugin automatically sends `enable_thinking: false` and `force_nonempty_content: true` for `vllm/nemotron-3-*` when the session thinking level is off.
    - For slow local models or remote LAN/tailnet hosts, set `models.providers.<id>.timeoutSeconds`. This extends provider model HTTP request handling, including connect, headers, body streaming, and the total guarded-fetch abort, without increasing the whole agent runtime timeout.
    - Model provider HTTP calls allow Surge, Clash, and sing-box fake-IP DNS answers in `198.18.0.0/15` and `fc00::/7` only for the configured provider `baseUrl` hostname. Other private, loopback, link-local, and metadata destinations still require an explicit `models.providers.<id>.request.allowPrivateNetwork: true` opt-in.
    - If `baseUrl` is empty/omitted, OpenClaw keeps the default OpenAI behavior (which resolves to `api.openai.com`).
    - For safety, an explicit `compat.supportsDeveloperRole: true` is still overridden on non-native `openai-completions` endpoints.
    - For `api: "anthropic-messages"` on non-direct endpoints (any provider other than canonical `anthropic`, or a custom `models.providers.anthropic.baseUrl` whose host is not a public `api.anthropic.com` endpoint), OpenClaw suppresses implicit Anthropic beta headers such as `claude-code-20250219`, `interleaved-thinking-2025-05-14`, and OAuth markers, so custom Anthropic-compatible proxies do not reject unsupported beta flags. Set `models.providers.<id>.headers["anthropic-beta"]` explicitly if your proxy needs specific beta features.

  </Accordion>
</AccordionGroup>

## CLI examples

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

See also: [Configuration](/gateway/configuration) for full configuration examples.

## Related

- [Configuration reference](/gateway/config-agents#agent-defaults) — model config keys
- [Model failover](/concepts/model-failover) — fallback chains and retry behavior
- [Models](/concepts/models) — model configuration and aliases
- [Providers](/providers) — per-provider setup guides
