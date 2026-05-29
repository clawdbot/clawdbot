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

| Property | Value                                                         |
| -------- | ------------------------------------------------------------- |
| Provider | `fal`                                                         |
| Auth     | `FAL_KEY` (canonical; `FAL_API_KEY` also works as a fallback) |
| API      | fal model endpoints                                           |

## Getting started

<Steps>
  <Step title="Set the API key">
    ```bash
    openclaw onboard --auth-choice fal-api-key
    ```
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
| Edit mode      | Flux: 1 reference image; GPT Image 2: 10; Nano Banana 2: 14        |
| Style refs     | Krea 2: up to 10 style references via `image` / `images`           |
| Size overrides | Supported                                                          |
| Aspect ratio   | Supported for generate, Krea 2, and GPT Image 2/Nano Banana 2 edit |
| Resolution     | Supported                                                          |
| Output format  | `png` or `jpeg`                                                    |

<Warning>
Flux image-to-image requests do **not** support `aspectRatio` overrides. GPT
Image 2 and Nano Banana 2 edit requests use fal's `/edit` endpoint and accept
aspect-ratio hints. Nano Banana 2 also accepts extra-native wide/tall ratios
such as `4:1`, `1:4`, `8:1`, and `1:8`; Krea 2 validates its own smaller
aspect-ratio subset.
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

To use fal as the default image provider:

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

<AccordionGroup>
  <Accordion title="Available video models">
    **HeyGen video-agent:**

    - `fal/fal-ai/heygen/v2/video-agent`

    **Seedance 2.0:**

    - `fal/bytedance/seedance-2.0/fast/text-to-video`
    - `fal/bytedance/seedance-2.0/fast/image-to-video`
    - `fal/bytedance/seedance-2.0/fast/reference-to-video`
    - `fal/bytedance/seedance-2.0/text-to-video`
    - `fal/bytedance/seedance-2.0/image-to-video`
    - `fal/bytedance/seedance-2.0/reference-to-video`

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
    parameters, with at most 12 total reference files.

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

| Capability    | Value                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Default model | `fal/fal-ai/minimax-music/v2.6`                                                                        |
| Models        | `fal-ai/minimax-music/v2.6`, `fal-ai/ace-step/prompt-to-audio`, `fal-ai/stable-audio-25/text-to-audio` |
| Runtime       | Synchronous request plus generated audio download                                                      |

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

`fal-ai/minimax-music/v2.6` supports explicit lyrics and instrumental mode.
ACE-Step and Stable Audio are prompt-to-audio endpoints; choose them with the
`model` override when you want those model families.

<Tip>
Use `openclaw models list --provider fal` to see the full list of available fal
models, including any recently added entries.
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
