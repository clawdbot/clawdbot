# @openclaw/sbx-sandbox

Official Docker Sandboxes (`sbx`) sandbox backend for OpenClaw.

This plugin lets OpenClaw run tool `exec`, `read`, `write`, `edit`, and `apply_patch` calls inside `sbx`-managed sandbox containers, reusing `sbx`'s native bind-mounted workspaces (no upload/sync step required).

## Install

```bash
openclaw plugins install @openclaw/sbx-sandbox
```

Restart the Gateway after installing or updating the plugin.

## Configure

Use the sandboxing docs for backend selection and the dedicated sbx page for configuration reference and troubleshooting:

- https://docs.openclaw.ai/gateway/sandboxing
- https://docs.openclaw.ai/gateway/sbx

## Package

- Plugin id: `sbx`
- Package: `@openclaw/sbx-sandbox`
- Minimum OpenClaw host: `2026.6.2`
