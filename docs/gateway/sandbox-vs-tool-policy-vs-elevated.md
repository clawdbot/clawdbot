---
title: Sandbox vs Tool Policy vs Elevated
summary: "Why a tool is blocked: sandbox runtime, tool allow/deny policy, and elevated bash gates"
read_when: "You hit 'sandbox jail' or see a tool/elevated refusal and want the exact config key to change."
status: active
---

# Sandbox vs Tool Policy vs Elevated

Clawdbot has three related (but different) controls:

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) decides **where tools run** (Docker vs host).
2. **Tool policy** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) decides **which tools are available/allowed**.
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) is a **bash-only escape hatch** to run on the host when you’re sandboxed.

## Quick debug

Use the inspector to see what Clawdbot is *actually* doing:

```bash
clawdbot sandbox explain
clawdbot sandbox explain --session agent:main:main
clawdbot sandbox explain --agent work
clawdbot sandbox explain --json
```

It prints:
- effective sandbox mode/scope/workspace access
- whether the session is currently sandboxed (main vs non-main)
- effective sandbox tool allow/deny (and whether it came from agent/global/default)
- elevated gates and fix-it key paths

## Sandbox: where tools run

Sandboxing is controlled by `agents.defaults.sandbox.mode`:
- `"off"`: everything runs on the host.
- `"non-main"`: only non-main sessions are sandboxed (common “surprise” for groups/channels).
- `"all"`: everything is sandboxed.

See [Sandboxing](/gateway/sandboxing) for the full matrix (scope, workspace mounts, images).

## Tool policy: which tools exist/are callable

Two layers matter:
- **Global/per-agent tool policy**: `tools.allow`/`tools.deny` and `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Sandbox tool policy** (only applies when sandboxed): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` and `agents.list[].tools.sandbox.tools.*`

Rules of thumb:
- `deny` always wins.
- If `allow` is non-empty, everything else is treated as blocked.

## Elevated: bash-only “run on host”

Elevated does **not** grant extra tools; it only affects `bash`.
- If you’re sandboxed, `/elevated on` (or `bash` with `elevated: true`) runs on the host.
- If you’re already running direct, elevated is effectively a no-op (still gated).

Gates:
- Enablement: `tools.elevated.enabled` (and optionally `agents.list[].tools.elevated.enabled`)
- Sender allowlists: `tools.elevated.allowFrom.<provider>` (and optionally `agents.list[].tools.elevated.allowFrom.<provider>`)

See [Elevated Mode](/tools/elevated).

## Common “sandbox jail” fixes

### “Tool X blocked by sandbox tool policy”

Fix-it keys (pick one):
- Disable sandbox: `agents.defaults.sandbox.mode=off` (or per-agent `agents.list[].sandbox.mode=off`)
- Allow the tool inside sandbox:
  - remove it from `tools.sandbox.tools.deny` (or per-agent `agents.list[].tools.sandbox.tools.deny`)
  - or add it to `tools.sandbox.tools.allow` (or per-agent allow)

### “I thought this was main, why is it sandboxed?”

In `"non-main"` mode, group/channel keys are *not* main. Use the main session key (shown by `sandbox explain`) or switch mode to `"off"`.

