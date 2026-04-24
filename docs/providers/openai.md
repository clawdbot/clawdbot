---
summary: "Use OpenAI via API keys or Codex subscription in OpenClaw"
read_when:
  - You want to use OpenAI models in OpenClaw
  - You want Codex subscription auth instead of API keys
  - You need stricter GPT-5 agent execution behavior
title: "OpenAI"
---

OpenAI provides developer APIs for GPT models. OpenClaw supports three OpenAI-family routes. The model prefix selects the route:

- **API key** — direct OpenAI Platform access with usage-based billing (`openai/*` models)
- **Codex subscription through PI** — ChatGPT/Codex sign-in with subscription access (`openai-codex/*` models)
- **Codex app-server harness** — native Codex app-server execution (`openai/*` models plus `agents.defaults.embeddedHarness.runtime: "codex"`)

OpenAI explicitly supports subscription OAuth usage in external tools and workflows like OpenClaw.

<Note>
GPT-5.5 is currently available in OpenClaw through subscription/OAuth routes:
`openai-codex/gpt-5.5` with the PI runner, or `openai/gpt-5.5` with the
Codex app-server harness. Direct API-key access for `openai/gpt-5.5` is
supported once OpenAI enables GPT-5.5 on the public API; until then use an
API-enabled model such as `openai/gpt-5.4` for `OPENAI_API_KEY` setups.
</Note>

<Note>
Enabling the OpenAI plugin, or selecting an `openai-codex/*` model, does not
enable the bundled Codex app-server plugin. OpenClaw enables that plugin only
when you explicitly select the native Codex harness with
`embeddedHarness.runtime: "codex"` or use a legacy `codex/*` model ref.
</Note>

## OpenClaw feature coverage

| OpenAI capability         | OpenClaw surface                                           | Status                                                 |
| ------------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| Chat / Responses          | `openai/<model>` model provider                            | Yes                                                    |
| Codex subscription models | `openai-codex/<model>` with `openai-codex` OAuth           | Yes                                                    |
| Codex app-server harness  | `openai/<model>` with `embeddedHarness.runtime: codex`     | Yes                                                    |
| Server-side web search    | Native OpenAI Responses tool                               | Yes, when web search is enabled and no provider pinned |
| Images                    | `image_generate`                                           | Yes                                                    |
| Videos                    | `video_generate`                                           | Yes                                                    |
| Text-to-speech            | `messages.tts.provider: "openai"` / `tts`                  | Yes                                                    |
| Batch speech-to-text      | `tools.media.audio` / media understanding                  | Yes                                                    |
| Streaming speech-to-text  | Voice Call `streaming.provider: "openai"`                  | Yes                                                    |
| Realtime voice            | Voice Call `realtime.provider: "openai"` / Control UI Talk | Yes                                                    |
| Embeddings                | memory embedding provider                                  | Yes                                                    |

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
    | `openai/gpt-5.4-mini` | Direct OpenAI Platform API | `OPENAI_API_KEY` |
    | `openai/gpt-5.5` | Future direct API route once OpenAI enables GPT-5.5 on the API | `OPENAI_API_KEY` |

    <Note>
    `openai/*` is the direct OpenAI API-key route unless you explicitly force
    the Codex app-server harness. GPT-5.5 itself is currently subscription/OAuth
    only; use `openai-codex/*` for Codex OAuth through the default PI runner.
    </Note>

    ### Config example

    ```json5
    {
      env: { OPENAI_API_KEY: "sk-..." },
      agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
    }
    ```

    <Warning>
    OpenClaw does **not** expose `openai/gpt-5.3-codex-spark`. Live OpenAI API requests reject that model, and the current Codex catalog does not expose it either.
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

        For headless or callback-hostile setups, add `--device-code` to sign in with a ChatGPT device-code flow instead of the localhost browser callback:

        ```bash
        openclaw models auth login --provider openai-codex --device-code
        ```
      </Step>
      <Step title="Set the default model">
        ```bash
        openclaw config set agents.defaults.model.primary openai-codex/gpt-5.5
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
    | `openai-codex/gpt-5.5` | ChatGPT/Codex OAuth through PI | Codex sign-in |
    | `openai/gpt-5.5` + `embeddedHarness.runtime: "codex"` | Codex app-server harness | Codex app-server auth |

    <Note>
    Keep using the `openai-codex` provider id for auth/profile commands. The
    `openai-codex/*` model prefix is also the explicit PI route for Codex OAuth.
    It does not select or auto-enable the bundled Codex app-server harness.
    </Note>

    ### Config example

    ```json5
    {
      agents: { defaults: { model: { primary: "openai-codex/gpt-5.5" } } },
    }
    ```

    <Note>
    Onboarding no longer imports OAuth material from `~/.codex`. Sign in with browser OAuth (default) or the device-code flow above — OpenClaw manages the resulting credentials in its own agent auth store.
    </Note>

    ### Status indicator

    Chat `/status` shows which embedded harness is active for the current
    session. The default PI harness appears as `Runner: pi (embedded)` and does
    not add a separate badge. When the bundled Codex app-server harness is
    selected, `/status` appends the non-PI harness id next to `Fast`, for example
    `Fast · codex`. Existing sessions keep their recorded harness id, so use
    `/new` or `/reset` after changing `embeddedHarness` if you want `/status` to
    reflect a new PI/Codex choice.

    ### Context window cap

    OpenClaw treats model metadata and the runtime context cap as separate values.

    For `openai-codex/gpt-5.5` through Codex OAuth:

    - Native `contextWindow`: `1000000`
    - Default runtime `contextTokens` cap: `272000`

    The smaller default cap has better latency and quality characteristics in practice. Override it with `contextTokens`:

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

    <Note>
    Use `contextWindow` to declare native model metadata. Use `contextTokens` to limit the runtime context budget.
    </Note>

  </Tab>
</Tabs>

## Image generation

The bundled `openai` plugin registers image generation through the `image_generate` tool.
It supports both OpenAI API-key image generation and Codex OAuth image
generation through the same `openai/gpt-image-2` model ref.

| Capability                | OpenAI API key                     | Codex OAuth                          |
| ------------------------- | ---------------------------------- | ------------------------------------ |
| Model ref                 | `openai/gpt-image-2`               | `openai/gpt-image-2`                 |
| Auth                      | `OPENAI_API_KEY`                   | OpenAI Codex OAuth sign-in           |
| Transport                 | OpenAI Images API                  | Codex Responses backend              |
| Max images per request    | 4                                  | 4                                    |
| Edit mode                 | Enabled (up to 5 reference images) | Enabled (up to 5 reference images)   |
| Size overrides            | Supported, including 2K/4K sizes   | Supported, including 2K/4K sizes     |
| Aspect ratio / resolution | Not forwarded to OpenAI Images API | Mapped to a supported size when safe |

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: { primary: "openai/gpt-image-2" },
    },
  },
}
```

<Note>
See [Image Generation](/tools/image-generation) for shared tool parameters, provider selection, and failover behavior.
</Note>

`gpt-image-2` is the default for both OpenAI text-to-image generation and image
editing. `gpt-image-1` remains usable as an explicit model override, but new
OpenAI image workflows should use `openai/gpt-image-2`.

For Codex OAuth installs, keep the same `openai/gpt-image-2` ref. When an
`openai-codex` OAuth profile is configured, OpenClaw resolves that stored OAuth
access token and sends image requests through the Codex Responses backend. It
does not first try `OPENAI_API_KEY` or silently fall back to an API key for that
request. Configure `models.providers.openai` explicitly with an API key,
custom base URL, or Azure endpoint when you want the direct OpenAI Images API
route instead.
If that custom image endpoint is on a trusted LAN/private address, also set
`browser.ssrfPolicy.dangerouslyAllowPrivateNetwork: true`; OpenClaw keeps
private/internal OpenAI-compatible image endpoints blocked unless this opt-in is
present.

Generate:

```
/tool image_generate model=openai/gpt-image-2 prompt="A polished launch poster for OpenClaw on macOS" size=3840x2160 count=1
```

Edit:

```
/tool image_generate model=openai/gpt-image-2 prompt="Preserve the object shape, change the material to translucent glass" image=/path/to/reference.png size=1024x1536
```

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

OpenClaw adds a shared GPT-5 prompt contribution for GPT-5-family runs across providers. It applies by model id, so `openai-codex/gpt-5.5`, `openai/gpt-5.4`, `openrouter/openai/gpt-5.5`, `opencode/gpt-5.5`, and other compatible GPT-5 refs receive the same overlay. Older GPT-4.x models do not.

The bundled native Codex harness uses the same GPT-5 behavior and heartbeat overlay through Codex app-server developer instructions, so `openai/gpt-5.x` sessions forced through `embeddedHarness.runtime: "codex"` keep the same follow-through and proactive heartbeat guidance even though Codex owns the rest of the harness prompt.

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
      agents: {
        defaults: {
          promptOverlays: {
            gpt5: { personality: "friendly" },
          },
        },
      },
    }
    ```
  </Tab>
  <Tab title="CLI">
    ```bash
    openclaw config set agents.defaults.promptOverlays.gpt5.personality off
    ```
  </Tab>
</Tabs>

<Tip>
Values are case-insensitive at runtime, so `"Off"` and `"off"` both disable the friendly style layer.
</Tip>

<Note>
Legacy `plugins.entries.openai.config.personality` is still read as a compatibility fallback when the shared `agents.defaults.promptOverlays.gpt5.personality` setting is not set.
</Note>

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

  <Accordion title="Speech-to-text">
    The bundled `openai` plugin registers batch speech-to-text through
    OpenClaw's media-understanding transcription surface.

    - Default model: `gpt-4o-transcribe`
    - Endpoint: OpenAI REST `/v1/audio/transcriptions`
    - Input path: multipart audio file upload
    - Supported by OpenClaw wherever inbound audio transcription uses
      `tools.media.audio`, including Discord voice-channel segments and channel
      audio attachments

    To force OpenAI for inbound audio transcription:

    ```json5
    {
      tools: {
        media: {
          audio: {
            models: [
              {
                type: "provider",
                provider: "openai",
                model: "gpt-4o-transcribe",
              },
            ],
          },
        },
      },
    }
    ```

    Language and prompt hints are forwarded to OpenAI when supplied by the
    shared audio media config or per-call transcription request.

  </Accordion>

  <Accordion title="Realtime transcription">
    The bundled `openai` plugin registers realtime transcription for the Voice Call plugin.

    | Setting | Config path | Default |
    |---------|------------|---------|
    | Model | `plugins.entries.voice-call.config.streaming.providers.openai.model` | `gpt-4o-transcribe` |
    | Language | `...openai.language` | (unset) |
    | Prompt | `...openai.prompt` | (unset) |
    | Silence duration | `...openai.silenceDurationMs` | `800` |
    | VAD threshold | `...openai.vadThreshold` | `0.5` |
    | API key | `...openai.apiKey` | Falls back to `OPENAI_API_KEY` |

    <Note>
    Uses a WebSocket connection to `wss://api.openai.com/v1/realtime` with G.711 u-law (`g711_ulaw` / `audio/pcmu`) audio. This streaming provider is for Voice Call's realtime transcription path; Discord voice currently records short segments and uses the batch `tools.media.audio` transcription path instead.
    </Note>

  </Accordion>

  <Accordion title="Realtime voice">
    The bundled `openai` plugin registers realtime voice for the Voice Call plugin.

    | Setting | Config path | Default |
    |---------|------------|---------|
    | Model | `plugins.entries.voice-call.config.realtime.providers.openai.model` | `gpt-realtime-1.5` |
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

## Azure OpenAI endpoints

The bundled `openai` provider can target an Azure OpenAI resource for image
generation by overriding the base URL. On the image-generation path, OpenClaw
detects Azure hostnames on `models.providers.openai.baseUrl` and switches to
Azure's request shape automatically.

<Note>
Realtime voice uses a separate configuration path
(`plugins.entries.voice-call.config.realtime.providers.openai.azureEndpoint`)
and is not affected by `models.providers.openai.baseUrl`. See the **Realtime
voice** accordion under [Voice and speech](#voice-and-speech) for its Azure
settings.
</Note>

Use Azure OpenAI when:

- You already have an Azure OpenAI subscription, quota, or enterprise agreement
- You need regional data residency or compliance controls Azure provides
- You want to keep traffic inside an existing Azure tenancy

### Configuration

For Azure image generation through the bundled `openai` provider, point
`models.providers.openai.baseUrl` at your Azure resource and set `apiKey` to
the Azure OpenAI key (not an OpenAI Platform key):

```json5
{
  models: {
    providers: {
      openai: {
        baseUrl: "https://<your-resource>.openai.azure.com",
        apiKey: "<azure-openai-api-key>",
      },
    },
  },
}
```

OpenClaw recognizes these Azure host suffixes for the Azure image-generation
route:

- `*.openai.azure.com`
- `*.services.ai.azure.com`
- `*.cognitiveservices.azure.com`

For image-generation requests on a recognized Azure host, OpenClaw:

- Sends the `api-key` header instead of `Authorization: Bearer`
- Uses deployment-scoped paths (`/openai/deployments/{deployment}/...`)
- Appends `?api-version=...` to each request

Other base URLs (public OpenAI, OpenAI-compatible proxies) keep the standard
OpenAI image request shape.

<Note>
Azure routing for the `openai` provider's image-generation path requires
OpenClaw 2026.4.22 or later. Earlier versions treat any custom
`openai.baseUrl` like the public OpenAI endpoint and will fail against Azure
image deployments.
</Note>

### API version

Set `AZURE_OPENAI_API_VERSION` to pin a specific Azure preview or GA version
for the Azure image-generation path:

```bash
export AZURE_OPENAI_API_VERSION="2024-12-01-preview"
```

The default is `2024-12-01-preview` when the variable is unset.

### Model names are deployment names

Azure OpenAI binds models to deployments. For Azure image-generation requests
routed through the bundled `openai` provider, the `model` field in OpenClaw
must be the **Azure deployment name** you configured in the Azure portal, not
the public OpenAI model id.

If you create a deployment called `gpt-image-2-prod` that serves `gpt-image-2`:

```
/tool image_generate model=openai/gpt-image-2-prod prompt="A clean poster" size=1024x1024 count=1
```

The same deployment-name rule applies to image-generation calls routed through
the bundled `openai` provider.

### Regional availability

Azure image generation is currently available only in a subset of regions
(for example `eastus2`, `swedencentral`, `polandcentral`, `westus3`,
`uaenorth`). Check Microsoft's current region list before creating a
deployment, and confirm the specific model is offered in your region.

### Parameter differences

Azure OpenAI and public OpenAI do not always accept the same image parameters.
Azure may reject options that public OpenAI allows (for example certain
`background` values on `gpt-image-2`) or expose them only on specific model
versions. These differences come from Azure and the underlying model, not
OpenClaw. If an Azure request fails with a validation error, check the
parameter set supported by your specific deployment and API version in the
Azure portal.

<Note>
Azure OpenAI uses native transport and compat behavior but does not receive
OpenClaw's hidden attribution headers — see the **Native vs OpenAI-compatible
routes** accordion under [Advanced configuration](#advanced-configuration).

For chat or Responses traffic on Azure (beyond image generation), use the
onboarding flow or a dedicated Azure provider config — `openai.baseUrl` alone
does not pick up the Azure API/auth shape. A separate
`azure-openai-responses/*` provider exists; see
the Server-side compaction accordion below.
</Note>

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
            "openai/gpt-5.4": {
              params: { transport: "auto" },
            },
            "openai-codex/gpt-5.5": {
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
    OpenClaw enables WebSocket warm-up by default for `openai/*` and `openai-codex/*` to reduce first-turn latency.

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
    OpenClaw exposes a shared fast-mode toggle for `openai/*` and `openai-codex/*`:

    - **Chat/UI:** `/fast status|on|off`
    - **Config:** `agents.defaults.models["<provider>/<model>"].params.fastMode`

    When enabled, OpenClaw maps fast mode to OpenAI priority processing (`service_tier = "priority"`). Existing `service_tier` values are preserved, and fast mode does not rewrite `reasoning` or `text.verbosity`.

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": { params: { fastMode: true } },
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
    For direct OpenAI Responses models (`openai/*` on `api.openai.com`), the OpenAI plugin's Pi-harness stream wrapper auto-enables server-side compaction:

    - Forces `store: true` (unless model compat sets `supportsStore: false`)
    - Injects `context_management: [{ type: "compaction", compact_threshold: ... }]`
    - Default `compact_threshold`: 70% of `contextWindow` (or `80000` when unavailable)

    This applies to the built-in Pi harness path and to OpenAI provider hooks used by embedded runs. The native Codex app-server harness manages its own context through Codex and is configured separately with `agents.defaults.embeddedHarness.runtime`.

    <Tabs>
      <Tab title="Enable explicitly">
        Useful for compatible endpoints like Azure OpenAI Responses:

        ```json5
        {
          agents: {
            defaults: {
              models: {
                "azure-openai-responses/gpt-5.5": {
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
    For GPT-5-family runs on `openai/*`, OpenClaw can use a stricter embedded execution contract:

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

    **Native routes** (`openai/*`, Azure OpenAI):
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
