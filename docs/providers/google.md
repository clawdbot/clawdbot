---
summary: "Google Gemini setup (API key + OAuth, image generation, media understanding, TTS, web search)"
title: "Google (Gemini)"
read_when:
  - You want to use Google Gemini models with OpenClaw
  - You need the API key or OAuth auth flow
---

The Google plugin provides access to Gemini models through Google AI Studio, plus image generation, media understanding (image/audio/video), text-to-speech, and web search via Gemini Grounding.

- Provider: `google`
- Auth: `GEMINI_API_KEY` or `GOOGLE_API_KEY`
- API: Google Gemini API
- Runtime option: `agentRuntime.id: "google-gemini-cli"` reuses Gemini CLI OAuth while keeping model refs canonical as `google/*`.

## Getting started

Choose your preferred auth method and follow the setup steps.

<Tabs>
  <Tab title="API key">
    **Best for:** standard Gemini API access through Google AI Studio.

    <Steps>
      <Step title="Get an API key">
        Create a free key in [Google AI Studio](https://aistudio.google.com/apikey).
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice gemini-api-key
        ```

        Or pass the key directly:

        ```bash
        openclaw onboard --non-interactive \
          --mode local \
          --auth-choice gemini-api-key \
          --gemini-api-key "$GEMINI_API_KEY"
        ```
      </Step>
      <Step title="Set a default model">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "google/gemini-3.1-pro-preview" },
            },
          },
        }
        ```
      </Step>
      <Step title="Verify the model is available">
        ```bash
        openclaw models list --provider google
        ```
      </Step>
    </Steps>

    <Tip>
    `GEMINI_API_KEY` and `GOOGLE_API_KEY` are both accepted. Use whichever you already have configured.
    </Tip>

  </Tab>

  <Tab title="Gemini CLI (OAuth)">
    **Best for:** signing in with your Google account through Gemini CLI OAuth instead of using a separate API key.

    <Warning>
    The `google-gemini-cli` provider is an unofficial integration. Some users
    report account restrictions when using OAuth this way. Use at your own risk.
    </Warning>

    <Steps>
      <Step title="Install the Gemini CLI">
        The local `gemini` command must be available on `PATH`.

        ```bash
        # Homebrew
        brew install gemini-cli

        # or npm
        npm install -g @google/gemini-cli
        ```

        OpenClaw supports both Homebrew installs and global npm installs, including
        common Windows/npm layouts.
      </Step>
      <Step title="Log in via OAuth">
        ```bash
        openclaw models auth login --provider google-gemini-cli --set-default
        ```
      </Step>
      <Step title="Verify the model is available">
        ```bash
        openclaw models list --provider google
        ```
      </Step>
    </Steps>

    - Default model: `google/gemini-3.1-pro-preview`
    - Runtime: `google-gemini-cli`
    - Alias: `gemini-cli`

    Gemini 3.1 Pro's Gemini API model id is `gemini-3.1-pro-preview`. OpenClaw accepts the shorter `google/gemini-3.1-pro` as a convenience alias and normalizes it before provider calls.

    **Environment variables:**

    - `OPENCLAW_GEMINI_OAUTH_CLIENT_ID` / `GEMINI_CLI_OAUTH_CLIENT_ID`
    - `OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET` / `GEMINI_CLI_OAUTH_CLIENT_SECRET`

    <Note>
    If Gemini CLI OAuth requests fail after login, set `GOOGLE_CLOUD_PROJECT` or
    `GOOGLE_CLOUD_PROJECT_ID` on the gateway host and retry.
    </Note>

    <Note>
    If login fails before the browser flow starts, make sure the local `gemini`
    command is installed and on `PATH`.
    </Note>

    Onboarding auto-detection lists an existing Gemini CLI login but never
    auto-tests it because Gemini CLI has no tool-free probe. Choose Gemini CLI
    OAuth or a Gemini API key to continue.

    `google-gemini-cli/*` model refs are legacy compatibility aliases. New
    configs should use `google/*` model refs plus the `google-gemini-cli`
    runtime when they want local Gemini CLI execution.

  </Tab>
</Tabs>

<Note>
`google/gemini-3-pro-preview` was retired on 2026-03-09; use `google/gemini-3.1-pro-preview` instead. Re-running Gemini API key setup (`openclaw onboard --auth-choice gemini-api-key` or `openclaw models auth login --provider google`) rewrites a stale configured default to the current model.
</Note>

## Capabilities

| Capability             | Supported                     |
| ---------------------- | ----------------------------- |
| Chat completions       | Yes                           |
| Image generation       | Yes                           |
| Music generation       | Yes                           |
| Text-to-speech         | Yes                           |
| Realtime voice         | Yes (Google Live API)         |
| Image understanding    | Yes                           |
| Audio transcription    | Yes                           |
| Video understanding    | Yes                           |
| Web search (Grounding) | Yes                           |
| Thinking/reasoning     | Yes (Gemini 2.5+ / Gemini 3+) |
| Gemma 4 models         | Yes                           |

## Web search

The bundled `gemini` web-search provider uses Gemini Google Search grounding.
Configure a dedicated search key under `plugins.entries.google.config.webSearch`,
or let it reuse `models.providers.google.apiKey` after `GEMINI_API_KEY`:

```json5
{
  plugins: {
    entries: {
      google: {
        config: {
          webSearch: {
            apiKey: "AIza...", // optional if GEMINI_API_KEY or models.providers.google.apiKey is set
            baseUrl: "https://generativelanguage.googleapis.com/v1beta", // falls back to models.providers.google.baseUrl
            model: "gemini-2.5-flash",
          },
        },
      },
    },
  },
}
```

Credential precedence is dedicated `webSearch.apiKey`, then `GEMINI_API_KEY`,
then `models.providers.google.apiKey`. `webSearch.baseUrl` is optional and
exists for operator proxies or compatible Gemini API endpoints; when omitted,
Gemini web search reuses `models.providers.google.baseUrl`. See
[Gemini search](/tools/gemini-search) for the provider-specific tool behavior.

<Tip>
Gemini 3 models use `thinkingLevel` rather than `thinkingBudget`. OpenClaw maps
Gemini 3, Gemini 3.1, and `gemini-*-latest` alias reasoning controls to
`thinkingLevel` so default/low-latency runs do not send disabled
`thinkingBudget` values.

`/think adaptive` keeps Google's dynamic thinking semantics instead of choosing
a fixed OpenClaw level. Gemini 3 and Gemini 3.1 omit a fixed `thinkingLevel` so
Google can choose the level; Gemini 2.5 sends Google's dynamic sentinel
`thinkingBudget: -1`.

Gemma 4 models (for example `gemma-4-26b-a4b-it`) support thinking mode. OpenClaw
rewrites `thinkingBudget` to a supported Google `thinkingLevel` for Gemma 4.
Setting thinking to `off` preserves thinking disabled instead of mapping to
`MINIMAL`.

Gemini 2.5 Pro only works in thinking mode and rejects an explicit
`thinkingBudget: 0`; OpenClaw strips that value for Gemini 2.5 Pro requests
instead of sending it.
</Tip>

## Image generation

The bundled `google` image-generation provider defaults to
`google/gemini-3.1-flash-image`.

- Also supports `google/gemini-3-pro-image`
- Generate: up to 4 images per request
- Edit mode: enabled, up to 5 input images
- Geometry controls: `size`, `aspectRatio`, and `resolution`

To use Google as the default image provider:

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "google/gemini-3.1-flash-image",
      },
    },
  },
}
```

<Note>
See [Image Generation](/tools/image-generation) for shared tool parameters, provider selection, and failover behavior.
</Note>

## Video generation

The bundled `google` plugin also registers video generation through the shared
`video_generate` tool.

- Default video model: `google/veo-3.1-fast-generate-preview`
- Modes: text-to-video, image-to-video, and single-video reference flows
- Supports `aspectRatio` (`16:9`, `9:16`) and `resolution` (`720P`, `1080P`); audio output is not supported by Veo today
- Supported durations: **4, 6, or 8 seconds** (other values snap to the nearest allowed value)

To use Google as the default video provider:

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "google/veo-3.1-fast-generate-preview",
      },
    },
  },
}
```

<Note>
See [Video Generation](/tools/video-generation) for shared tool parameters, provider selection, and failover behavior.
</Note>

## Music generation

The bundled `google` plugin also registers music generation through the shared
`music_generate` tool.

- Default music model: `google/lyria-3-clip-preview`
- Also supports `google/lyria-3-pro-preview`
- Prompt controls: `lyrics` and `instrumental`
- Output format: `mp3` by default, plus `wav` on `google/lyria-3-pro-preview`
- Reference inputs: up to 10 images
- Session-backed runs detach through the shared task/status flow, including `action: "status"`

To use Google as the default music provider:

```json5
{
  agents: {
    defaults: {
      musicGenerationModel: {
        primary: "google/lyria-3-clip-preview",
      },
    },
  },
}
```

<Note>
See [Music Generation](/tools/music-generation) for shared tool parameters, provider selection, and failover behavior.
</Note>

## Text-to-speech

The bundled `google` speech provider uses the Gemini API TTS path with
`gemini-3.1-flash-tts-preview`.

- Default voice: `Kore`
- Auth: `messages.tts.providers.google.apiKey`, `models.providers.google.apiKey`, `GEMINI_API_KEY`, or `GOOGLE_API_KEY`
- Output: WAV for regular TTS attachments, Opus for voice-note targets, PCM for Talk/telephony
- Voice-note output: Google PCM is wrapped as WAV and transcoded to 48 kHz Opus with `ffmpeg`

Google's batch Gemini TTS path returns generated audio in the completed
`generateContent` response. For lowest-latency spoken conversations, use the
Google realtime voice provider backed by the Gemini Live API instead of batch
TTS.

To use Google as the default TTS provider:

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "google",
      providers: {
        google: {
          model: "gemini-3.1-flash-tts-preview",
          speakerVoice: "Kore",
          audioProfile: "Speak professionally with a calm tone.",
        },
      },
    },
  },
}
```

Gemini API TTS uses natural-language prompting for style control. Set
`audioProfile` to prepend a reusable style prompt before the spoken text. Set
`speakerName` when your prompt text refers to a named speaker.

Gemini API TTS also accepts expressive square-bracket audio tags in the text,
such as `[whispers]` or `[laughs]`. To keep tags out of the visible chat reply
while sending them to TTS, put them inside a `[[tts:text]]...[[/tts:text]]`
block:

```text
Here is the clean reply text.

[[tts:text]][whispers] Here is the spoken version.[[/tts:text]]
```

<Note>
A Google Cloud Console API key restricted to the Gemini API is valid for this
provider. This is not the separate Cloud Text-to-Speech API path.
</Note>

## Realtime voice

The bundled `google` plugin registers a realtime voice provider backed by the
Gemini Live API for backend audio bridges such as Voice Call and Google Meet.

| Setting               | Config path                                                         | Default                                                                               |
| --------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Model                 | `plugins.entries.voice-call.config.realtime.providers.google.model` | `gemini-3.1-flash-live-preview`                                                       |
| Voice                 | `...google.voice`                                                   | `Kore`                                                                                |
| Temperature           | `...google.temperature`                                             | (unset)                                                                               |
| VAD start sensitivity | `...google.startSensitivity`                                        | (unset)                                                                               |
| VAD end sensitivity   | `...google.endSensitivity`                                          | (unset)                                                                               |
| Silence duration      | `...google.silenceDurationMs`                                       | (unset)                                                                               |
| Activity handling     | `...google.activityHandling`                                        | Google default, `start-of-activity-interrupts`                                        |
| Turn coverage         | `...google.turnCoverage`                                            | Google default, `audio-activity-and-all-video`                                        |
| Disable auto VAD      | `...google.automaticActivityDetectionDisabled`                      | `false`                                                                               |
| Session resumption    | `...google.sessionResumption`                                       | `true`                                                                                |
| Context compression   | `...google.contextWindowCompression`                                | `true`                                                                                |
| API key               | `...google.apiKey`                                                  | Falls back to `models.providers.google.apiKey`, `GEMINI_API_KEY`, or `GOOGLE_API_KEY` |

Example Voice Call realtime config:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          realtime: {
            enabled: true,
            provider: "google",
            providers: {
              google: {
                model: "gemini-3.1-flash-live-preview",
                speakerVoice: "Kore",
                activityHandling: "start-of-activity-interrupts",
                turnCoverage: "audio-activity-and-all-video",
              },
            },
          },
        },
      },
    },
  },
}
```

<Note>
Google Live API uses bidirectional audio and function calling over a WebSocket.
OpenClaw adapts telephony/Meet bridge audio to Gemini's PCM Live API stream and
keeps tool calls on the shared realtime voice contract. Leave `temperature`
unset unless you need sampling changes; OpenClaw omits non-positive values
because Google Live can return transcripts without audio for `temperature: 0`.
Gemini API transcription is enabled without `languageCodes`; the current Google
SDK rejects language-code hints on this API path.
</Note>

<Note>
Gemini 3.1 Live accepts conversational text through realtime input and uses
sequential function calling. OpenClaw omits the older `NON_BLOCKING`, function
response scheduling, and affective-dialog fields for this model. Prefer
`thinkingLevel`; configured positive `thinkingBudget` values are mapped to the
nearest supported level, while `-1` leaves Google's default in place. See the
[Gemini Live capability comparison](https://ai.google.dev/gemini-api/docs/live-api/capabilities).
</Note>

<Note>
Control UI Talk supports Google Live browser sessions with constrained one-use
tokens. In Video Talk, the browser sends bounded JPEG frames directly to
Google Live at the provider's maximum of one frame per second. The
`describe_view` function reports whether that camera stream is active.
Camera frames do not pass through the Gateway. Backend-only realtime voice
providers can also run through the generic Gateway relay transport, which
keeps provider credentials on the Gateway.
</Note>

For maintainer live verification, run
`OPENAI_API_KEY=... GEMINI_API_KEY=... node --import tsx scripts/dev/realtime-talk-live-smoke.ts`.
The smoke also covers OpenAI backend/WebRTC paths; the Google leg mints the same
constrained Live API token shape used by Control UI Talk, opens the browser
WebSocket endpoint, sends the initial setup payload plus a JPEG frame, and
verifies a text response and `describe_view` function roundtrip.

## Advanced configuration

<AccordionGroup>
  <Accordion title="Direct Gemini cache reuse">
    For direct Gemini API runs (`api: "google-generative-ai"`), OpenClaw
    passes a configured `cachedContent` handle through to Gemini requests.

    - Configure per-model or global params with either
      `cachedContent` or legacy `cached_content`
    - Params from a more specific scope (model-level over global) always win.
      Within the same scope, if both keys are set, `cached_content` wins.
      Use only one key per scope to avoid surprises.
    - Example value: `cachedContents/prebuilt-context`
    - Gemini cache-hit usage is normalized into OpenClaw `cacheRead` from
      upstream `cachedContentTokenCount`

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "google/gemini-2.5-pro": {
              params: {
                cachedContent: "cachedContents/prebuilt-context",
              },
            },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Gemini CLI usage notes">
    When using the `google-gemini-cli` OAuth provider, OpenClaw uses Gemini
    CLI `stream-json` output by default and normalizes usage from the final
    `stats` payload. Legacy `--output-format json` overrides still use the
    JSON parser.

    - Streamed reply text comes from assistant `message` events.
    - For legacy JSON output, reply text comes from the CLI JSON `response` field.
    - Usage falls back to `stats` when the CLI leaves `usage` empty.
    - `stats.cached` is normalized into OpenClaw `cacheRead`.
    - If `stats.input` is missing, OpenClaw derives input tokens from
      `stats.input_tokens - stats.cached`.

  </Accordion>

  <Accordion title="Environment and daemon setup">
    If the Gateway runs as a daemon (launchd/systemd), make sure `GEMINI_API_KEY`
    is available to that process (for example, in `~/.openclaw/.env` or via
    `env.shellEnv`).
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
  <Card title="Music generation" href="/tools/music-generation" icon="music">
    Shared music tool parameters and provider selection.
  </Card>
</CardGroup>
