# @openclaw/pixverse-provider

Official PixVerse video generation provider plugin for OpenClaw.

This plugin registers PixVerse as a `video_generate` provider for text-to-video and image-to-video workflows.

## Install

```bash
openclaw plugins install @openclaw/pixverse-provider
```

Restart the Gateway after installing or updating the plugin.

## Configure

Store your PixVerse API key in OpenClaw config or expose the supported environment variable to the Gateway. Then select PixVerse as a video generation provider.

Full setup and model/provider examples:

- https://docs.openclaw.ai/providers/pixverse

## Package

- Plugin id: `pixverse`
- Package: `@openclaw/pixverse-provider`
- Minimum OpenClaw host: `2026.5.26`
