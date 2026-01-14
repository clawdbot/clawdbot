---
summary: "Timezone handling for agents, envelopes, and prompts"
read_when:
  - You need to understand how timestamps are normalized for the model
  - Configuring the user timezone for system prompts
---

# Timezones

Clawdbot standardizes timestamps so the model sees a **single reference time**.

## Message envelopes (UTC)

Inbound messages are wrapped in an envelope like:

```
[Provider ... 2026-01-05T21:26Z] message text
```

The timestamp in the envelope is **always UTC**, with minutes precision.

## Tool payloads (raw provider data)

Tool calls (`channels.discord.readMessages`, `channels.slack.readMessages`, etc.) return **raw provider timestamps**.
These are typically UTC ISO strings (Discord) or UTC epoch strings (Slack). We do not rewrite them.

## User timezone for the system prompt

Set `agents.defaults.userTimezone` to tell the model the user's local time zone. If it is
unset, Clawdbot resolves the **host timezone at runtime** (no config write).

```json5
{
  agent: { userTimezone: "America/Chicago" }
}
```

The system prompt includes:
- `User timezone: America/Chicago`
- `Current user time: 2026-01-05 15:26`
