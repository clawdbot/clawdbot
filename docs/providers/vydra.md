---
summary: "Use Vydra image, video, and speech in OpenClaw"
read_when:
  - You want Vydra media generation in OpenClaw
  - You need Vydra API key setup guidance
title: "Vydra"
---

The bundled Vydra plugin adds:

- Image generation via `vydra/grok-imagine`
- Video generation via `vydra/veo3` and `vydra/kling`
- Speech synthesis via Vydra's ElevenLabs-backed TTS route

OpenClaw uses the same `VYDRA_API_KEY` for all three capabilities.

| Property        | Value                                                                     |
| --------------- | ------------------------------------------------------------------------- |
| Provider id     | `vydra`                                                                   |
| Plugin          | bundled, `enabledByDefault: true`                                         |
| Auth env var    | `VYDRA_API_KEY`                                                           |
| Onboarding flag | `--auth-choice vydra-api-key`                                             |
| Direct CLI flag | `--vydra-api-key <key>`                                                   |
| Contracts       | `imageGenerationProviders`, `videoGenerationProviders`, `speechProviders` |
| Base URL        | `https://www.vydra.ai/api/v1` (use the `www` host)                        |

<Warning>
  Use `https://www.vydra.ai/api/v1` as the base URL. Vydra's apex host (`https://vydra.ai/api/v1`) currently redirects to `www`. Some HTTP clients drop `Authorization` on that cross-host redirect, which turns a valid API key into a misleading auth failure. The bundled plugin uses the `www` base URL directly to avoid that.
</Warning>

## Setup

<Steps>
  <Step title="Run interactive onboarding">
    ```bash
    openclaw onboard --auth-choice vydra-api-key
    ```

    Or set the env var directly:

    ```bash
    export VYDRA_API_KEY="vydra_live_..."
    ```

  </Step>
  <Step title="Choose a default capability">
    Pick one or more of the capabilities below (image, video, or speech) and apply the matching configuration.
  </Step>
</Steps>

## Capabilities

<AccordionGroup>
  <Accordion title="Image generation">
    Default image model:

    - `vydra/grok-imagine`

    Set it as the default image provider:

    ```json5
    {
      agents: {
        defaults: {
          imageGenerationModel: {
            primary: "vydra/grok-imagine",
          },
        },
      },
    }
    ```

    Current bundled support is text-to-image only. Vydra's hosted edit routes expect remote image URLs, and OpenClaw does not add a Vydra-specific upload bridge in the bundled plugin yet.

    <Note>
    See [Image Generation](/tools/image-generation) for shared tool parameters, provider selection, and failover behavior.
    </Note>

  </Accordion>

  <Accordion title="Video generation">
    Registered video models:

    - `vydra/veo3` for text-to-video
    - `vydra/kling` for image-to-video

    Set Vydra as the default video provider:

    ```json5
    {
      agents: {
        defaults: {
          videoGenerationModel: {
            primary: "vydra/veo3",
          },
        },
      },
    }
    ```

    Notes:

    - `vydra/veo3` is bundled as text-to-video only.
    - `vydra/kling` currently requires a remote image URL reference. Local file uploads are rejected up front.
    - Vydra's current `kling` HTTP route has been inconsistent about whether it requires `image_url` or `video_url`; the bundled provider maps the same remote image URL into both fields.
    - The bundled plugin stays conservative and does not forward undocumented style knobs such as aspect ratio, resolution, watermark, or generated audio.

    <Note>
    See [Video Generation](/tools/video-generation) for shared tool parameters, provider selection, and failover behavior.
    </Note>

  </Accordion>

  <Accordion title="Video live tests">
    Provider-specific live coverage:

    ```bash
    OPENCLAW_LIVE_TEST=1 \
    OPENCLAW_LIVE_VYDRA_VIDEO=1 \
    pnpm test:live -- extensions/vydra/vydra.live.test.ts
    ```

    The bundled Vydra live file now covers:

    - `vydra/veo3` text-to-video
    - `vydra/kling` image-to-video using a remote image URL

    Override the remote image fixture when needed:

    ```bash
    export OPENCLAW_LIVE_VYDRA_KLING_IMAGE_URL="https://example.com/reference.png"
    ```

  </Accordion>

  <Accordion title="Speech synthesis">
    Set Vydra as the speech provider:

    ```json5
    {
      messages: {
        tts: {
          provider: "vydra",
          providers: {
            vydra: {
              apiKey: "${VYDRA_API_KEY}",
              voiceId: "21m00Tcm4TlvDq8ikWAM",
            },
          },
        },
      },
    }
    ```

    Defaults:

    - Model: `elevenlabs/tts`
    - Voice id: `21m00Tcm4TlvDq8ikWAM`

    The bundled plugin currently exposes one known-good default voice and returns MP3 audio files.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Provider directory" href="/providers/index" icon="list">
    Browse all available providers.
  </Card>
  <Card title="Image generation" href="/tools/image-generation" icon="image">
    Shared image tool parameters and provider selection.
  </Card>
  <Card title="Video generation" href="/tools/video-generation" icon="video">
    Shared video tool parameters and provider selection.
  </Card>
  <Card title="Configuration reference" href="/gateway/config-agents#agent-defaults" icon="gear">
    Agent defaults and model configuration.
  </Card>
</CardGroup>
