---
summary: "Alibaba Model Studio Wan video generation in OpenClaw"
title: "Alibaba Model Studio"
read_when:
  - You want to use Alibaba Wan video generation in OpenClaw
  - You need Model Studio or DashScope API key setup for video generation
---

OpenClaw ships a bundled `alibaba` video-generation provider for Wan models on
Alibaba Model Studio / DashScope.

- Provider: `alibaba`
- Preferred auth: `MODELSTUDIO_API_KEY`
- Also accepted: `DASHSCOPE_API_KEY`, `QWEN_API_KEY`
- API: DashScope / Model Studio async video generation

## Getting started

<Steps>
  <Step title="Set an API key">
    ```bash
    openclaw onboard --auth-choice qwen-standard-api-key
    ```
  </Step>
  <Step title="Set a default video model">
    ```json5
    {
      agents: {
        defaults: {
          videoGenerationModel: {
            primary: "alibaba/wan2.6-t2v",
          },
        },
      },
    }
    ```
  </Step>
  <Step title="Verify the provider is available">
    ```bash
    openclaw models list --provider alibaba
    ```
  </Step>
</Steps>

<Note>
Any of the accepted auth keys (`MODELSTUDIO_API_KEY`, `DASHSCOPE_API_KEY`, `QWEN_API_KEY`) will work. The `qwen-standard-api-key` onboarding choice configures the shared DashScope credential.
</Note>

## Built-in Wan models

The bundled `alibaba` provider currently registers:

| Model ref                  | Mode                      |
| -------------------------- | ------------------------- |
| `alibaba/wan2.6-t2v`       | Text-to-video             |
| `alibaba/wan2.6-i2v`       | Image-to-video            |
| `alibaba/wan2.6-r2v`       | Reference-to-video        |
| `alibaba/wan2.6-r2v-flash` | Reference-to-video (fast) |
| `alibaba/wan2.7-r2v`       | Reference-to-video        |

## Current limits

| Parameter             | Limit                                                     |
| --------------------- | --------------------------------------------------------- |
| Output videos         | Up to **1** per request                                   |
| Input images          | Up to **1**                                               |
| Input videos          | Up to **4**                                               |
| Duration              | Up to **10 seconds**                                      |
| Supported controls    | `size`, `aspectRatio`, `resolution`, `audio`, `watermark` |
| Reference image/video | Remote `http(s)` URLs only                                |

<Warning>
Reference image/video mode currently requires **remote http(s) URLs**. Local file paths are not supported for reference inputs.
</Warning>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Relationship to Qwen">
    The bundled `qwen` provider also uses Alibaba-hosted DashScope endpoints for
    Wan video generation. Use:

    - `qwen/...` when you want the canonical Qwen provider surface
    - `alibaba/...` when you want the direct vendor-owned Wan video surface

    See the [Qwen provider docs](/providers/qwen) for more detail.

  </Accordion>

  <Accordion title="Auth key priority">
    OpenClaw checks for auth keys in this order:

    1. `MODELSTUDIO_API_KEY` (preferred)
    2. `DASHSCOPE_API_KEY`
    3. `QWEN_API_KEY`

    Any of these will authenticate the `alibaba` provider.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Video generation" href="/tools/video-generation" icon="video">
    Shared video tool parameters and provider selection.
  </Card>
  <Card title="Qwen" href="/providers/qwen" icon="microchip">
    Qwen provider setup and DashScope integration.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference#agent-defaults" icon="gear">
    Agent defaults and model configuration.
  </Card>
</CardGroup>
