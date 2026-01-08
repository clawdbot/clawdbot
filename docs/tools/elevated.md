---
summary: "Elevated bash mode and /elevated directives"
read_when:
  - Adjusting elevated mode defaults, allowlists, or slash command behavior
---
# Elevated Mode (/elevated directives)

## What it does
- Elevated mode allows the bash tool to run with elevated privileges when the feature is available and the sender is approved.
- Directive forms: `/elevated on`, `/elevated off`, `/elev on`, `/elev off`.
- Only `on|off` are accepted; anything else returns a hint and does not change state.

## Resolution order
1. Inline directive on the message (applies only to that message).
2. Session override (set by sending a directive-only message).
3. Global default (`agent.elevatedDefault` in config).

## Setting a session default
- Send a message that is **only** the directive (whitespace allowed), e.g. `/elevated on`.
- Confirmation reply is sent (`Elevated mode enabled.` / `Elevated mode disabled.`).
- If elevated access is disabled or the sender is not on the approved allowlist, the directive replies `elevated is not available right now.` and does not change session state.
- Send `/elevated` (or `/elevated:`) with no argument to see the current elevated level.

## Availability + allowlists
- Feature gate: `agent.elevated.enabled` (default can be off via config even if the code supports it).
- Sender allowlist: `agent.elevated.allowFrom` with per-provider allowlists (e.g. `discord`, `whatsapp`).
- Both must pass; otherwise elevated is treated as unavailable.
- Discord fallback: if `agent.elevated.allowFrom.discord` is omitted, the `discord.dm.allowFrom` list is used as a fallback. Set `agent.elevated.allowFrom.discord` (even `[]`) to override.

## Logging + status
- Elevated bash calls are logged at info level.
- Session status includes elevated mode (e.g. `elevated=on`).
