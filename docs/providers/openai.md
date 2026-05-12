---
summary: "Use OpenAI via API keys or Codex subscription in OpenClaw"
read_when:
  - You want to use OpenAI models in OpenClaw
  - You want Codex subscription auth instead of API keys
  - You need stricter GPT-5 agent execution behavior
title: "OpenAI"
---

OpenAI provides developer APIs for GPT models, and Codex is also available as a
ChatGPT-plan coding agent through OpenAI's Codex clients. OpenClaw keeps those
surfaces separate so config stays predictable.

OpenClaw uses `openai/*` as the canonical OpenAI model route. Embedded agent
turns on OpenAI models run through the native Codex app-server runtime by
default; direct OpenAI API-key auth remains available for non-agent OpenAI
surfaces such as images, embeddings, speech, and realtime.

- **Agent models** - `openai/*` models through the Codex runtime; sign in with
  Codex auth for ChatGPT/Codex subscription use, or configure a Codex-compatible
  OpenAI API-key backup when you intentionally want API-key auth.
- **Non-agent OpenAI APIs** - direct OpenAI Platform access with usage-based
  billing through `OPENAI_API_KEY` or OpenAI API-key onboarding.
- **Legacy config** - `openai-codex/*` model refs are repaired by
  `openclaw doctor --fix` to `openai/*` plus the Codex runtime.

OpenAI explicitly supports subscription OAuth usage in external tools and workflows like OpenClaw.

Provider, model, runtime, and channel are separate layers. If those labels are
getting mixed together, read [Agent runtimes](/concepts/agent-runtimes) before
changing config.

## Quick choice

| Goal                                                 | Use                                                      | Notes                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| ChatGPT/Codex subscription with native Codex runtime | `openai/gpt-5.5`                                         | Default OpenAI agent setup. Sign in with Codex auth.                  |
| Direct API-key billing for agent models              | `openai/gpt-5.5` plus a Codex-compatible API-key profile | Use `auth.order.openai` to place the backup after subscription auth.  |
| Direct API-key billing through explicit PI           | `openai/gpt-5.5` plus provider/model runtime `pi`        | Select a normal `openai` API-key profile.                             |
| Latest ChatGPT Instant API alias                     | `openai/chat-latest`                                     | Direct API-key only. Moving alias for experiments, not the default.   |
| ChatGPT/Codex subscription auth through explicit PI  | `openai/gpt-5.5` plus provider/model runtime `pi`        | Select an `openai-codex` auth profile for the compatibility route.    |
| Image generation or editing                          | `openai/gpt-image-2`                                     | Works with either `OPENAI_API_KEY` or OpenAI Codex OAuth.             |
| Transparent-background images                        | `openai/gpt-image-1.5`                                   | Use `outputFormat=png` or `webp` and `openai.background=transparent`. |

## Naming map

The names are similar but not interchangeable:

| Name you see                            | Layer                      | Meaning                                                                                                              |
| --------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `openai`                                | Provider prefix            | Canonical OpenAI model route; agent turns use the Codex runtime.                                                     |
| `openai-codex`                          | Legacy auth/profile prefix | Older OpenAI Codex OAuth/subscription profile namespace. Existing profiles and `auth.order.openai-codex` still work. |
| `codex` plugin                          | Plugin                     | Bundled OpenClaw plugin that provides native Codex app-server runtime and `/codex` chat controls.                    |
| provider/model `agentRuntime.id: codex` | Agent runtime              | Force the native Codex app-server harness for matching embedded turns.                                               |
| `/codex ...`                            | Chat command set           | Bind/control Codex app-server threads from a conversation.                                                           |
| `runtime: "acp", agentId: "codex"`      | ACP session route          | Explicit fallback path that runs Codex through ACP/acpx.                                                             |

This means a config can intentionally contain `openai/*` model refs while auth
profiles still point at Codex-compatible credentials. Prefer `auth.order.openai`
for new config; existing `openai-codex:*` profiles and `auth.order.openai-codex`
remain supported. `openclaw doctor --fix` rewrites legacy `openai-codex/*` model
refs to the canonical OpenAI model route.

<Note>
GPT-5.5 is available through both direct OpenAI Platform API-key access and
subscription/OAuth routes. For ChatGPT/Codex subscription plus native Codex
execution, use `openai/gpt-5.5`; unset runtime config now selects the Codex
harness for OpenAI agent turns. Use OpenAI API-key profiles only when you want
direct API-key auth for an OpenAI agent model.
</Note>

<Note>
OpenAI agent model turns require the bundled Codex app-server plugin. Explicit
PI runtime config remains available as an opt-in compatibility route. When PI is
explicitly selected with an `openai-codex` auth profile, OpenClaw keeps the
public model ref as `openai/*` and routes PI internally through the legacy
Codex-auth transport. Run `openclaw doctor --fix` to repair stale
`openai-codex/*` model refs or old PI session pins that do not come from
explicit runtime config.
</Note>

## OpenClaw feature coverage

| OpenAI capability         | OpenClaw surface                                                                 | Status                                                 |
| ------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Chat / Responses          | `openai/<model>` model provider                                                  | Yes                                                    |
| Codex subscription models | `openai/<model>` with `openai-codex` OAuth                                       | Yes                                                    |
| Legacy Codex model refs   | `openai-codex/<model>`                                                           | Repaired by doctor to `openai/<model>`                 |
| Codex app-server harness  | `openai/<model>` with omitted runtime or provider/model `agentRuntime.id: codex` | Yes                                                    |
| Server-side web search    | Native OpenAI Responses tool                                                     | Yes, when web search is enabled and no provider pinned |
| Images                    | `image_generate`                                                                 | Yes                                                    |
| Videos                    | `video_generate`                                                                 | Yes                                                    |
| Text-to-speech            | `messages.tts.provider: "openai"` / `tts`                                        | Yes                                                    |
| Batch speech-to-text      | `tools.media.audio` / media understanding                                        | Yes                                                    |
| Streaming speech-to-text  | Voice Call `streaming.provider: "openai"`                                        | Yes                                                    |
| Realtime voice            | Voice Call `realtime.provider: "openai"` / Control UI Talk                       | Yes                                                    |
| Embeddings                | memory embedding provider                                                        | Yes                                                    |

## Memory embeddings

OpenClaw can use OpenAI, or an OpenAI-compatible embedding endpoint, for
`memory_search` indexing and query embeddings:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "openai",
        model: "text-embedding-3-small",
      },
    },
  },
}
```

For OpenAI-compatible endpoints that require asymmetric embedding labels, set
`queryInputType` and `documentInputType` under `memorySearch`. OpenClaw forwards
those as provider-specific `input_type` request fields: query embeddings use
`queryInputType`; indexed memory chunks and batch indexing use
`documentInputType`. See the [Memory configuration reference](/reference/memory-config#provider-specific-config) for the full example.

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

    | Model ref              | Runtime config             | Route                       | Auth             |
    | ---------------------- | -------------------------- | --------------------------- | ---------------- |
    | `openai/gpt-5.5`      | omitted / provider/model `agentRuntime.id: "codex"` | Codex app-server harness | Codex-compatible OpenAI profile |
    | `openai/gpt-5.4-mini` | omitted / provider/model `agentRuntime.id: "codex"` | Codex app-server harness | Codex-compatible OpenAI profile |
    | `openai/gpt-5.5`      | provider/model `agentRuntime.id: "pi"`              | PI embedded runtime      | `openai` profile or selected `openai-codex` profile |

    <Note>
    `openai/*` agent models use the Codex app-server harness. To use API-key
    auth for an agent model, create a Codex-compatible API-key profile and order
    it with `auth.order.openai`; `OPENAI_API_KEY` remains the direct fallback for
    non-agent OpenAI API surfaces. Older `auth.order.openai-codex` entries still
    work.
    </Note>

    ### Config example

    ```json5
    {
      env: { OPENAI_API_KEY: "sk-..." },
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    }
    ```

    To try ChatGPT's current Instant model from the OpenAI API, set the model
    to `openai/chat-latest`:

    ```json5
    {
      env: { OPENAI_API_KEY: "sk-..." },
      agents: { defaults: { model: { primary: "openai/chat-latest" } } },
    }
    ```

    `chat-latest` is a moving alias. OpenAI documents it as the latest Instant
    model used in ChatGPT and recommends `gpt-5.5` for production API usage, so
    keep `openai/gpt-5.5` as the stable default unless you explicitly want that
    alias behavior. The alias currently accepts only `medium` text verbosity, so
    OpenClaw normalizes incompatible OpenAI text-verbosity overrides for this
    model.

    <Warning>
    OpenClaw does **not** expose `openai/gpt-5.3-codex-spark`. Live OpenAI API requests reject that model, and the current Codex catalog does not expose it either.
    </Warning>

  </Tab>

  <Tab title="Codex subscription">
    **Best for:** using your ChatGPT/Codex subscription with native Codex app-server execution instead of a separate API key. Codex cloud requires ChatGPT sign-in.

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
      <Step title="Use the canonical OpenAI model route">
        ```bash
        openclaw config set agents.defaults.model.primary openai/gpt-5.5
        ```

        No runtime config is required for the default path. OpenAI agent turns
        select the native Codex app-server runtime automatically, and OpenClaw
        installs or repairs the bundled Codex plugin when this route is chosen.
      </Step>
      <Step title="Verify Codex auth is available">
        ```bash
        openclaw models list --provider openai-codex
        ```

        After the gateway is running, send `/codex status` or `/codex models`
        in chat to verify the native app-server runtime.
      </Step>
    </Steps>

    ### Route summary

    | Model ref | Runtime config | Route | Auth |
    |-----------|----------------|-------|------|
    | `openai/gpt-5.5` | omitted / provider/model `agentRuntime.id: "codex"` | Native Codex app-server harness | Codex sign-in or ordered `openai` auth profile |
    | `openai/gpt-5.5` | provider/model `agentRuntime.id: "pi"` | PI embedded runtime with internal Codex-auth transport | Selected `openai-codex` profile |
    | `openai-codex/gpt-5.5` | repaired by doctor | Legacy route rewritten to `openai/gpt-5.5` | Existing `openai-codex` profile |

    <Warning>
    Do not configure older `openai-codex/gpt-5.1*`, `openai-codex/gpt-5.2*`, or
    `openai-codex/gpt-5.3*` model refs. ChatGPT/Codex OAuth accounts now reject
    those models. Use `openai/gpt-5.5`; OpenAI agent turns now select the Codex
    runtime by default.
    </Warning>

    <Note>
    The `openai-codex/*` model prefix is legacy config repaired by doctor. For
    the common subscription plus native runtime setup, sign in with Codex auth
    but keep the model ref as `openai/gpt-5.5`. New config should put OpenAI
    agent auth order under `auth.order.openai`; older `auth.order.openai-codex`
    entries remain valid.
    </Note>

    ### Config example

    ```json5
    {
      plugins: { entries: { codex: { enabled: true } } },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
        },
      },
    }
    ```

    With an API-key backup, keep the model on `openai/gpt-5.5` and put the
    auth order under `openai`. OpenClaw will try the subscription first, then
    the API key, while staying on the Codex harness:

    ```json5
    {
      plugins: { entries: { codex: { enabled: true } } },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
        },
      },
      auth: {
        order: {
          openai: [
            "openai-codex:user@example.com",
            "openai:api-key-backup",
          ],
        },
      },
    }
    ```

    <Note>
    Onboarding no longer imports OAuth material from `~/.codex`. Sign in with browser OAuth (default) or the device-code flow above — OpenClaw manages the resulting credentials in its own agent auth store.
    </Note>

    ### Check and recover Codex OAuth routing

    Use these commands to see which model, runtime, and auth route your default
    agent is using:

    ```bash
    openclaw models status
    openclaw models auth list --provider openai-codex
    openclaw config get agents.defaults.model --json
    openclaw config get models.providers.openai.agentRuntime --json
    ```

    For a specific agent, add `--agent <id>`:

    ```bash
    openclaw models status --agent <id>
    openclaw models auth list --agent <id> --provider openai-codex
    ```

    If an older config still has `openai-codex/gpt-*` or a stale OpenAI PI
    session pin without explicit runtime config, repair it:

    ```bash
    openclaw doctor --fix
    openclaw config validate
    ```

    If `models auth list --provider openai-codex` shows no usable profile, sign
    in again:

    ```bash
    openclaw models auth login --provider openai-codex
    openclaw models status --probe --probe-provider openai-codex
    ```

    `openai/*` is the model route for OpenAI agent turns through Codex. The
    `openai-codex` auth/profile provider id remains accepted for existing
    profiles and CLI listing.

    ### Status indicator

    Chat `/status` shows which model runtime is active for the current session.
    The bundled Codex app-server harness appears as `Runtime: OpenAI Codex` for
    OpenAI agent model turns. Stale PI session pins are repaired to Codex unless
    config explicitly pins PI.

    ### Doctor warning

    If `openai-codex/*` routes or stale OpenAI PI pins remain in config or
    session state, `openclaw doctor --fix` rewrites them to `openai/*` with the
    Codex runtime unless PI is explicitly configured.

    ### Context window cap

    OpenClaw treats model metadata and the runtime context cap as separate values.

    For `openai/gpt-5.5` through the Codex OAuth catalog:

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

    ### Catalog recovery

    OpenClaw uses upstream Codex catalog metadata for `gpt-5.5` when it is
    present. If live Codex discovery omits the `gpt-5.5` row while
    the account is authenticated, OpenClaw synthesizes that OAuth model row so
    cron, sub-agent, and configured default-model runs do not fail with
    `Unknown model`.

  </Tab>
</Tabs>

## Native Codex app-server auth

The native Codex app-server harness uses `openai/*` model refs plus omitted
runtime config or provider/model `agentRuntime.id: "codex"`, but its auth is
still account-based. OpenClaw selects auth in this order:

1. Ordered OpenAI auth profiles for the agent, preferably under
   `auth.order.openai`. Existing `openai-codex:*` profiles and
   `auth.order.openai-codex` remain valid for older installs.
2. The app-server's existing account, such as a local Codex CLI ChatGPT sign-in.
3. For local stdio app-server launches only, `CODEX_API_KEY`, then
   `OPENAI_API_KEY`, when the app-server reports no account and still requires
   OpenAI auth.

That means a local ChatGPT/Codex subscription sign-in is not replaced just
because the gateway process also has `OPENAI_API_KEY` for direct OpenAI models
or embeddings. Env API-key fallback is only the local stdio no-account path; it
is not sent to WebSocket app-server connections. When a subscription-style Codex
profile is selected, OpenClaw also keeps `CODEX_API_KEY` and `OPENAI_API_KEY`
out of the spawned stdio app-server child and sends the selected credentials
through the app-server login RPC. When that subscription profile is blocked by a
Codex usage limit, OpenClaw can rotate to the next ordered `openai:*` API-key
profile without changing the selected model or dropping out of the Codex
harness. Once the subscription reset time passes, the subscription profile is
eligible again.

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
editing. `gpt-image-1.5`, `gpt-image-1`, and `gpt-image-1-mini` remain usable as
explicit model overrides. Use `openai/gpt-image-1.5` for transparent-background
PNG/WebP output; the current `gpt-image-2` API rejects
`background: "transparent"`.

For a transparent-background request, agents should call `image_generate` with
`model: "openai/gpt-image-1.5"`, `outputFormat: "png"` or `"webp"`, and
`background: "transparent"`; the older `openai.background` provider option is
still accepted. OpenClaw also protects the public OpenAI and
OpenAI Codex OAuth routes by rewriting default `openai/gpt-image-2` transparent
requests to `gpt-image-1.5`; Azure and custom OpenAI-compatible endpoints keep
their configured deployment/model names.

The same setting is exposed for headless CLI runs:

```bash
openclaw infer image generate \
  --model openai/gpt-image-1.5 \
  --output-format png \
  --background transparent \
  --prompt "A simple red circle sticker on a transparent background" \
  --json
```

Use the same `--output-format` and `--background` flags with
`openclaw infer image edit` when starting from an input file.
`--openai-background` remains available as an OpenAI-specific alias.

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

Generate a transparent PNG:

```
/tool image_generate model=openai/gpt-image-1.5 prompt="A simple red circle sticker on a transparent background" outputFormat=png background=transparent
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

OpenClaw adds a shared GPT-5 prompt contribution for GPT-5-family runs across providers. It applies by model id, so `openai/gpt-5.5`, legacy pre-repair refs such as `openai-codex/gpt-5.5`, `openrouter/openai/gpt-5.5`, `opencode/gpt-5.5`, and other compatible GPT-5 refs receive the same overlay. Older GPT-4.x models do not.

The bundled native Codex harness uses the same GPT-5 behavior and heartbeat overlay through Codex app-server developer instructions, so `openai/gpt-5.x` sessions routed through Codex keep the same follow-through and proactive heartbeat guidance even though Codex owns the rest of the harness prompt.

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
    | Extra body | `messages.tts.providers.openai.extraBody` / `extra_body` | (unset) |

    Available models: `gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`. Available voices: `alloy`, `ash`, `ballad`, `cedar`, `coral`, `echo`, `fable`, `juniper`, `marin`, `onyx`, `nova`, `sage`, `shimmer`, `verse`.

    `extraBody` is merged into `/audio/speech` request JSON after OpenClaw's generated fields, so use it for OpenAI-compatible endpoints that require additional keys such as `lang`. Prototype keys are ignored.

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
    Set `OPENAI_TTS_BASE_URL` to override the TTS base URL without affecting the chat API endpoint. OpenAI TTS is still configured through an API key; for OAuth-only live talk-back, use the Realtime voice path instead of agent-mode STT -> TTS speech.
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
    | Auth | `...openai.apiKey`, `OPENAI_API_KEY`, or `openai-codex` OAuth | API keys connect directly; OAuth mints a Realtime transcription client secret |

    <Note>
    Uses a WebSocket connection to `wss://api.openai.com/v1/realtime` with G.711 u-law (`g711_ulaw` / `audio/pcmu`) audio. When only `openai-codex` OAuth is configured, the Gateway mints an ephemeral Realtime transcription client secret before opening the WebSocket. This streaming provider is for Voice Call's realtime transcription path; Discord voice currently records short segments and uses the batch `tools.media.audio` transcription path instead.
    </Note>

  </Accordion>

  <Accordion title="Realtime voice">
    The bundled `openai` plugin registers realtime voice for the Voice Call plugin.

    | Setting | Config path | Default |
    |---------|------------|---------|
    | Model | `plugins.entries.voice-call.config.realtime.providers.openai.model` | `gpt-realtime-2` |
    | Voice | `...openai.voice` | `alloy` |
    | Temperature (Azure deployment bridge) | `...openai.temperature` | `0.8` |
    | VAD threshold | `...openai.vadThreshold` | `0.5` |
    | Silence duration | `...openai.silenceDurationMs` | `500` |
    | Prefix padding | `...openai.prefixPaddingMs` | `300` |
    | Reasoning effort | `...openai.reasoningEffort` | (unset) |
    | Auth | `...openai.apiKey`, `OPENAI_API_KEY`, or `openai-codex` OAuth | Browser Talk and non-Azure backend bridges can use Codex OAuth |

    Available built-in Realtime voices for `gpt-realtime-2`: `alloy`, `ash`,
    `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar`.
    OpenAI recommends `marin` and `cedar` for the best Realtime quality. This
    is a separate set from the Text-to-speech voices above; do not assume a TTS
    voice such as `fable`, `nova`, or `onyx` is valid for Realtime sessions.

    <Note>
    Backend OpenAI realtime bridges use the GA Realtime WebSocket session shape, which does not accept `session.temperature`. Azure OpenAI deployments remain available via `azureEndpoint` and `azureDeployment` and keep the deployment-compatible session shape. Supports bidirectional tool calling and G.711 u-law audio.
    </Note>

    <Note>
    Realtime voice is selected when the session is created. OpenAI allows most
    session fields to change later, but the voice cannot be changed after the
    model has emitted audio in that session. OpenClaw currently exposes the
    built-in Realtime voice ids as strings.
    </Note>

    <Note>
    Control UI Talk uses OpenAI browser realtime sessions with a Gateway-minted
    ephemeral client secret and a direct browser WebRTC SDP exchange against the
    OpenAI Realtime API. When no direct OpenAI API key is configured, the
    Gateway can mint that client secret with the selected `openai-codex` OAuth
    profile. Gateway relay and Voice Call backend realtime WebSocket bridges use
    the same OAuth fallback for native OpenAI endpoints. Maintainer live
    verification is available with
    `OPENAI_API_KEY=... GEMINI_API_KEY=... node --import tsx scripts/dev/realtime-talk-live-smoke.ts`;
    the OpenAI legs verify both the backend WebSocket bridge and the browser
    WebRTC SDP exchange without logging secrets.
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
- Uses a 600s default request timeout for Azure image-generation calls.
  Per-call `timeoutMs` values still override this default.

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
    OpenClaw uses WebSocket-first with SSE fallback (`"auto"`) for `openai/*`.

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
            "openai/gpt-5.5": {
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

  <Accordion title="Fast mode">
    OpenClaw exposes a shared fast-mode toggle for `openai/*`:

    - **Chat/UI:** `/fast status|on|off`
    - **Config:** `agents.defaults.models["<provider>/<model>"].params.fastMode`

    When enabled, OpenClaw maps fast mode to OpenAI priority processing (`service_tier = "priority"`). Existing `service_tier` values are preserved, and fast mode does not rewrite `reasoning` or `text.verbosity`.

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { params: { fastMode: true } },
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
            "openai/gpt-5.5": { params: { serviceTier: "priority" } },
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

    This applies to the built-in Pi harness path and to OpenAI provider hooks used by embedded runs. The native Codex app-server harness manages its own context through Codex and is configured by OpenAI's default agent route or provider/model runtime policy.

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
                "openai/gpt-5.5": {
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
                "openai/gpt-5.5": {
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
    - Strip Completions `store` from non-native `openai-completions` payloads
    - Accept advanced `params.extra_body`/`params.extraBody` pass-through JSON for OpenAI-compatible Completions proxies
    - Accept `params.chat_template_kwargs` for OpenAI-compatible Completions proxies such as vLLM
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
