# @openclaw/openshell-sandbox

Official NVIDIA OpenShell sandbox backend for OpenClaw.

This plugin lets OpenClaw use OpenShell-managed sandboxes with mirrored local workspaces and SSH command execution.

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
