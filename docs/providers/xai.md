---
summary: "Use xAI Grok models in OpenClaw"
read_when:
  - You want to use Grok models in OpenClaw
  - You are configuring xAI auth or model ids
title: "xAI"
---

OpenClaw ships a bundled `xai` provider plugin for Grok models. For most
users, the recommended path is Grok OAuth with an eligible SuperGrok or X Premium
subscription. OpenClaw stays local-first: the Gateway, config, routing, and
tools run on your machine, while Grok model requests authenticate through xAI
and are sent to xAI's API.

OAuth does not require an xAI API key, and it does not require the Grok Build
app. xAI may still show Grok Build on the consent screen because OpenClaw uses
xAI's shared OAuth client.

## Choose your setup path

Use the path that matches your OpenClaw install state:

<Steps>
  <Step title="New OpenClaw install">
    Run onboarding with daemon install when you are setting up a new local
    Gateway, then choose the xAI/Grok OAuth option in the model/auth step:

    ```bash
    openclaw onboard --install-daemon
    ```

    On a VPS or over SSH, use device-code during onboarding:

    ```bash
    openclaw onboard --install-daemon --auth-choice xai-device-code
    ```

    OAuth does not require an xAI API key. OpenClaw does not require the Grok
    Build app. xAI may still label the consent app as Grok Build because
    OpenClaw uses xAI's shared OAuth client.

  </Step>
  <Step title="Existing OpenClaw install">
    If OpenClaw is already configured, sign in to xAI only. Do not rerun full
    onboarding or reinstall the daemon just to connect Grok:

    ```bash
    openclaw models auth login --provider xai --method oauth
    ```

    Use the device-code flow instead when the Gateway runs over SSH, Docker, or
    a VPS and a localhost browser callback is awkward:

    ```bash
    openclaw models auth login --provider xai --device-code
    ```

    To make Grok the default model after signing in, apply it separately:

    ```bash
    openclaw models set xai/grok-4.3
    ```

    Rerun full onboarding only if you intentionally want to change Gateway,
    daemon, channel, workspace, or other setup choices.

  </Step>
  <Step title="API-key path">
    API-key setup still works for xAI Console keys and for media surfaces that
    require key-backed provider config:

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
credential from `openclaw models auth login --provider xai --method oauth`,
`openclaw models auth login --provider xai --device-code`, or
`openclaw models auth login --provider xai --method api-key` can also power first-class
`web_search`, `x_search`, remote `code_execution`, and xAI image/video generation.
Speech and transcription currently require `XAI_API_KEY` or provider config.
Grok-backed `web_search` prefers xAI OAuth and falls back to `XAI_API_KEY` or
plugin web-search config.
If you store an xAI key under `plugins.entries.xai.config.webSearch.apiKey`,
the bundled xAI model provider reuses that key as a fallback too.
Set `plugins.entries.xai.config.webSearch.baseUrl` to route Grok `web_search`
and, by default, `x_search` through an operator xAI Responses proxy.
`code_execution` tuning lives under `plugins.entries.xai.config.codeExecution`.
</Note>

## OAuth troubleshooting

- If browser OAuth cannot reach `127.0.0.1:56121`, use
  `openclaw models auth login --provider xai --device-code`.
- If sign-in succeeds but Grok is not the default model, run
  `openclaw models set xai/grok-4.3`.
- To inspect saved xAI auth profiles, run:

  ```bash
  openclaw models auth list --provider xai
  openclaw models status
  ```

- xAI decides which accounts can receive OAuth API tokens. If an account is not
  eligible, try the API-key path or check the subscription on xAI's side.

<Tip>
Use `xai-device-code` when signing in from SSH, Docker, or a VPS. OpenClaw
prints an xAI URL and short code; finish sign-in in any local browser while the
remote process polls xAI for the completed token exchange.
</Tip>

## Built-in catalog

OpenClaw includes the current xAI chat models out of the box, ordered newest
first in model pickers:

| Family         | Model ids                                                                |
| -------------- | ------------------------------------------------------------------------ |
| Grok Build 0.1 | `grok-build-0.1`                                                         |
| Grok 4.3       | `grok-4.3`                                                               |
| Grok 4.20 Beta | `grok-4.20-beta-latest-reasoning`, `grok-4.20-beta-latest-non-reasoning` |

The plugin still forward-resolves older Grok 3, Grok 4, Grok 4 Fast, Grok 4.1
Fast, and Grok Code slugs for existing configs. Official Grok Code Fast aliases
normalize to `grok-build-0.1`; OpenClaw no longer shows the other retired
upstream slugs in the selectable catalog.

<Tip>
Use `grok-4.3` for general chat and `grok-build-0.1` for build/coding-focused
workloads unless you explicitly need a Grok 4.20 beta alias.
</Tip>

## OpenClaw feature coverage

The bundled plugin maps xAI's current public API surface onto OpenClaw's shared
provider and tool contracts. Capabilities that don't fit the shared contract
(for example streaming TTS and realtime voice) are not exposed - see the table
below.

| xAI capability             | OpenClaw surface                          | Status                                                              |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------- |
| Chat / Responses           | `xai/<model>` model provider              | Yes                                                                 |
| Server-side web search     | `web_search` provider `grok`              | Yes                                                                 |
| Server-side X search       | `x_search` tool                           | Yes                                                                 |
| Server-side code execution | `code_execution` tool                     | Yes                                                                 |
| Images                     | `image_generate`                          | Yes                                                                 |
| Videos                     | `video_generate`                          | Yes                                                                 |
| Batch text-to-speech       | `messages.tts.provider: "xai"` / `tts`    | Yes                                                                 |
| Streaming TTS              | -                                         | Not exposed; OpenClaw's TTS contract returns complete audio buffers |
| Batch speech-to-text       | `tools.media.audio` / media understanding | Yes                                                                 |
| Streaming speech-to-text   | Voice Call `streaming.provider: "xai"`    | Yes                                                                 |
| Realtime voice             | -                                         | Not exposed yet; different session/WebSocket contract               |
| Files / batches            | Generic model API compatibility only      | Not a first-class OpenClaw tool                                     |

<Note>
OpenClaw uses xAI's REST image/video/TTS/STT APIs for media generation,
speech, and batch transcription, xAI's streaming STT WebSocket for live
voice-call transcription, and the Responses API for model, search, and
code-execution tools. Features that need different OpenClaw contracts, such as
Realtime voice sessions, are documented here as upstream capabilities rather
than hidden plugin behavior.
</Note>

### Fast-mode mappings

`/fast on` or `agents.defaults.models["xai/<model>"].params.fastMode: true`
rewrites native xAI requests as follows:

| Source model  | Fast-mode target   |
| ------------- | ------------------ |
| `grok-3`      | `grok-3-fast`      |
| `grok-3-mini` | `grok-3-mini-fast` |
| `grok-4`      | `grok-4-fast`      |
| `grok-4-0709` | `grok-4-fast`      |

### Legacy compatibility aliases

Legacy aliases still normalize to the canonical bundled ids:

| Legacy alias              | Canonical id                          |
| ------------------------- | ------------------------------------- |
| `grok-code-fast-1`        | `grok-build-0.1`                      |
| `grok-code-fast`          | `grok-build-0.1`                      |
| `grok-code-fast-1-0825`   | `grok-build-0.1`                      |
| `grok-4-fast-reasoning`   | `grok-4-fast`                         |
| `grok-4-1-fast-reasoning` | `grok-4-1-fast`                       |
| `grok-4.20-reasoning`     | `grok-4.20-beta-latest-reasoning`     |
| `grok-4.20-non-reasoning` | `grok-4.20-beta-latest-non-reasoning` |

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

    - Default video model: `xai/grok-imagine-video`
    - Modes: text-to-video, image-to-video, reference-image generation, remote
      video edit, and remote video extension
    - Aspect ratios: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`
    - Resolutions: `480P`, `720P`
    - Duration: 1-15 seconds for generation/image-to-video, 1-10 seconds when
      using `reference_image` roles, 2-10 seconds for extension
    - Reference-image generation: set `imageRoles` to `reference_image` for
      every supplied image; xAI accepts up to 7 such images
    - Default operation timeout: 600 seconds unless `video_generate.timeoutMs`
      or `agents.defaults.videoGenerationModel.timeoutMs` is set

    <Warning>
    Local video buffers are not accepted. Use remote `http(s)` URLs for
    video edit/extend inputs. Image-to-video accepts local image buffers because
    OpenClaw can encode those as data URLs for xAI.
    </Warning>

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
    See [Video Generation](/tools/video-generation) for shared tool parameters,
    provider selection, and failover behavior.
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
    reference images are converted to data URLs; remote `http(s)` references are
    passed through.

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
    such as `1:2`, `2:1`, `9:20`, and `20:9`. OpenClaw forwards only the
    shared cross-provider image controls today; unsupported native-only knobs
    are intentionally not exposed through `image_generate`.
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
    OpenClaw uses xAI's batch `/v1/tts` endpoint. xAI also offers streaming TTS
    over WebSocket, but the OpenClaw speech provider contract currently expects
    a complete audio buffer before reply delivery.
    </Note>

  </Accordion>

  <Accordion title="Speech-to-text">
    The bundled `xai` plugin registers batch speech-to-text through OpenClaw's
    media-understanding transcription surface.

    - Default model: `grok-stt`
    - Endpoint: xAI REST `/v1/stt`
    - Input path: multipart audio file upload
    - Supported by OpenClaw wherever inbound audio transcription uses
      `tools.media.audio`, including Discord voice-channel segments and
      channel audio attachments

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
    surface, but the xAI REST STT integration only forwards file, model, and
    language because those map cleanly to the current public xAI endpoint.

  </Accordion>

  <Accordion title="Streaming speech-to-text">
    The bundled `xai` plugin also registers a realtime transcription provider
    for live voice-call audio.

    - Endpoint: xAI WebSocket `wss://api.x.ai/v1/stt`
    - Default encoding: `mulaw`
    - Default sample rate: `8000`
    - Default endpointing: `800ms`
    - Interim transcripts: enabled by default

    Voice Call's Twilio media stream sends G.711 µ-law audio frames, so the
    xAI provider can forward those frames directly without transcoding:

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
    Discord voice currently records short segments and uses the batch
    `tools.media.audio` transcription path instead.
    </Note>

  </Accordion>

  <Accordion title="x_search configuration">
    The bundled xAI plugin exposes `x_search` as an OpenClaw tool for searching
    X (formerly Twitter) content via Grok.

    Config path: `plugins.entries.xai.config.xSearch`

    | Key                | Type    | Default            | Description                          |
    | ------------------ | ------- | ------------------ | ------------------------------------ |
    | `enabled`          | boolean | -                  | Enable or disable x_search           |
    | `model`            | string  | `grok-4-1-fast`    | Model used for x_search requests     |
    | `baseUrl`          | string  | -                  | xAI Responses base URL override      |
    | `inlineCitations`  | boolean | -                  | Include inline citations in results  |
    | `maxTurns`         | number  | -                  | Maximum conversation turns           |
    | `timeoutSeconds`   | number  | -                  | Request timeout in seconds           |
    | `cacheTtlMinutes`  | number  | -                  | Cache time-to-live in minutes        |

    ```json5
    {
      plugins: {
        entries: {
          xai: {
            config: {
              xSearch: {
                enabled: true,
                model: "grok-4-1-fast",
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

    | Key               | Type    | Default            | Description                              |
    | ----------------- | ------- | ------------------ | ---------------------------------------- |
    | `enabled`         | boolean | `true` (if key available) | Enable or disable code execution  |
    | `model`           | string  | `grok-4-1-fast`    | Model used for code execution requests   |
    | `maxTurns`        | number  | -                  | Maximum conversation turns               |
    | `timeoutSeconds`  | number  | -                  | Request timeout in seconds               |

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
                model: "grok-4-1-fast",
              },
            },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Known limits">
    - xAI auth can use an API key, environment variable, plugin config fallback,
      browser OAuth, or device-code OAuth with an eligible xAI account. Browser
      OAuth uses a local callback on `127.0.0.1:56121`; for remote hosts, use
      `xai-device-code` unless you want to forward that port before opening the
      sign-in URL. xAI decides which accounts can receive OAuth API tokens, and
      the consent page may show Grok Build even though OpenClaw does not require
      the Grok Build app.
    - `grok-4.20-multi-agent-experimental-beta-0304` is not supported on the
      normal xAI provider path because it requires a different upstream API
      surface than the standard OpenClaw xAI transport.
    - xAI Realtime voice is not registered as an OpenClaw provider yet. It
      needs a different bidirectional voice session contract than batch STT or
      streaming transcription.
    - xAI image `quality`, image `mask`, and extra native-only aspect ratios are
      not exposed until the shared `image_generate` tool has corresponding
      cross-provider controls.
  </Accordion>

  <Accordion title="Advanced notes">
    - OpenClaw applies xAI-specific tool-schema and tool-call compatibility fixes
      automatically on the shared runner path.
    - Native xAI requests default `tool_stream: true`. Set
      `agents.defaults.models["xai/<model>"].params.tool_stream` to `false` to
      disable it.
    - The bundled xAI wrapper strips unsupported strict tool-schema flags and
      reasoning payload keys before sending native xAI requests.
    - `web_search`, `x_search`, and `code_execution` are exposed as OpenClaw
      tools. OpenClaw enables the specific xAI built-in it needs inside each tool
      request instead of attaching all native tools to every chat turn.
    - Grok `web_search` reads `plugins.entries.xai.config.webSearch.baseUrl`.
      `x_search` reads `plugins.entries.xai.config.xSearch.baseUrl`, then
      falls back to the Grok web-search base URL.
    - `x_search` and `code_execution` are owned by the bundled xAI plugin rather
      than hardcoded into the core model runtime.
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
OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_TEST_QUIET=1 OPENCLAW_LIVE_IMAGE_GENERATION_PROVIDERS=xai pnpm test:live -- test/image-generation.runtime.live.test.ts
```

The provider-specific live file synthesizes normal TTS, telephony-friendly PCM
TTS, transcribes audio through xAI batch STT, streams the same PCM through xAI
realtime STT, generates text-to-image output, and edits a reference image. The
shared image live file verifies the same xAI provider through OpenClaw's
runtime selection, fallback, normalization, and media attachment path.

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
