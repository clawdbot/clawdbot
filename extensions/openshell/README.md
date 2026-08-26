# @openclaw/openshell-sandbox

Official NVIDIA OpenShell sandbox backend for OpenClaw.

This plugin lets OpenClaw use OpenShell-managed local or remote sandboxes with
SSH command execution. Choose `mirror` mode for a synchronized local workspace
or `remote` mode for a remote-canonical workspace.

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

Install and configure the OpenShell CLI before enabling the backend. As the same
operating system user that runs the OpenClaw Gateway, verify:

```bash
openshell --version
openshell gateway list
openshell sandbox list
```

Set `agents.defaults.sandbox.backend` to `"openshell"`, enable
`plugins.entries.openshell`, and restart the OpenClaw Gateway. OpenShell
settings belong under `plugins.entries.openshell.config`.

The optional `policy` setting must be the path to a readable OpenShell policy
YAML file on the Gateway host; it is not a policy name or ID. Use an absolute
path to avoid resolving it relative to an agent workspace.

Use the OpenShell docs for credentials, workspace mirroring, runtime selection, and troubleshooting:

- https://docs.openclaw.ai/gateway/openshell

## Package

- Plugin id: `openshell`
- Package: `@openclaw/openshell-sandbox`
- Minimum OpenClaw host: `2026.5.12-beta.1`
