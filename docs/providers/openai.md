---
summary: "Use OpenAI via API keys or Codex subscription in OpenClaw"
read_when:
  - You want to use OpenAI models in OpenClaw
  - You want Codex subscription auth instead of API keys
  - You need stricter GPT-5 agent execution behavior
title: "OpenAI"
---

# OpenAI

OpenAI provides developer APIs for GPT models. OpenClaw supports two auth routes:

- **API key** — direct OpenAI Platform access with usage-based billing (`openai/*` models)
- **Codex subscription** — ChatGPT/Codex sign-in with subscription access (`openai-codex/*` models)

OpenAI explicitly supports subscription OAuth usage in external tools and workflows like OpenClaw.

## Getting started

Choose your preferred auth method and follow the setup steps.

<Tabs>
  <Tab title="API key (OpenAI Platform)">
    **Best for:** direct API access and usage-based billing.

    <Steps>
      <Step title="Get your API key">
        Create or copy an API key from the [OpenAI Platform dashboard](https://platform.openai.com/api-keys).
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice openai-api-key
        ```

        Or pass the key directly:

        ```bash
        openclaw onboard --openai-api-key "$OPENAI_API_KEY"
        ```
      </Step>
      <Step title="Verify the model is available">
        ```bash
        openclaw models list --provider openai
        ```
      </Step>
    </Steps>

    ### Route summary

    | Model ref | Route | Auth |
    |-----------|-------|------|
    | `openai/gpt-5.4` | Direct OpenAI Platform API | `OPENAI_API_KEY` |
    | `openai/gpt-5.4-pro` | Direct OpenAI Platform API | `OPENAI_API_KEY` |

    <Note>
    ChatGPT/Codex sign-in is routed through `openai-codex/*`, not `openai/*`.
    </Note>

    ### Config example

    ```json5
    {
      env: { OPENAI_API_KEY: "sk-..." },
      agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
    }
    ```

    <Warning>
    OpenClaw does **not** expose `openai/gpt-5.3-codex-spark` on the direct API path. Live OpenAI API requests reject that model. Spark is Codex-only.
    </Warning>

  </Tab>

  <Tab title="Codex subscription">
    **Best for:** using your ChatGPT/Codex subscription instead of a separate API key. Codex cloud requires ChatGPT sign-in.

    <Steps>
      <Step title="Run Codex OAuth">
        ```bash
        openclaw onboard --auth-choice openai-codex
        ```

        Or run OAuth directly:

        ```bash
        openclaw models auth login --provider openai-codex
        ```
      </Step>
      <Step title="Set the default model">
        ```bash
        openclaw config set agents.defaults.model.primary openai-codex/gpt-5.4
        ```
      </Step>
      <Step title="Verify the model is available">
        ```bash
        openclaw models list --provider openai-codex
        ```
      </Step>
    </Steps>

    ### Route summary

    | Model ref | Route | Auth |
    |-----------|-------|------|
    | `openai-codex/gpt-5.4` | ChatGPT/Codex OAuth | Codex sign-in |
    | `openai-codex/gpt-5.3-codex-spark` | ChatGPT/Codex OAuth | Codex sign-in (entitlement-dependent) |

    <Note>
    This route is intentionally separate from `openai/gpt-5.4`. Use `openai/*` with an API key for direct Platform access, and `openai-codex/*` for Codex subscription access.
    </Note>

    ### Config example

    ```json5
    {
      agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
    }
    ```

    <Tip>
    If onboarding reuses an existing Codex CLI login, those credentials stay managed by Codex CLI. On expiry, OpenClaw re-reads the external Codex source first and writes the refreshed credential back to Codex storage.
    </Tip>

    ### Context window cap

    OpenClaw treats model metadata and the runtime context cap as separate values.

    For `openai-codex/gpt-5.4`:

    - Native `contextWindow`: `1050000`
    - Default runtime `contextTokens` cap: `272000`

    The smaller default cap has better latency and quality characteristics in practice. Override it with `contextTokens`:

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

    <Note>
    Use `contextWindow` to declare native model metadata. Use `contextTokens` to limit the runtime context budget.
    </Note>

  </Tab>
</Tabs>

## Image generation

The bundled `openai` plugin registers image generation through the `image_generate` tool.

| Capability                | Value                              |
| ------------------------- | ---------------------------------- |
| Default model             | `openai/gpt-image-1`               |
| Max images per request    | 4                                  |
| Edit mode                 | Enabled (up to 5 reference images) |
| Size overrides            | Supported                          |
| Aspect ratio / resolution | Not forwarded to OpenAI Images API |

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: { primary: "openai/gpt-image-1" },
    },
  },
}
```

<Note>
See [Image Generation](/tools/image-generation) for shared tool parameters, provider selection, and failover behavior.
</Note>

## Video generation

The bundled `openai` plugin registers video generation through the `video_generate` tool.

| Capability       | Value                                                                             |
| ---------------- | --------------------------------------------------------------------------------- |
| Default model    | `openai/sora-2`                                                                   |
| Modes            | Text-to-video, image-to-video, single-video edit                                  |
| Reference inputs | 1 image or 1 video                                                                |
| Size overrides   | Supported                                                                         |
| Other overrides  | `aspectRatio`, `resolution`, `audio`, `watermark` are ignored with a tool warning |

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: { primary: "openai/sora-2" },
    },
  },
}
```

<Note>
See [Video Generation](/tools/video-generation) for shared tool parameters, provider selection, and failover behavior.
</Note>

## GPT-5 prompt contribution

OpenClaw adds an OpenAI-specific GPT-5 prompt contribution for `openai/*` and `openai-codex/*` GPT-5-family runs. It lives in the bundled OpenAI plugin, applies to model ids such as `gpt-5`, `gpt-5.2`, `gpt-5.4`, and `gpt-5.4-mini`, and does not apply to older GPT-4.x models.

The GPT-5 contribution adds a tagged behavior contract for persona persistence, execution safety, tool discipline, output shape, completion checks, and verification. Channel-specific reply and silent-message behavior stays in the shared OpenClaw system prompt and outbound delivery policy. The GPT-5 guidance is always enabled for matching models. The friendly interaction-style layer is separate and configurable.

| Value                  | Effect                                      |
| ---------------------- | ------------------------------------------- |
| `"friendly"` (default) | Enable the friendly interaction-style layer |
| `"on"`                 | Alias for `"friendly"`                      |
| `"off"`                | Disable only the friendly style layer       |

<Tabs>
  <Tab title="Config">
    ```json5
    {
      plugins: {
        entries: {
          openai: { config: { personality: "friendly" } },
        },
      },
    }
    ```
  </Tab>
  <Tab title="CLI">
    ```bash
    openclaw config set plugins.entries.openai.config.personality off
    ```
  </Tab>
</Tabs>

<Tip>
Values are case-insensitive at runtime, so `"Off"` and `"off"` both disable the friendly style layer.
</Tip>

## Voice and speech

<AccordionGroup>
  <Accordion title="Speech synthesis (TTS)">
    The bundled `openai` plugin registers speech synthesis for the `messages.tts` surface.

    | Setting | Config path | Default |
    |---------|------------|---------|
    | Model | `messages.tts.providers.openai.model` | `gpt-4o-mini-tts` |
    | Voice | `messages.tts.providers.openai.voice` | `coral` |
    | Speed | `messages.tts.providers.openai.speed` | (unset) |
    | Instructions | `messages.tts.providers.openai.instructions` | (unset, `gpt-4o-mini-tts` only) |
    | Format | `messages.tts.providers.openai.responseFormat` | `opus` for voice notes, `mp3` for files |
    | API key | `messages.tts.providers.openai.apiKey` | Falls back to `OPENAI_API_KEY` |
    | Base URL | `messages.tts.providers.openai.baseUrl` | `https://api.openai.com/v1` |

    Available models: `gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`. Available voices: `alloy`, `ash`, `ballad`, `cedar`, `coral`, `echo`, `fable`, `juniper`, `marin`, `onyx`, `nova`, `sage`, `shimmer`, `verse`.

    ```json5
    {
      messages: {
        tts: {
          providers: {
            openai: { model: "gpt-4o-mini-tts", voice: "coral" },
          },
        },
      },
    }
    ```

    <Note>
    Set `OPENAI_TTS_BASE_URL` to override the TTS base URL without affecting the chat API endpoint.
    </Note>

  </Accordion>

  <Accordion title="Realtime transcription">
    The bundled `openai` plugin registers realtime transcription for the Voice Call plugin.

    | Setting | Config path | Default |
    |---------|------------|---------|
    | Model | `plugins.entries.voice-call.config.streaming.providers.openai.model` | `gpt-4o-transcribe` |
    | Silence duration | `...openai.silenceDurationMs` | `800` |
    | VAD threshold | `...openai.vadThreshold` | `0.5` |
    | API key | `...openai.apiKey` | Falls back to `OPENAI_API_KEY` |

    <Note>
    Uses a WebSocket connection to `wss://api.openai.com/v1/realtime` with G.711 u-law audio.
    </Note>

  </Accordion>

  <Accordion title="Realtime voice">
    The bundled `openai` plugin registers realtime voice for the Voice Call plugin.

    | Setting | Config path | Default |
    |---------|------------|---------|
    | Model | `plugins.entries.voice-call.config.realtime.providers.openai.model` | `gpt-realtime` |
    | Voice | `...openai.voice` | `alloy` |
    | Temperature | `...openai.temperature` | `0.8` |
    | VAD threshold | `...openai.vadThreshold` | `0.5` |
    | Silence duration | `...openai.silenceDurationMs` | `500` |
    | API key | `...openai.apiKey` | Falls back to `OPENAI_API_KEY` |

    <Note>
    Supports Azure OpenAI via `azureEndpoint` and `azureDeployment` config keys. Supports bidirectional tool calling. Uses G.711 u-law audio format.
    </Note>

  </Accordion>
</AccordionGroup>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Transport (WebSocket vs SSE)">
    OpenClaw uses WebSocket-first with SSE fallback (`"auto"`) for both `openai/*` and `openai-codex/*`.

    In `"auto"` mode, OpenClaw:
    - Retries one early WebSocket failure before falling back to SSE
    - After a failure, marks WebSocket as degraded for ~60 seconds and uses SSE during cool-down
    - Attaches stable session and turn identity headers for retries and reconnects
    - Normalizes usage counters (`input_tokens` / `prompt_tokens`) across transport variants

    | Value | Behavior |
    |-------|----------|
    | `"auto"` (default) | WebSocket first, SSE fallback |
    | `"sse"` | Force SSE only |
    | `"websocket"` | Force WebSocket only |

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.4": {
              params: { transport: "auto" },
            },
          },
        },
      },
    }
    ```

    Related OpenAI docs:
    - [Realtime API with WebSocket](https://platform.openai.com/docs/guides/realtime-websocket)
    - [Streaming API responses (SSE)](https://platform.openai.com/docs/guides/streaming-responses)

  </Accordion>

  <Accordion title="WebSocket warm-up">
    OpenClaw enables WebSocket warm-up by default for `openai/*` to reduce first-turn latency.

    ```json5
    // Disable warm-up
    {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": {
              params: { openaiWsWarmup: false },
            },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Fast mode">
    OpenClaw exposes a shared fast-mode toggle for both `openai/*` and `openai-codex/*`:

    - **Chat/UI:** `/fast status|on|off`
    - **Config:** `agents.defaults.models["<provider>/<model>"].params.fastMode`

    When enabled, OpenClaw maps fast mode to OpenAI priority processing (`service_tier = "priority"`). Existing `service_tier` values are preserved, and fast mode does not rewrite `reasoning` or `text.verbosity`.

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": { params: { fastMode: true } },
            "openai-codex/gpt-5.4": { params: { fastMode: true } },
          },
        },
      },
    }
    ```

    <Note>
    Session overrides win over config. Clearing the session override in the Sessions UI returns the session to the configured default.
    </Note>

  </Accordion>

  <Accordion title="Priority processing (service_tier)">
    OpenAI's API exposes priority processing via `service_tier`. Set it per model in OpenClaw:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": { params: { serviceTier: "priority" } },
            "openai-codex/gpt-5.4": { params: { serviceTier: "priority" } },
          },
        },
      },
    }
    ```

    Supported values: `auto`, `default`, `flex`, `priority`.

    <Warning>
    `serviceTier` is only forwarded to native OpenAI endpoints (`api.openai.com`) and native Codex endpoints (`chatgpt.com/backend-api`). If you route either provider through a proxy, OpenClaw leaves `service_tier` untouched.
    </Warning>

  </Accordion>

  <Accordion title="Server-side compaction (Responses API)">
    For direct OpenAI Responses models (`openai/*` on `api.openai.com`), OpenClaw auto-enables server-side compaction:

    - Forces `store: true` (unless model compat sets `supportsStore: false`)
    - Injects `context_management: [{ type: "compaction", compact_threshold: ... }]`
    - Default `compact_threshold`: 70% of `contextWindow` (or `80000` when unavailable)

    <Tabs>
      <Tab title="Enable explicitly">
        Useful for compatible endpoints like Azure OpenAI Responses:

        ```json5
        {
          agents: {
            defaults: {
              models: {
                "azure-openai-responses/gpt-5.4": {
                  params: { responsesServerCompaction: true },
                },
              },
            },
          },
        }
        ```
      </Tab>
      <Tab title="Custom threshold">
        ```json5
        {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.4": {
                  params: {
                    responsesServerCompaction: true,
                    responsesCompactThreshold: 120000,
                  },
                },
              },
            },
          },
        }
        ```
      </Tab>
      <Tab title="Disable">
        ```json5
        {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.4": {
                  params: { responsesServerCompaction: false },
                },
              },
            },
          },
        }
        ```
      </Tab>
    </Tabs>

    <Note>
    `responsesServerCompaction` only controls `context_management` injection. Direct OpenAI Responses models still force `store: true` unless compat sets `supportsStore: false`.
    </Note>

  </Accordion>

  <Accordion title="Strict-agentic GPT mode">
    For GPT-5-family runs on `openai/*` and `openai-codex/*`, OpenClaw can use a stricter embedded execution contract:

    ```json5
    {
      agents: {
        defaults: {
          embeddedPi: { executionContract: "strict-agentic" },
        },
      },
    }
    ```

    With `strict-agentic`, OpenClaw:
    - No longer treats a plan-only turn as successful progress when a tool action is available
    - Retries the turn with an act-now steer
    - Auto-enables `update_plan` for substantial work
    - Surfaces an explicit blocked state if the model keeps planning without acting

    <Note>
    Scoped to OpenAI and Codex GPT-5-family runs only. Other providers and older model families keep default behavior.
    </Note>

  </Accordion>

  <Accordion title="Native vs OpenAI-compatible routes">
    OpenClaw treats direct OpenAI, Codex, and Azure OpenAI endpoints differently from generic OpenAI-compatible `/v1` proxies:

    **Native routes** (`openai/*`, `openai-codex/*`, Azure OpenAI):
    - Keep `reasoning: { effort: "none" }` only for models that support the OpenAI `none` effort
    - Omit disabled reasoning for models or proxies that reject `reasoning.effort: "none"`
    - Default tool schemas to strict mode
    - Attach hidden attribution headers on verified native hosts only
    - Keep OpenAI-only request shaping (`service_tier`, `store`, reasoning-compat, prompt-cache hints)

    **Proxy/compatible routes:**
    - Use looser compat behavior
    - Do not force strict tool schemas or native-only headers

    Azure OpenAI uses native transport and compat behavior but does not receive the hidden attribution headers.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Image generation" href="/tools/image-generation" icon="image">
    Shared image tool parameters and provider selection.
  </Card>
  <Card title="Video generation" href="/tools/video-generation" icon="video">
    Shared video tool parameters and provider selection.
  </Card>
  <Card title="OAuth and auth" href="/gateway/authentication" icon="key">
    Auth details and credential reuse rules.
  </Card>
</CardGroup>
