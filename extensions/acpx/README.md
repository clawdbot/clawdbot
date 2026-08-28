# @openclaw/acpx

Official ACP runtime backend for OpenClaw.

ACPx lets OpenClaw run external coding harnesses through the Agent Client Protocol while OpenClaw still owns sessions, channels, delivery, permissions, and Gateway state.

## Install

```bash
openclaw plugins install @openclaw/acpx
```

Restart the Gateway after installing or updating the plugin.

## What it provides

- ACP-backed agent runtime sessions.
- Plugin-owned session and transport management.
- MCP bridge helpers for OpenClaw tools and plugin tools.
- Static runtime assets used by the ACP process bridge.

## Permission prompts

The default `permissionMode: "approve-reads"` auto-approves ACP reads. Absent
`nonInteractivePermissions` still resolves to `fail` for compatibility with
existing ACPX installs. Set `nonInteractivePermissions: "plugin"` explicitly to
route write, execute, and other side-effect prompts through OpenClaw plugin
approvals. The originating chat can then resolve the pending ACP request with
native approval buttons or `/approve <id> allow-once|allow-always|deny`, limited
to the decisions the harness advertised for that request.

Enable and route `approvals.plugin` for the target channel. Host exec approvals
and channel exec approvers are separate and do not authorize ACPX plugin
approvals. `permissionMode: "approve-all"` remains available as an explicit
no-prompt mode.

See
https://docs.openclaw.ai/plugins/plugin-permission-requests#acp-harness-permissions.

## Configure

Use the ACP docs for harness-specific setup, permission modes, and model/runtime selection:

- https://docs.openclaw.ai/tools/acp-agents-setup
- https://docs.openclaw.ai/tools/acp-agents

## Package

- Plugin id: `acpx`
- Package: `@openclaw/acpx`
- Minimum OpenClaw host: `2026.4.25`
