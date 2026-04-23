---
summary: "Google Gemini setup (API key + OAuth, image generation, media understanding, TTS, web search)"
title: "Google (Gemini)"
read_when:
  - You want to use Google Gemini models with OpenClaw
  - You need the API key or OAuth auth flow
---

The Google plugin provides access to Gemini models through Google AI Studio, plus
image generation, media understanding (image/audio/video), text-to-speech, and web search via
Gemini Grounding.

- Provider: `google`
- Auth: `GEMINI_API_KEY` or `GOOGLE_API_KEY`
- API: Google Gemini API
- Alternative provider: `google-gemini-cli` (OAuth)

## Getting started

Choose your preferred auth method and follow the setup steps.

<Tabs>
  <Tab title="API key">
    **Best for:** standard Gemini API access through Google AI Studio.

    <Steps>
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
    The environment variables `GEMINI_API_KEY` and `GOOGLE_API_KEY` are both accepted. Use whichever you already have configured.
    </Tip>

  </Tab>

  <Tab title="Gemini CLI (OAuth)">
    **Best for:** reusing an existing Gemini CLI login via PKCE OAuth instead of a separate API key.

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
        openclaw models list --provider google-gemini-cli
        ```
      </Step>
    </Steps>

    - Default model: `google-gemini-cli/gemini-3-flash-preview`
    - Alias: `gemini-cli`

    **Environment variables:**

    - `OPENCLAW_GEMINI_OAUTH_CLIENT_ID`
    - `OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET`

    (Or the `GEMINI_CLI_*` variants.)

    <Note>
    If Gemini CLI OAuth requests fail after login, set `GOOGLE_CLOUD_PROJECT` or
    `GOOGLE_CLOUD_PROJECT_ID` on the gateway host and retry.
    </Note>

    <Note>
    If login fails before the browser flow starts, make sure the local `gemini`
    command is installed and on `PATH`.
    </Note>

    The OAuth-only `google-gemini-cli` provider is a separate text-inference
    surface. Image generation, media understanding, and Gemini Grounding stay on
    the `google` provider id.

  </Tab>
</Tabs>

## Capabilities

| Capability             | Supported                     |
| ---------------------- | ----------------------------- |
| Chat completions       | Yes                           |
| Image generation       | Yes                           |
| Music generation       | Yes                           |
| Text-to-speech         | Yes                           |
| Image understanding    | Yes                           |
| Audio transcription    | Yes                           |
| Video understanding    | Yes                           |
| Web search (Grounding) | Yes                           |
| Thinking/reasoning     | Yes (Gemini 2.5+ / Gemini 3+) |
| Gemma 4 models         | Yes                           |

<Tip>
Gemini 3 models use `thinkingLevel` rather than `thinkingBudget`. OpenClaw maps
Gemini 3, Gemini 3.1, and `gemini-*-latest` alias reasoning controls to
`thinkingLevel` so default/low-latency runs do not send disabled
`thinkingBudget` values.

Gemma 4 models (for example `gemma-4-26b-a4b-it`) support thinking mode. OpenClaw
rewrites `thinkingBudget` to a supported Google `thinkingLevel` for Gemma 4.
Setting thinking to `off` preserves thinking disabled instead of mapping to
`MINIMAL`.
</Tip>

## Image generation

The bundled `google` image-generation provider defaults to
`google/gemini-3.1-flash-image-preview`.

- Also supports `google/gemini-3-pro-image-preview`
- Generate: up to 4 images per request
- Edit mode: enabled, up to 5 input images
- Geometry controls: `size`, `aspectRatio`, and `resolution`

To use Google as the default image provider:

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "google/gemini-3.1-flash-image-preview",
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
- Supports `aspectRatio`, `resolution`, and `audio`
- Current duration clamp: **4 to 8 seconds**

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
- Output: WAV for regular TTS attachments, PCM for Talk/telephony
- Native voice-note output: not supported on this Gemini API path because the API returns PCM rather than Opus

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
          voiceName: "Kore",
        },
      },
    },
  },
}
```

Gemini API TTS accepts expressive square-bracket audio tags in the text, such as
`[whispers]` or `[laughs]`. To keep tags out of the visible chat reply while
sending them to TTS, put them inside a `[[tts:text]]...[[/tts:text]]` block:

```text
Here is the clean reply text.

[[tts:text]][whispers] Here is the spoken version.[[/tts:text]]
```

<Note>
A Google Cloud Console API key restricted to the Gemini API is valid for this
provider. This is not the separate Cloud Text-to-Speech API path.
</Note>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Direct Gemini cache reuse">
    For direct Gemini API runs (`api: "google-generative-ai"`), OpenClaw
    passes a configured `cachedContent` handle through to Gemini requests.

    - Configure per-model or global params with either
      `cachedContent` or legacy `cached_content`
    - If both are present, `cachedContent` wins
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

  <Accordion title="Gemini CLI JSON usage notes">
    When using the `google-gemini-cli` OAuth provider, OpenClaw normalizes
    the CLI JSON output as follows:

    - Reply text comes from the CLI JSON `response` field.
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
