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

- Provider: `fal`
- Auth: `FAL_KEY` (canonical; `FAL_API_KEY` also works as a fallback)
- API: fal model endpoints

## Quick start

1. Set the API key:

```bash
openclaw onboard --auth-choice fal-api-key
```

2. Set a default image model:

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

## Image generation

The bundled `fal` image-generation provider defaults to
`fal/fal-ai/flux/dev`.

- Generate: up to 4 images per request
- Edit mode: enabled, 1 reference image
- Supports `size`, `aspectRatio`, and `resolution`
- Current edit caveat: the fal image edit endpoint does **not** support
  `aspectRatio` overrides

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

- Modes: text-to-video and single-image reference flows
- Runtime: queue-backed submit/status/result flow for long-running jobs
- HeyGen video-agent model ref:
  - `fal/fal-ai/heygen/v2/video-agent`
- Seedance 2.0 model refs:
  - `fal/bytedance/seedance-2.0/fast/text-to-video`
  - `fal/bytedance/seedance-2.0/fast/image-to-video`
  - `fal/bytedance/seedance-2.0/text-to-video`
  - `fal/bytedance/seedance-2.0/image-to-video`

To use Seedance 2.0 as the default video model:

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

To use HeyGen video-agent as the default video model:

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

## Related

- [Image Generation](/tools/image-generation)
- [Video Generation](/tools/video-generation)
- [Configuration Reference](/gateway/configuration-reference#agent-defaults)
