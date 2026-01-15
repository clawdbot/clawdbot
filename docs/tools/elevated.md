---
summary: "Elevated exec mode and /elevated directives"
read_when:
  - Adjusting elevated mode defaults, allowlists, or slash command behavior
---
# Elevated Mode (/elevated directives)

## What it does
- Elevated mode allows the exec tool to run with elevated privileges when the feature is available and the sender is approved.
- The bash chat command (`!`; `/bash` alias) uses the same `tools.elevated` allowlists because it always runs on the host.
- **Optional for sandboxed agents**: elevated only changes behavior when the agent is running in a sandbox. If the agent already runs unsandboxed, elevated is effectively a no-op.
- Directive forms: `/elevated on`, `/elevated off`, `/elev on`, `/elev off`.
- Only `on|off` are accepted; anything else returns a hint and does not change state.

## What it controls (and what it doesn’t)
- **Availability gates**: `tools.elevated` is the global baseline. `agents.list[].tools.elevated` can further restrict elevated per agent (both must allow).
- **Per-session state**: `/elevated on|off` sets the elevated level for the current session key.
- **Inline directive**: `/elevated on` inside a message applies to that message only.
- **Groups**: In group chats, elevated directives are only honored when the agent is mentioned. Command-only messages that bypass mention requirements are treated as mentioned.
- **Host execution**: elevated runs `exec` on the host (bypasses sandbox).
- **Unsandboxed agents**: when there is no sandbox to bypass, elevated does not change where `exec` runs.
- **Tool policy still applies**: if `exec` is denied by tool policy, elevated cannot be used.
- **Not skill-scoped**: elevated cannot be limited to a specific skill; it only changes `exec` location.

Note:
- Sandbox on: `/elevated on` runs that `exec` command on the host.
- Sandbox off: `/elevated on` does not change execution (already on host).

## When elevated matters
- Only impacts `exec` when the agent is running sandboxed (it drops the sandbox for that command).
- For unsandboxed agents, elevated does not change execution; it only affects gating, logging, and status.

## Resolution order
1. Inline directive on the message (applies only to that message).
2. Session override (set by sending a directive-only message).
3. Global default (`agents.defaults.elevatedDefault` in config).

## Setting a session default
- Send a message that is **only** the directive (whitespace allowed), e.g. `/elevated on`.
- Confirmation reply is sent (`Elevated mode enabled.` / `Elevated mode disabled.`).
- If elevated access is disabled or the sender is not on the approved allowlist, the directive replies with an actionable error (runtime sandboxed/direct + failing config key paths) and does not change session state.
- Send `/elevated` (or `/elevated:`) with no argument to see the current elevated level.

## Availability + allowlists
- Feature gate: `tools.elevated.enabled` (default can be off via config even if the code supports it).
- Sender allowlist: `tools.elevated.allowFrom` with per-provider allowlists (e.g. `discord`, `whatsapp`).
- Per-agent gate: `agents.list[].tools.elevated.enabled` (optional; can only further restrict).
- Per-agent allowlist: `agents.list[].tools.elevated.allowFrom` (optional; when set, the sender must match **both** global + per-agent allowlists).
- Discord fallback: if `tools.elevated.allowFrom.discord` is omitted, the `channels.discord.dm.allowFrom` list is used as a fallback. Set `tools.elevated.allowFrom.discord` (even `[]`) to override. Per-agent allowlists do **not** use the fallback.
- All gates must pass; otherwise elevated is treated as unavailable.

## Logging + status
- Elevated exec calls are logged at info level.
- Session status includes elevated mode (e.g. `elevated=on`).
