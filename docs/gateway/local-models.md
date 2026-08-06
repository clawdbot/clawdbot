---
summary: "Run OpenClaw on local LLMs (LM Studio, vLLM, LiteLLM, custom OpenAI endpoints)"
read_when:
  - You want to serve models from your own GPU box
  - You are wiring LM Studio or an OpenAI-compatible proxy
  - You need the safest local model guidance
title: "Local models"
---

Local models work, but they raise the bar on hardware, context size, and prompt-injection defense: small or aggressively quantized models truncate context and skip provider-side safety filters. This page covers higher-end local stacks and custom OpenAI-compatible servers. For the lowest-friction path, start with [LM Studio](/providers/lmstudio) or [Ollama](/providers/ollama) and `openclaw onboard`.

For local servers that should start only when a selected model needs them, see [Local model services](/gateway/local-model-services).

## Hardware floor

Aim for **2+ maxed-out Mac Studios or an equivalent GPU rig (~$30k+)** for a comfortable agent loop. A single **24 GB** GPU only handles lighter prompts at higher latency. Always run the **largest / full-size variant you can host** - small or heavily quantized checkpoints raise prompt-injection risk (see [Security](/gateway/security)).

## Pick a backend

| Backend                                              | Use when                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| [ds4](/providers/ds4)                                | Local DeepSeek V4 Flash on macOS Metal with OpenAI-compatible tool calls    |
| [LM Studio](/providers/lmstudio)                     | First-time local setup, GUI loader, native Responses API                    |
| LiteLLM / OAI-proxy / custom OpenAI-compatible proxy | You front another model API and need OpenClaw to treat it as OpenAI         |
| MLX / vLLM / SGLang                                  | High-throughput self-hosted serving with an OpenAI-compatible HTTP endpoint |
| [Ollama](/providers/ollama)                          | CLI workflow, model library, hands-off systemd service                      |

Use `api: "openai-responses"` when the backend supports it (LM Studio does). Otherwise use `api: "openai-completions"`. If `api` is omitted on a custom provider with a `baseUrl`, OpenClaw defaults to `openai-completions`.

<Warning>
**WSL2 + Ollama + NVIDIA/CUDA:** the official Ollama Linux installer enables a systemd service with `Restart=always`. On WSL2 GPU setups, autostart can reload the last model during boot and pin host memory, causing repeated VM restarts. See [WSL2 crash loop](/providers/ollama#troubleshooting).
</Warning>

## LM Studio + large local model (Responses API)

This is the best current local stack. Load a large model in LM Studio (a full-size Qwen, DeepSeek, or Llama build), enable the local server (default `http://127.0.0.1:1234`), and use the Responses API to keep reasoning separate from final text.

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/my-local-model" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/my-local-model": { alias: "Local" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Setup checklist:

- Install LM Studio: [https://lmstudio.ai](https://lmstudio.ai)
- Download the **largest available model build** (avoid "small"/heavily quantized variants), start the server, confirm `http://127.0.0.1:1234/v1/models` lists it.
- Replace `my-local-model` with the actual model ID shown in LM Studio.
- Keep the model loaded; cold-load adds startup latency.
- Adjust `contextWindow`/`maxTokens` if your LM Studio build differs.
- For WhatsApp, stick to the Responses API so only final text is sent.
- Keep `models.mode: "merge"` so hosted models stay available as fallbacks.

### Hybrid config: hosted primary, local fallback

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["lmstudio/my-local-model", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
        "lmstudio/my-local-model": { alias: "Local" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

For local-first with a hosted safety net, swap `primary`/`fallbacks` order and keep the same `providers` block and `models.mode: "merge"`.

### Regional hosting / data routing

Hosted MiniMax/Kimi/GLM variants also exist on OpenRouter with region-pinned endpoints (for example, US-hosted). Pick the regional variant to keep traffic in your chosen jurisdiction while keeping `models.mode: "merge"` for Anthropic/OpenAI fallbacks. Local-only is still the strongest privacy path; hosted regional routing is the middle ground when you need provider features but want control over data flow.

## Other OpenAI-compatible local proxies

MLX (`mlx_lm.server`), vLLM, SGLang, LiteLLM, OAI-proxy, or any custom gateway works if it exposes an OpenAI-style `/v1/chat/completions` endpoint. Use `openai-completions` unless the backend explicitly documents `/v1/responses` support.

```json5
{
  agents: {
    defaults: {
      model: { primary: "local/my-local-model" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-local",
        api: "openai-completions",
        timeoutSeconds: 300,
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Custom/local provider entries trust their exact configured `baseUrl` origin for guarded model requests, including loopback, LAN, tailnet, and private DNS hosts. Metadata/link-local origins are always blocked regardless. Requests to other private origins still need `models.providers.<id>.request.allowPrivateNetwork: true`; set the trust flag to `false` to opt out of exact-origin trust.

`models.providers.<id>.models[].id` is provider-local - do not include the provider prefix. For an MLX server started with `mlx_lm.server --model mlx-community/Qwen3-30B-A3B-6bit`:

- `models.providers.mlx.models[].id: "mlx-community/Qwen3-30B-A3B-6bit"`
- `agents.defaults.model.primary: "mlx/mlx-community/Qwen3-30B-A3B-6bit"`

Set `input: ["text", "image"]` on local or proxied vision models so image attachments get injected into agent turns. Interactive custom-provider onboarding infers common vision model IDs and only asks about unknown names; non-interactive onboarding uses the same inference, with `--custom-image-input` / `--custom-text-input` to override it.

Use `models.providers.<id>.timeoutSeconds` for slow local/remote model servers before raising `agents.defaults.timeoutSeconds`. The provider timeout covers connect, headers, body streaming, and the total guarded-fetch abort for model HTTP requests only - if the agent/run timeout is lower, raise that too, since the provider timeout cannot extend the whole run.

<Note>
For custom OpenAI-compatible providers, a non-secret local marker such as `apiKey: "ollama-local"` is accepted when `baseUrl` resolves to loopback, a private LAN, `.local`, or a bare hostname - OpenClaw treats it as a valid local credential instead of reporting a missing key. Use a real value for any provider that accepts a public hostname.
</Note>

Behavior notes for local/proxied `/v1` backends:

- OpenClaw treats these as proxy-style OpenAI-compatible routes, not native OpenAI endpoints.
- Native-OpenAI-only request shaping does not apply: no `service_tier`, no Responses `store`, no OpenAI reasoning-compat payload shaping, no prompt-cache hints.
- Hidden OpenClaw attribution headers (`originator`, `version`, `User-Agent`) are not injected on custom proxy URLs.

Compat declarations are only for the custom endpoint described by this provider row. Catalog-known routes use provider-owned capabilities instead; see the [custom-provider capability guide](/gateway/config-tools#custom-provider-capability-declarations).

Compat overrides for stricter OpenAI-compatible backends:

- **String-only content**: some servers accept only string `messages[].content`, not structured content-part arrays. Set `models.providers.<provider>.models[].compat.requiresStringContent: true`.
- **Strict message keys**: if the server rejects message entries with more than `role`/`content`, set `compat.strictMessageKeys: true`.
- **Bracketed tool text**: some local models emit standalone bracketed tool requests as text, like `[tool_name]` followed by JSON and `[END_TOOL_REQUEST]`. OpenClaw promotes those to real tool calls only when the name exactly matches a registered tool for the turn; otherwise it stays as hidden, unsupported text.
- **Unstructured tool-call-looking text**: if a model emits JSON/XML/ReAct-style text that looks like a tool call but wasn't a structured invocation, OpenClaw leaves it as text and logs a warning with the run id, provider/model, detected pattern, and tool name when available. That is provider/model incompatibility, not a completed tool run.
- **Forcing tool use**: if tools show up as assistant text (raw JSON/XML/ReAct, or an empty `tool_calls` array), first confirm the server's chat template/parser supports tool calls. If the parser only works when tool use is forced, override the default proxy value of `tool_choice: "auto"` per model:

  ```json5
  {
    agents: {
      defaults: {
        models: {
          "local/my-local-model": {
            params: {
              extra_body: {
                tool_choice: "required",
              },
            },
          },
        },
      },
    },
  }
  ```

  Use this only where every normal turn should call a tool. Replace `local/my-local-model` with the exact ref from `openclaw models list`, or set it via CLI:

  ```bash
  openclaw config set agents.defaults.models '{"local/my-local-model":{"params":{"extra_body":{"tool_choice":"required"}}}}' --strict-json --merge
  ```

- **Extra reasoning efforts**: if a custom OpenAI-compatible model accepts OpenAI reasoning efforts beyond the built-in profile, declare them in the model's compat block. Adding `"xhigh"` exposes it for that model ref in `/think xhigh`, session pickers, Gateway validation, and `llm-task` validation:

  ```json5
  {
    models: {
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:8000/v1",
          apiKey: "sk-local",
          api: "openai-responses",
          models: [
            {
              id: "gpt-5.4",
              name: "GPT 5.4 via local proxy",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 196608,
              maxTokens: 8192,
              compat: {
                supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
                reasoningEffortMap: { xhigh: "xhigh" },
              },
            },
          ],
        },
      },
    },
  }
  ```

## Smaller or stricter backends

If the model loads cleanly but full agent turns misbehave, work top-down: confirm transport first, then narrow the surface.

1. **Confirm the local model responds** - no tools, no agent context:

   ```bash
   openclaw infer model run --local --model <provider/model> --prompt "Reply with exactly: pong" --json
   ```

2. **Confirm Gateway routing** - sends only the prompt, skipping transcript, AGENTS bootstrap, context-engine assembly, tools, and bundled MCP servers, but still exercises Gateway routing, auth, and provider selection:

   ```bash
   openclaw infer model run --gateway --model <provider/model> --prompt "Reply with exactly: pong" --json
   ```

3. **Try lean mode** if both probes pass but real agent turns fail with malformed tool calls or oversized prompts: set `agents.defaults.experimental.localModelLean: true`. It drops heavyweight browser, cron, message, media-generation, voice, and PDF tools unless explicitly required, and defaults larger tool catalogs behind structured Tool Search controls while keeping `exec` directly visible. See [Experimental Features -> Local model lean mode](/concepts/experimental-features#local-model-lean-mode) for details and how to confirm it's on.

4. **Disable tools entirely as a last resort** by setting `models.providers.<provider>.models[].compat.supportsTools: false` for that model - the agent then runs without tool calls.

5. **Past that, the bottleneck is upstream.** If the backend still fails only on larger OpenClaw runs after lean mode and `supportsTools: false`, the remaining issue is usually the model or server itself - context window, GPU memory, kv-cache eviction, or a backend bug - not OpenClaw's transport layer.

## Troubleshooting

- **Gateway can't reach the proxy?** `curl http://127.0.0.1:1234/v1/models`.
- **LM Studio model unloaded?** Reload; cold start is a common "hanging" cause.
- **Local server says `terminated`, `ECONNRESET`, or closes the stream mid-turn?** OpenClaw records a low-cardinality `model.call.error.failureKind` plus the OpenClaw process RSS/heap snapshot in diagnostics. For LM Studio/Ollama memory pressure, match that timestamp against the server log or a macOS crash/jetsam log to confirm whether the model server was killed.
- **Context errors?** OpenClaw derives context-window preflight thresholds from the detected model window (or the capped window when `agents.defaults.contextTokens` lowers it), warning below 20% with an **8k** floor and hard-blocking below 10% with a **4k** floor (capped to the effective context window so oversized model metadata can't reject a valid user cap). Lower `contextWindow` or raise the server/model context limit.
- **`messages[].content ... expected a string`?** Add `compat.requiresStringContent: true` on that model entry.
- **`validation.keys`, or "message entries only allow `role` and `content`"?** Add `compat.strictMessageKeys: true` on that model entry.
- **Direct `/v1/chat/completions` calls work, but `openclaw infer model run --local` fails on Gemma or another local model?** Check the provider URL, model ref, auth marker, and server logs first - `model run` skips agent tools entirely. If `model run` succeeds but larger agent turns fail, reduce the tool surface with `localModelLean` or `compat.supportsTools: false`.
- **Tool calls show up as raw JSON/XML/ReAct text, or the provider returns an empty `tool_calls` array?** Do not add a proxy that blindly converts assistant text into tool execution - fix the server's chat template/parser first. If the model only works when tool use is forced, add the `params.extra_body.tool_choice: "required"` override above and use that model entry only for sessions where a tool call is expected every turn.
- **Safety**: local models skip provider-side filters. Keep agents narrow and compaction on to limit prompt-injection blast radius.

## Related

- [Configuration reference](/gateway/configuration-reference)
- [Model failover](/concepts/model-failover)
