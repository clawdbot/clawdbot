# @openclaw/comfy-provider

Official ComfyUI image, video, and music generation provider plugin for
OpenClaw.

## Install

```bash
openclaw plugins install @openclaw/comfy-provider
openclaw gateway restart
```

## Configure

Local ComfyUI workflows do not require credentials. Comfy Cloud workflows use
`COMFY_API_KEY` or `COMFY_CLOUD_API_KEY`.

Full workflow, model, and provider configuration:

- https://docs.openclaw.ai/providers/comfy

## Package

- Plugin id: `comfy`
- Package: `@openclaw/comfy-provider`
- Minimum OpenClaw host: `2026.7.2`
