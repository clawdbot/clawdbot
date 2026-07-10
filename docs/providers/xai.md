---
summary: "Use xAI Grok models in OpenClaw"
read_when:
  - You want to use Grok models in OpenClaw
  - You are configuring xAI auth or model ids
title: "xAI"
---

OpenClaw ships a bundled `xai` provider plugin for Grok models. The
recommended path is Grok OAuth with an eligible SuperGrok or X Premium
subscription. Gateway, config, routing, and tools stay local; only Grok
requests go to xAI's API.

OAuth does not require an xAI API key or the Grok Build app. xAI may still
show Grok Build on the consent screen because OpenClaw uses xAI's shared
OAuth client.

## Setup

<Steps>
  <Step title="New install">
    Run onboarding with daemon install, then pick xAI/Grok OAuth at the
    model/auth step:

    ```bash
    openclaw onboard --install-daemon
    ```

    On a VPS or over SSH, select xAI OAuth directly; it uses device-code
    verification and does not need a localhost callback:

    ```bash
    openclaw onboard --install-daemon --auth-choice xai-oauth
    ```

  </Step>
  <Step title="Existing install">
    Sign in to xAI only; do not rerun full onboarding just to connect Grok:

    ```bash
    openclaw models auth login --provider xai --method oauth
    ```

    Apply Grok as the default model separately:

    ```bash
    openclaw models set xai/grok-4.3
    ```

    Rerun full onboarding only if you intentionally want to change Gateway,
    daemon, channel, workspace, or other setup choices.

  </Step>
  <Step title="API-key path">
    API-key setup still works for xAI Console keys and for media surfaces
    that need key-backed provider config:

    ```bash
    openclaw models auth login --provider xai --method api-key
    export XAI_API_KEY=xai-...
    ```

  </Step>
  <Step title="Pick a model">
    ```json5
    {
      agents: { defaults: { model: { primary: "xai/grok-4.3" } } },
    }
    ```
  </Step>
</Steps>

<Note>
OpenClaw uses the xAI Responses API as the bundled xAI transport. The same
credential from `openclaw models auth login --provider xai --method oauth` or
`--method api-key` also powers `web_search` (provider id `grok`), `x_search`,
`code_execution`, speech/transcription, and xAI image/video generation. If you
store an xAI key under `plugins.entries.xai.config.webSearch.apiKey`, the
bundled xAI model provider reuses it as a fallback too.
</Note>

## OAuth troubleshooting

- For SSH, Docker, VPS, or other remote setups, use
  `openclaw models auth login --provider xai --method oauth`; it uses
  device-code verification, not a localhost callback.
- If sign-in succeeds but Grok is not the default model, run
  `openclaw models set xai/grok-4.3`.
- Inspect saved xAI auth profiles:

  ```bash
  openclaw models auth list --provider xai
  openclaw models status
  ```

- xAI decides which accounts can receive OAuth API tokens. If an account is
  not eligible, use the API-key path or check the subscription on xAI's side.

<Tip>
Use `xai-oauth` when signing in from SSH, Docker, or a VPS. OpenClaw prints a
URL and short code; finish sign-in in any local browser while the remote
process polls xAI for the completed token exchange.
</Tip>

## Built-in catalog

Selectable ids in model pickers. The plugin still resolves older Grok 3,
Grok 4, Grok 4 Fast, Grok 4.1 Fast, and Grok Code ids for existing configs;
see [legacy compatibility and moving aliases](#legacy-compatibility-and-moving-aliases).

| Family         | Model ids                                                    |
| -------------- | ------------------------------------------------------------ |
| Grok 4.5       | `grok-4.5` (aliases: `grok-4.5-latest`, `grok-build-latest`) |
| Grok Build 0.1 | `grok-build-0.1`                                             |
| Grok 4.3       | `grok-4.3` (aliases: `grok-4.3-latest`, `grok-latest`)       |
| Grok 4.20      | `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning`   |

<Tip>
Use `grok-4.5` for general chat, coding, and agentic work where it is available.
Grok 4.3 remains the regional-safe setup default; `grok-build-0.1` and both
dated Grok 4.20 variants remain selectable.
</Tip>

## Feature coverage

The bundled plugin maps supported xAI APIs onto OpenClaw's shared provider and
tool contracts. Capabilities that do not fit the shared contract are listed
below or under known limits.

| xAI capability             | OpenClaw surface                        | Status                                                        |
| -------------------------- | --------------------------------------- | ------------------------------------------------------------- |
| Chat / Responses           | `xai/<model>` model provider            | Yes                                                           |
| Server-side web search     | `web_search` provider `grok`            | Yes                                                           |
| Server-side X search       | `x_search` tool                         | Yes                                                           |
| Server-side code execution | `code_execution` tool                   | Yes                                                           |
| Images                     | `image_generate`                        | Yes                                                           |
| Videos                     | `video_generate`                        | Classic full workflow; Video 1.5 image-to-video               |
| Batch text-to-speech       | `messages.tts.provider: "xai"` / `tts`  | Yes                                                           |
| Streaming TTS              | -                                       | Not implemented by the xAI provider yet                       |
| Batch speech-to-text       | `tools.media.audio` media understanding | Yes                                                           |
| Streaming speech-to-text   | Voice Call `streaming.provider: "xai"`  | Yes                                                           |
| Realtime voice             | -                                       | Not exposed yet; needs a different session/WebSocket contract |
| Files / batches            | Generic model API compatibility only    | Not a first-class OpenClaw tool                               |

<Note>
OpenClaw uses xAI's REST image/video/TTS/STT APIs for media generation and
batch transcription, xAI's streaming STT WebSocket for live voice-call
transcription, and the Responses API for chat, search, and code-execution
tools.
</Note>

### Legacy fast-mode compatibility

`/fast on` or `agents.defaults.models["xai/<model>"].params.fastMode: true`
still rewrites older xAI configurations as follows. These target ids are
kept only for compatibility; use current selectable models for new
configurations.

| Source model  | Fast-mode target   |
| ------------- | ------------------ |
| `grok-3`      | `grok-3-fast`      |
| `grok-3-mini` | `grok-3-mini-fast` |
| `grok-4`      | `grok-4-fast`      |
| `grok-4-0709` | `grok-4-fast`      |

### Legacy compatibility and moving aliases

Older aliases normalize as follows:

| Legacy alias                                                  | Normalized id    |
| ------------------------------------------------------------- | ---------------- |
| `grok-code-fast-1`, `grok-code-fast`, `grok-code-fast-1-0825` | `grok-build-0.1` |

The dated 0309 ids are the selectable catalog entries. OpenClaw sends all other
current Grok 4.20 aliases verbatim so xAI retains control of stable, latest,
beta, experimental, and dated alias semantics. The global `grok-latest` alias is
also preserved verbatim.

xAI retired the following exact ids. OpenClaw keeps them as hidden compatibility
rows for shipped configurations, with the limits and pricing of their current
redirect targets:

| Retired ids                                                          | Current behavior                 |
| -------------------------------------------------------------------- | -------------------------------- |
| `grok-4-1-fast-reasoning`, `grok-4-fast-reasoning`, `grok-4-0709`    | Grok 4.3 with `low` reasoning    |
| `grok-4-1-fast-non-reasoning`, `grok-4-fast-non-reasoning`, `grok-3` | Grok 4.3 with reasoning disabled |
| `grok-code-fast-1`                                                   | Grok Build 0.1                   |
| `grok-imagine-image-pro`                                             | Grok Imagine Image Quality       |

`openclaw doctor --fix` updates persisted xAI server-tool defaults and the
retired quality image slug, removes stale generated catalog rows, and repairs
stale context metadata on active 4.20 rows. It does not pin active 4.20
`beta-latest` aliases to a dated snapshot.

## Features

<AccordionGroup>
  <Accordion title="Web search">
    The bundled `grok` web-search provider prefers xAI OAuth, then falls back
    to `XAI_API_KEY` or a plugin web-search key:

    ```bash
    openclaw models auth login --provider xai --method oauth
    openclaw config set tools.web.search.provider grok
    ```

  </Accordion>

  <Accordion title="Video generation">
    The bundled `xai` plugin registers video generation through the shared
    `video_generate` tool.

    - Default model: `xai/grok-imagine-video`
    - Additional model: `xai/grok-imagine-video-1.5`
    - Classic modes: text-to-video, image-to-video, reference-image generation,
      remote video edit, and remote video extension
    - Video 1.5 mode: image-to-video only, with exactly one first-frame image
    - Aspect ratios: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`;
      Video 1.5 inherits the source image ratio when omitted
    - Resolutions: classic `480P`/`720P`; Video 1.5 supports `480P`, `720P`,
      and `1080P`, and defaults to `480P`
    - Duration: 1-15 seconds for generation/image-to-video, 1-10 seconds when
      using classic `reference_image` roles, 2-10 seconds for classic extension
    - Reference-image generation: set `imageRoles` to `reference_image` for
      every supplied image; xAI accepts up to 7 such images
    - Default operation timeout: 600 seconds unless `video_generate.timeoutMs`
      or `agents.defaults.videoGenerationModel.timeoutMs` is set

    <Warning>
    Local video buffers are not accepted. Use remote `http(s)` URLs for video
    edit/extend inputs. Image-to-video accepts local image buffers because
    OpenClaw encodes those as data URLs for xAI.
    </Warning>

    Video 1.5 also recognizes xAI's `grok-imagine-video-1.5-preview` and
    `grok-imagine-video-1.5-2026-05-30` identifiers. OpenClaw forwards the
    selected identifier unchanged, but applies the same image-only validation.

    To use xAI as the default video provider:

    ```json5
    {
      agents: {
        defaults: {
          videoGenerationModel: {
            primary: "xai/grok-imagine-video",
          },
        },
      },
    }
    ```

    <Note>
    See [Video Generation](/tools/video-generation) for shared tool
    parameters, provider selection, and failover behavior.
    </Note>

  </Accordion>

  <Accordion title="Image generation">
    The bundled `xai` plugin registers image generation through the shared
    `image_generate` tool.

    - Default image model: `xai/grok-imagine-image`
    - Additional model: `xai/grok-imagine-image-quality`
    - Modes: text-to-image and reference-image edit
    - Reference inputs: one `image` or up to five `images`
    - Aspect ratios: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `2:3`, `3:2`
    - Resolutions: `1K`, `2K`
    - Count: up to 4 images
    - Default operation timeout: 600 seconds unless `image_generate.timeoutMs`
      or `agents.defaults.imageGenerationModel.timeoutMs` is set

    OpenClaw asks xAI for `b64_json` image responses so generated media can be
    stored and delivered through the normal channel attachment path. Local
    reference images are converted to data URLs; remote `http(s)` references
    pass through unchanged.

    To use xAI as the default image provider:

    ```json5
    {
      agents: {
        defaults: {
          imageGenerationModel: {
            primary: "xai/grok-imagine-image",
          },
        },
      },
    }
    ```

    <Note>
    xAI also documents `quality`, `mask`, `user`, and additional native ratios
    such as `1:2`, `2:1`, `9:20`, and `20:9`. OpenClaw forwards only the shared
    cross-provider image controls today; these native-only knobs are not
    exposed through `image_generate`.
    </Note>

  </Accordion>

  <Accordion title="Text-to-speech">
    The bundled `xai` plugin registers text-to-speech through the shared `tts`
    provider surface.

    - Voices: `eve`, `ara`, `rex`, `sal`, `leo`, `una`
    - Default voice: `eve`
    - Formats: `mp3`, `wav`, `pcm`, `mulaw`, `alaw`
    - Language: BCP-47 code or `auto`
    - Speed: provider-native speed override
    - Native Opus voice-note format is not supported

    To use xAI as the default TTS provider:

    ```json5
    {
      messages: {
        tts: {
          provider: "xai",
          providers: {
            xai: {
              voiceId: "eve",
            },
          },
        },
      },
    }
    ```

    <Note>
    OpenClaw uses xAI's batch `/v1/tts` endpoint. xAI also offers streaming
    TTS over WebSocket, but the bundled xAI provider does not implement that
    streaming hook yet.
    </Note>

  </Accordion>

  <Accordion title="Speech-to-text">
    The bundled `xai` plugin registers batch speech-to-text through OpenClaw's
    media-understanding transcription surface.

    - Default model: `grok-stt`
    - Endpoint: xAI REST `/v1/stt`
    - Input path: multipart audio file upload
    - Used wherever inbound audio transcription reads `tools.media.audio`,
      including Discord voice-channel segments and channel audio attachments

    To force xAI for inbound audio transcription:

    ```json5
    {
      tools: {
        media: {
          audio: {
            models: [
              {
                type: "provider",
                provider: "xai",
                model: "grok-stt",
              },
            ],
          },
        },
      },
    }
    ```

    Language can be supplied through the shared audio media config or per-call
    transcription request. Prompt hints are accepted by the shared OpenClaw
    surface, but the xAI REST STT integration forwards only file, model, and
    language because those map cleanly to the current public xAI
    endpoint.

  </Accordion>

  <Accordion title="Streaming speech-to-text">
    The bundled `xai` plugin also registers a realtime transcription provider
    for live voice-call audio.

    - Endpoint: xAI WebSocket `wss://api.x.ai/v1/stt`
    - Default encoding: `mulaw`
    - Default sample rate: `8000`
    - Default endpointing: `800ms`
    - Interim transcripts: enabled by default

    Voice Call's Twilio media stream sends G.711 mu-law audio frames, so the
    xAI provider forwards those frames directly without transcoding:

    ```json5
    {
      plugins: {
        entries: {
          "voice-call": {
            config: {
              streaming: {
                enabled: true,
                provider: "xai",
                providers: {
                  xai: {
                    apiKey: "${XAI_API_KEY}",
                    endpointingMs: 800,
                    language: "en",
                  },
                },
              },
            },
          },
        },
      },
    }
    ```

    Provider-owned config lives under
    `plugins.entries.voice-call.config.streaming.providers.xai`. Supported
    keys are `apiKey`, `baseUrl`, `sampleRate`, `encoding` (`pcm`, `mulaw`, or
    `alaw`), `interimResults`, `endpointingMs`, and `language`.

    <Note>
    This streaming provider is for Voice Call's realtime transcription path.
    Discord voice records short segments and uses the batch
    `tools.media.audio` transcription path instead.
    </Note>

  </Accordion>

  <Accordion title="x_search configuration">
    The bundled xAI plugin exposes `x_search` as an OpenClaw tool for
    searching X (formerly Twitter) content via Grok.

    Config path: `plugins.entries.xai.config.xSearch`

    | Key               | Type    | Default                       | Description                          |
    | ----------------- | ------- | ------------------------------ | ------------------------------------- |
    | `enabled`         | boolean | `true` (if key available)     | Enable or disable x_search           |
    | `model`           | string  | `grok-4.3`                    | Model used for x_search requests     |
    | `baseUrl`         | string  | -                              | xAI Responses base URL override      |
    | `inlineCitations` | boolean | -                              | Include inline citations in results  |
    | `maxTurns`        | number  | -                              | Maximum conversation turns            |
    | `timeoutSeconds`  | number  | `30`                           | Request timeout in seconds            |
    | `cacheTtlMinutes` | number  | `15`                           | Cache time-to-live in minutes         |

    ```json5
    {
      plugins: {
        entries: {
          xai: {
            config: {
              xSearch: {
                enabled: true,
                model: "grok-4.3",
                baseUrl: "https://api.x.ai/v1",
                inlineCitations: true,
              },
            },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Code execution configuration">
    The bundled xAI plugin exposes `code_execution` as an OpenClaw tool for
    remote code execution in xAI's sandbox environment.

    Config path: `plugins.entries.xai.config.codeExecution`

    | Key              | Type    | Default                  | Description                            |
    | ---------------- | ------- | -------------------------- | ---------------------------------------- |
    | `enabled`        | boolean | `true` (if key available) | Enable or disable code execution        |
    | `model`          | string  | `grok-4.3`                | Model used for code execution requests  |
    | `maxTurns`       | number  | -                           | Maximum conversation turns              |
    | `timeoutSeconds` | number  | `30`                        | Request timeout in seconds              |

    <Note>
    This is remote xAI sandbox execution, not local [`exec`](/tools/exec).
    </Note>

    ```json5
    {
      plugins: {
        entries: {
          xai: {
            config: {
              codeExecution: {
                enabled: true,
                model: "grok-4.3",
              },
            },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Known limits">
    - xAI auth can use an API key, environment variable, plugin config
      fallback, or OAuth with an eligible xAI account. OAuth uses device-code
      verification without a localhost callback. xAI decides which accounts
      can receive OAuth API tokens, and the consent page may show Grok Build
      even though OpenClaw does not require the Grok Build app.
    - OpenClaw does not currently expose the xAI multi-agent model family. xAI
      serves these models through the Responses API, but they do not accept
      the client-side or custom tools used by OpenClaw's shared agent loop.
      See the
      [xAI multi-agent limitations](https://docs.x.ai/developers/model-capabilities/text/multi-agent#limitations).
    - xAI Realtime voice is not registered as an OpenClaw provider yet. It
      needs a different bidirectional voice session contract than batch STT
      or streaming transcription.
    - xAI image `quality`, image `mask`, and extra native-only aspect ratios
      are not exposed until the shared `image_generate` tool has
      corresponding cross-provider controls.
  </Accordion>

  <Accordion title="Advanced notes">
    - OpenClaw applies xAI-specific tool-schema and tool-call compatibility
      fixes automatically on the shared runner path.
    - Native xAI requests default `tool_stream: true`. Set
      `agents.defaults.models["xai/<model>"].params.tool_stream` to `false`
      to disable it.
    - The bundled xAI wrapper strips unsupported contains-count schema bounds
      and unsupported reasoning *effort* payload keys before sending native
      xAI requests. Grok 4.5 supports low, medium, and
      high effort (default high). Grok 4.3 supports none, low, medium, and high
      effort (default low). Other reasoning-capable xAI models do not expose a
      configurable effort control, but still request
      `include: ["reasoning.encrypted_content"]` so prior encrypted reasoning
      can be replayed on follow-up turns.
    - `web_search`, `x_search`, and `code_execution` are exposed as OpenClaw
      tools. OpenClaw attaches only the specific xAI built-in each tool needs
      to that tool's request instead of attaching every native tool to every
      chat turn.
    - Grok `web_search` reads `plugins.entries.xai.config.webSearch.baseUrl`.
      `x_search` reads `plugins.entries.xai.config.xSearch.baseUrl`, then
      falls back to the Grok web-search base URL.
    - `x_search` and `code_execution` are owned by the bundled xAI plugin
      rather than hardcoded into the core model runtime.
    - `code_execution` is remote xAI sandbox execution, not local
      [`exec`](/tools/exec).
  </Accordion>
</AccordionGroup>

## Live testing

The xAI media paths are covered by unit tests and opt-in live suites. Export
`XAI_API_KEY` in the process environment before running live probes.

```bash
pnpm test extensions/xai
OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_TEST_QUIET=1 pnpm test:live -- extensions/xai/xai.live.test.ts
OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_XAI_VIDEO_15=1 pnpm test:live -- extensions/xai/xai.live.test.ts -t "Grok Imagine Video 1.5"
OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_TEST_QUIET=1 pnpm test:live -- extensions/xai/x-search.live.test.ts
OPENCLAW_LIVE_GATEWAY_MODELS="xai/grok-4.5,xai/grok-build-0.1,xai/grok-4.3,xai/grok-4.20-0309-reasoning,xai/grok-4.20-0309-non-reasoning" OPENCLAW_LIVE_GATEWAY_MAX_MODELS=0 OPENCLAW_LIVE_GATEWAY_SMOKE=0 pnpm test:live -- src/gateway/gateway-models.profiles.live.test.ts
OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_TEST_QUIET=1 OPENCLAW_LIVE_IMAGE_GENERATION_PROVIDERS=xai pnpm test:live -- test/image-generation.runtime.live.test.ts
```

The provider-specific live file synthesizes normal TTS, telephony-friendly PCM
TTS, transcribes audio through xAI batch STT, streams the same PCM through xAI
realtime STT, generates text-to-image output, and edits a reference image.
The shared image live file verifies the same xAI provider through OpenClaw's
runtime selection, fallback, normalization, and media attachment path. The
opt-in Video 1.5 case submits one generated first-frame image at 1080P and
verifies the completed video download.

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Video generation" href="/tools/video-generation" icon="video">
    Shared video tool parameters and provider selection.
  </Card>
  <Card title="All providers" href="/providers/index" icon="grid-2">
    The broader provider overview.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    Common issues and fixes.
  </Card>
</CardGroup>
