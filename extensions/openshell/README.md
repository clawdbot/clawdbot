# @openclaw/openshell-sandbox

Official NVIDIA OpenShell sandbox backend for OpenClaw.

This plugin lets OpenClaw use OpenShell-managed sandboxes with mirrored local workspaces and SSH command execution.

Configuring an OpenShell workspace requires OpenShell `v0.0.88` or newer. The
plugin supports OpenShell control-plane workspaces through
`plugins.entries.openshell.config.workspace`; this is separate from OpenClaw's
local/remote filesystem workspace mode. The setting applies to the whole plugin
instance, not individual agents or sessions. When unset, the plugin preserves
the OpenShell CLI's ambient `OPENSHELL_WORKSPACE` selection, or its `default`
fallback when no ambient selection exists.

## Install

```bash
openclaw plugins install @openclaw/openshell-sandbox
```

Restart the Gateway after installing or updating the plugin.

## Configure

Use the OpenShell docs for credentials, workspace mirroring, runtime selection, and troubleshooting:

- https://docs.openclaw.ai/gateway/openshell

## Package

- Plugin id: `openshell`
- Package: `@openclaw/openshell-sandbox`
- Minimum OpenClaw host: `2026.5.12-beta.1`
