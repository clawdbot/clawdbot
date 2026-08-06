---
summary: "fal image, video, and music generation setup in OpenClaw"
title: "Fal"
read_when:
  - You want to use fal image generation in OpenClaw
  - You need the FAL_KEY auth flow
  - You want fal defaults for image_generate, video_generate, or music_generate
---

OpenClaw ships a bundled `fal` provider for hosted image, video, and music
generation.

| Property | Value                                                                           |
| -------- | ------------------------------------------------------------------------------- |
| Provider | `fal`                                                                           |
| Auth     | `FAL_KEY` (canonical; `FAL_API_KEY` also works as a fallback)                   |
| API      | fal model endpoints (`https://fal.run`; video jobs use `https://queue.fal.run`) |
| Base URL | Override with `models.providers.fal.baseUrl`                                    |

## Getting started

<Steps>
  <Step title="Set the API key">
    ```bash
    openclaw onboard --auth-choice fal-api-key
    ```

    Non-interactive setups can pass `--fal-api-key <key>` or export `FAL_KEY`.
    Onboarding also sets `fal/fal-ai/flux/dev` as the default image model when
    none is configured.

  </Step>
  <Step title="Set a default image model">
    ```json5
    {
      agents: {
        defaults: {
          imageGenerationModel: {
            primary: "fal/fal-ai/flux/dev",
          },
        },
      },
    }
    ```
  </Step>
</Steps>

## Image generation

The bundled `fal` image-generation provider defaults to
`fal/fal-ai/flux/dev`.

| Capability     | Value                                                              |
| -------------- | ------------------------------------------------------------------ |
| Max images     | 4 per request; Krea 2: 1 per request                               |
| Size overrides | `1024x1024`, `1024x1536`, `1536x1024`, `1024x1792`, `1792x1024`    |
| Aspect ratio   | Supported everywhere except Flux image-to-image                    |
| Resolution     | `1K`, `2K`, `4K` (per-model limits below)                          |
| Output format  | `png` (default) or `jpeg`; Krea 2 rejects `outputFormat` overrides |

Edit requests (reference images via the shared `image` / `images` parameters)
route to a per-model edit endpoint with per-model reference limits:

| Model family              | Model ref after `fal/`                 | Edit endpoint     | Max reference images |
| ------------------------- | -------------------------------------- | ----------------- | -------------------- |
| Flux and other fal models | `fal-ai/flux/dev` (default)            | `/image-to-image` | 1                    |
| GPT Image                 | `openai/gpt-image-*`                   | `/edit`           | 10                   |
| Grok Imagine              | `xai/grok-imagine-image`               | `/edit`           | 3                    |
| Nano Banana (legacy)      | `fal-ai/nano-banana`                   | `/edit`           | 3                    |
| Nano Banana 2             | `fal-ai/nano-banana-*`                 | `/edit`           | 14                   |
| Nano Banana 2 Lite        | `google/nano-banana-2-lite`            | `/edit`           | 14                   |
| Krea 2                    | `krea/v2/{medium,large}/text-to-image` | none (style refs) | 10 style references  |

<Warning>
Flux image-to-image requests do **not** support `aspectRatio` overrides. GPT
Image and Nano Banana 2 edit requests use fal's `/edit` endpoint and accept
aspect-ratio hints. Nano Banana 2 also accepts extra-native wide/tall ratios
such as `4:1`, `1:4`, `8:1`, and `1:8`; Krea 2 validates its own smaller
aspect-ratio subset. Grok Imagine has its own ratio list (including `2:1`,
`20:9`, `19.5:9`, and their inverses) and only accepts `1K`/`2K` resolutions;
legacy Nano Banana and Nano Banana 2 Lite reject `resolution` overrides.
</Warning>

Krea 2 models use fal's native Krea payload schema. OpenClaw sends
`aspect_ratio`, `creativity`, and `image_style_references` instead of the
generic `image_size` / edit-endpoint payload used by Flux. The model refs are:

- `fal/krea/v2/medium/text-to-image`
- `fal/krea/v2/large/text-to-image`

Use Medium for faster expressive illustration, anime, painting, and artistic
styles. Use Large for slower photoreal, raw texture, film grain, and detailed
looks. Krea defaults to `fal.creativity: "medium"`; supported values are
`raw`, `low`, `medium`, and `high`.

Krea 2 exposes aspect ratio, not `image_size`, in fal's request schema. Prefer
`aspectRatio`; OpenClaw maps `size` to the closest supported Krea aspect ratio
and rejects `resolution` for Krea rather than dropping it.

Use `outputFormat: "png"` when you want PNG output from fal models that expose
`output_format`. fal does not declare an explicit transparent-background
control in OpenClaw, so `background: "transparent"` is reported as an ignored
override for fal models.
Krea 2 endpoints do not expose an `output_format` request field through fal, so
OpenClaw rejects `outputFormat` overrides for Krea requests.

To use Krea 2 Medium:

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "fal/krea/v2/medium/text-to-image",
      },
    },
  },
}
```

## Video generation

The bundled `fal` video-generation provider defaults to
`fal/fal-ai/minimax/video-01-live`.

| Capability | Value                                                              |
| ---------- | ------------------------------------------------------------------ |
| Modes      | Text-to-video, single-image reference, Seedance reference-to-video |
| Runtime    | Queue-backed submit/status/result flow for long-running jobs       |
| Timeout    | 20 minutes per job by default; status polled every 5 seconds       |

<AccordionGroup>
  <Accordion title="Available video models">
    **MiniMax (default):**

    - `fal/fal-ai/minimax/video-01-live`

    **HeyGen video-agent:**

    - `fal/fal-ai/heygen/v2/video-agent`

    **Kling and Wan:**

    - `fal/fal-ai/kling-video/v2.1/master/text-to-video`
    - `fal/fal-ai/wan/v2.2-a14b/text-to-video`
    - `fal/fal-ai/wan/v2.2-a14b/image-to-video`

    **Seedance 2.0:**

    - `fal/bytedance/seedance-2.0/fast/text-to-video`
    - `fal/bytedance/seedance-2.0/fast/image-to-video`
    - `fal/bytedance/seedance-2.0/fast/reference-to-video`
    - `fal/bytedance/seedance-2.0/text-to-video`
    - `fal/bytedance/seedance-2.0/image-to-video`
    - `fal/bytedance/seedance-2.0/reference-to-video`

    MiniMax Live and HeyGen requests send only the prompt plus an optional
    single reference image; other overrides are not forwarded. Seedance models
    accept `aspectRatio`, `size`, `resolution`, durations of 4-15 seconds, and
    an audio toggle.

  </Accordion>

  <Accordion title="Seedance 2.0 config example">
    ```json5
    {
      agents: {
        defaults: {
          videoGenerationModel: {
            primary: "fal/bytedance/seedance-2.0/fast/text-to-video",
          },
        },
      },
    }
    ```
  </Accordion>

  <Accordion title="Seedance 2.0 reference-to-video config example">
    ```json5
    {
      agents: {
        defaults: {
          videoGenerationModel: {
            primary: "fal/bytedance/seedance-2.0/fast/reference-to-video",
          },
        },
      },
    }
    ```

    Reference-to-video accepts up to 9 images, 3 videos, and 3 audio references
    through the shared `video_generate` `images`, `videos`, and `audioRefs`
    parameters, with at most 12 total reference files. Audio references require
    at least one image or video reference in the same request.

  </Accordion>

  <Accordion title="HeyGen video-agent config example">
    ```json5
    {
      agents: {
        defaults: {
          videoGenerationModel: {
            primary: "fal/fal-ai/heygen/v2/video-agent",
          },
        },
      },
    }
    ```
  </Accordion>
</AccordionGroup>

## Music generation

The bundled `fal` plugin also registers a music-generation provider for the
shared `music_generate` tool.

| Capability    | Value                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Default model | `fal/fal-ai/minimax-music/v2.6`                                                                                          |
| Models        | `fal-ai/minimax-music/v2.6` (mp3), `fal-ai/ace-step/prompt-to-audio` (wav), `fal-ai/stable-audio-25/text-to-audio` (wav) |
| Max duration  | 240 seconds                                                                                                              |
| Runtime       | Synchronous request plus generated audio download                                                                        |

Use fal as the default music provider:

```json5
{
  agents: {
    defaults: {
      musicGenerationModel: {
        primary: "fal/fal-ai/minimax-music/v2.6",
      },
    },
  },
}
```

`fal-ai/minimax-music/v2.6` supports explicit lyrics and instrumental mode,
but not both in the same request. ACE-Step and Stable Audio are
prompt-to-audio endpoints; choose them with the `model` override when you want
those model families. ACE-Step rejects explicit lyrics; Stable Audio rejects
both lyrics and instrumental mode.

<Tip>
The tables and accordions above cover the model families the bundled fal
provider special-cases. Other fal image endpoint ids can still be selected as
the image model; they are treated like Flux (generic `image_size` payload, one
reference image via `/image-to-image`).
</Tip>

## Related

<CardGroup cols={2}>
  <Card title="Image generation" href="/tools/image-generation" icon="image">
    Shared image tool parameters and provider selection.
  </Card>
  <Card title="Video generation" href="/tools/video-generation" icon="video">
    Shared video tool parameters and provider selection.
  </Card>
  <Card title="Music generation" href="/tools/music-generation" icon="music">
    Shared music tool parameters and provider selection.
  </Card>
  <Card title="Configuration reference" href="/gateway/config-agents#agent-defaults" icon="gear">
    Agent defaults including image, video, and music model selection.
  </Card>
</CardGroup>
