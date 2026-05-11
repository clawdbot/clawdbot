---
summary: "Run OpenClaw on local LLMs (LM Studio, vLLM, LiteLLM, custom OpenAI endpoints)"
read_when:
  - You want to serve models from your own GPU box
  - You are wiring LM Studio or an OpenAI-compatible proxy
  - You need the safest local model guidance
title: "Local models"
---

Local models are doable. They also raise the bar on hardware, context size, and prompt-injection defense — small or aggressively quantized cards truncate context and leak safety. This page is the opinionated guide for higher-end local stacks and custom OpenAI-compatible local servers. For lowest-friction onboarding, start with [LM Studio](/providers/lmstudio) or [Ollama](/providers/ollama) and `openclaw onboard`.

For local servers that should start only when a selected model needs them, see
[Local model services](/gateway/local-model-services).

## Hardware floor

Aim high: **≥2 maxed-out Mac Studios or an equivalent GPU rig (~$30k+)** for a comfortable agent loop. A single **24 GB** GPU works only for lighter prompts at higher latency. Always run the **largest / full-size variant you can host**; small or heavily quantized checkpoints raise prompt-injection risk (see [Security](/gateway/security)).

## Pick a backend

| Backend                                              | Use when                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| [LM Studio](/providers/lmstudio)                     | First-time local setup, GUI loader, native Responses API                    |
| [Ollama](/providers/ollama)                          | CLI workflow, model library, hands-off systemd service                      |
| MLX / vLLM / SGLang                                  | High-throughput self-hosted serving with an OpenAI-compatible HTTP endpoint |
| LiteLLM / OAI-proxy / custom OpenAI-compatible proxy | You front another model API and need OpenClaw to treat it as OpenAI         |

Use Responses API (`api: "openai-responses"`) when the backend supports it (LM Studio does). Otherwise stick to Chat Completions (`api: "openai-completions"`).

<Warning>
**WSL2 + Ollama + NVIDIA/CUDA users:** The official Ollama Linux installer enables a systemd service with `Restart=always`. On WSL2 GPU setups, autostart can reload the last model during boot and pin host memory. If your WSL2 VM repeatedly restarts after enabling Ollama, see [WSL2 crash loop](/providers/ollama#wsl2-crash-loop-repeated-reboots).
</Warning>

## Recommended: LM Studio + large local model (Responses API)

Best current local stack. Load a large model in LM Studio (for example, a full-size Qwen, DeepSeek, or Llama build), enable the local server (default `http://127.0.0.1:1234`), and use Responses API to keep reasoning separate from final text.

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

**Setup checklist**

- Install LM Studio: [https://lmstudio.ai](https://lmstudio.ai)
- In LM Studio, download the **largest model build available** (avoid "small"/heavily quantized variants), start the server, confirm `http://127.0.0.1:1234/v1/models` lists it.
- Replace `my-local-model` with the actual model ID shown in LM Studio.
- Keep the model loaded; cold-load adds startup latency.
- Adjust `contextWindow`/`maxTokens` if your LM Studio build differs.
- For WhatsApp, stick to Responses API so only final text is sent.

Keep hosted models configured even when running local; use `models.mode: "merge"` so fallbacks stay available.

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

### Local-first with hosted safety net

Swap the primary and fallback order; keep the same providers block and `models.mode: "merge"` so you can fall back to Sonnet or Opus when the local box is down.

### Regional hosting / data routing

- Hosted MiniMax/Kimi/GLM variants also exist on OpenRouter with region-pinned endpoints (e.g., US-hosted). Pick the regional variant there to keep traffic in your chosen jurisdiction while still using `models.mode: "merge"` for Anthropic/OpenAI fallbacks.
- Local-only remains the strongest privacy path; hosted regional routing is the middle ground when you need provider features but want control over data flow.

## Other OpenAI-compatible local proxies

MLX (`mlx_lm.server`), vLLM, SGLang, LiteLLM, OAI-proxy, or custom
gateways work if they expose an OpenAI-style `/v1/chat/completions`
endpoint. Use the Chat Completions adapter unless the backend explicitly
documents `/v1/responses` support. Replace the provider block above with your
endpoint and model ID:

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

If `api` is omitted on a custom provider with a `baseUrl`, OpenClaw defaults to
`openai-completions`. Loopback endpoints such as `127.0.0.1` are trusted
automatically; LAN, tailnet, and private DNS endpoints still need
`request.allowPrivateNetwork: true`.

The `models.providers.<id>.models[].id` value is provider-local. Do not
include the provider prefix there. For example, an MLX server started with
`mlx_lm.server --model mlx-community/Qwen3-30B-A3B-6bit` should use this
catalog id and model ref:

- `models.providers.mlx.models[].id: "mlx-community/Qwen3-30B-A3B-6bit"`
- `agents.defaults.model.primary: "mlx/mlx-community/Qwen3-30B-A3B-6bit"`

Set `input: ["text", "image"]` on local or proxied vision models so image
attachments are injected into agent turns. Interactive custom-provider
onboarding infers common vision model IDs and asks only for unknown names.
Non-interactive onboarding uses the same inference; use `--custom-image-input`
for unknown vision IDs or `--custom-text-input` when a known-looking model is
text-only behind your endpoint.

Keep `models.mode: "merge"` so hosted models stay available as fallbacks.
Use `models.providers.<id>.timeoutSeconds` for slow local or remote model
servers before raising `agents.defaults.timeoutSeconds`. The provider timeout
applies only to model HTTP requests, including connect, headers, body streaming,
and the total guarded-fetch abort.

<Note>
For custom OpenAI-compatible providers, persisting a non-secret local marker such as `apiKey: "ollama-local"` is accepted when `baseUrl` resolves to loopback, a private LAN, `.local`, or a bare hostname. OpenClaw treats it as a valid local credential instead of reporting a missing key. Use a real value for any provider that accepts a public hostname.
</Note>

Behavior note for local/proxied `/v1` backends:

- OpenClaw treats these as proxy-style OpenAI-compatible routes, not native
  OpenAI endpoints
- native OpenAI-only request shaping does not apply here: no
  `service_tier`, no Responses `store`, no OpenAI reasoning-compat payload
  shaping, and no prompt-cache hints
- hidden OpenClaw attribution headers (`originator`, `version`, `User-Agent`)
  are not injected on these custom proxy URLs

Compatibility notes for stricter OpenAI-compatible backends:

- Some servers accept only string `messages[].content` on Chat Completions, not
  structured content-part arrays. Set
  `models.providers.<provider>.models[].compat.requiresStringContent: true` for
  those endpoints.
- Some local models emit standalone bracketed tool requests as text, such as
  `[tool_name]` followed by JSON and `[END_TOOL_REQUEST]`. OpenClaw promotes
  those into real tool calls only when the name exactly matches a registered
  tool for the turn; otherwise the block is treated as unsupported text and is
  hidden from user-visible replies.
- If a model emits JSON, XML, or ReAct-style text that looks like a tool call
  but the provider did not emit a structured invocation, OpenClaw leaves it as
  text and logs a warning with the run id, provider/model, detected pattern, and
  tool name when available. Treat that as provider/model tool-call
  incompatibility, not a completed tool run.
- If tools appear as assistant text instead of running, for example raw JSON,
  XML, ReAct syntax, or an empty `tool_calls` array in the provider response,
  first verify the server is using a tool-call-capable chat template/parser. For
  OpenAI-compatible Chat Completions backends whose parser works only when tool
  use is forced, set a per-model request override instead of relying on text
  parsing:

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

  Use this only for models/sessions where every normal turn should call a tool.
  It overrides OpenClaw's default proxy value of `tool_choice: "auto"`.
  Replace `local/my-local-model` with the exact provider/model ref shown by
  `openclaw models list`.

  ```bash
  openclaw config set agents.defaults.models '{"local/my-local-model":{"params":{"extra_body":{"tool_choice":"required"}}}}' --strict-json --merge
  ```

- If a custom OpenAI-compatible model accepts OpenAI reasoning efforts beyond
  the built-in profile, declare them on the model compat block. Adding `"xhigh"`
  here makes `/think xhigh`, session pickers, Gateway validation, and `llm-task`
  validation expose the level for that configured provider/model ref:

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

If the model loads cleanly but full agent turns misbehave, work top-down — confirm transport first, then narrow the surface.

1. **Confirm the local model itself responds.** No tools, no agent context:

   ```bash
   openclaw infer model run --local --model <provider/model> --prompt "Reply with exactly: pong" --json
   ```

2. **Confirm Gateway routing.** Sends only the supplied prompt — skips transcript, AGENTS bootstrap, context-engine assembly, tools, and bundled MCP servers, but still exercises Gateway routing, auth, and provider selection:

   ```bash
   openclaw infer model run --gateway --model <provider/model> --prompt "Reply with exactly: pong" --json
   ```

3. **Try lean mode.** If both probes pass but real agent turns fail with malformed tool calls or oversized prompts, enable `agents.defaults.experimental.localModelLean: true`. It drops the three heaviest default tools (`browser`, `cron`, `message`) so the prompt shape is smaller and less brittle. See [Experimental Features → Local model lean mode](/concepts/experimental-features#local-model-lean-mode) for the full explanation, when to use it, and how to confirm it is on.

4. **Disable tools entirely as a last resort.** If lean mode is not enough, set `models.providers.<provider>.models[].compat.supportsTools: false` for that model entry. The agent will then operate without tool calls on that model.

5. **Past that, the bottleneck is upstream.** If the backend still fails only on larger OpenClaw runs after lean mode and `supportsTools: false`, the remaining issue is usually upstream model or server capacity — context window, GPU memory, kv-cache eviction, or a backend bug. It is not OpenClaw's transport layer at that point.

## Troubleshooting

- Gateway can reach the proxy? `curl http://127.0.0.1:1234/v1/models`.
- LM Studio model unloaded? Reload; cold start is a common "hanging" cause.
- Local server says `terminated`, `ECONNRESET`, or closes the stream mid-turn?
  OpenClaw records a low-cardinality `model.call.error.failureKind` plus the
  OpenClaw process RSS/heap snapshot in diagnostics. For LM Studio/Ollama
  memory pressure, match that timestamp against the server log or macOS crash /
  jetsam log to confirm whether the model server was killed.
- OpenClaw derives context-window preflight thresholds from the detected model window, or from the uncapped model window when `agents.defaults.contextTokens` lowers the effective window. It warns below 20% with an **8k** floor. Hard blocks use the 10% threshold with a **4k** floor, capped to the effective context window so oversized model metadata cannot reject an otherwise valid user cap. If you hit that preflight, raise the server/model context limit or choose a larger model.
- Context errors? Lower `contextWindow` or raise your server limit.
- OpenAI-compatible server returns `messages[].content ... expected a string`?
  Add `compat.requiresStringContent: true` on that model entry.
- OpenAI-compatible server returns `validation.keys` or says message entries only allow `role` and `content`?
  Add `compat.strictMessageKeys: true` on that model entry.
- Direct tiny `/v1/chat/completions` calls work, but `openclaw infer model run --local`
  fails on Gemma or another local model? Check the provider URL, model ref, auth
  marker, and server logs first; local `model run` does not include agent tools.
  If local `model run` succeeds but larger agent turns fail, reduce the agent
  tool surface with `localModelLean` or `compat.supportsTools: false`.
- Tool calls show up as raw JSON/XML/ReAct text, or the provider returns an
  empty `tool_calls` array? Do not add a proxy that blindly converts assistant
  text into tool execution. Fix the server chat template/parser first. If the
  model only works when tool use is forced, add the per-model
  `params.extra_body.tool_choice: "required"` override above and use that model
  entry only for sessions where a tool call is expected on every turn.
- Safety: local models skip provider-side filters; keep agents narrow and compaction on to limit prompt injection blast radius.

## Related

- [Configuration reference](/gateway/configuration-reference)
- [Model failover](/concepts/model-failover)
