---
title: "fal"
summary: "fal image and video generation setup in OpenClaw"
read_when:
  - You want to use fal image generation in OpenClaw
  - You need the FAL_KEY auth flow
  - You want fal defaults for image_generate or video_generate
---

# fal

OpenClaw ships a bundled `fal` provider for hosted image and video generation.

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

| Capability     | Value                      |
| -------------- | -------------------------- |
| Max images     | 4 per request              |
| Edit mode      | Enabled, 1 reference image |
| Size overrides | Supported                  |
| Aspect ratio   | Supported                  |
| Resolution     | Supported                  |

<Warning>
The fal image edit endpoint does **not** support `aspectRatio` overrides.
</Warning>

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

## Video generation

The bundled `fal` video-generation provider defaults to
`fal/fal-ai/minimax/video-01-live`.

| Capability | Value                                                        |
| ---------- | ------------------------------------------------------------ |
| Modes      | Text-to-video, single-image reference                        |
| Runtime    | Queue-backed submit/status/result flow for long-running jobs |

<AccordionGroup>
  <Accordion title="Available video models">
    **HeyGen video-agent:**

    - `fal/fal-ai/heygen/v2/video-agent`

    **Seedance 2.0:**

    - `fal/bytedance/seedance-2.0/fast/text-to-video`
    - `fal/bytedance/seedance-2.0/fast/image-to-video`
    - `fal/bytedance/seedance-2.0/text-to-video`
    - `fal/bytedance/seedance-2.0/image-to-video`

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
  <Card title="Configuration reference" href="/gateway/configuration-reference#agent-defaults" icon="gear">
    Agent defaults including image and video model selection.
  </Card>
</CardGroup>
