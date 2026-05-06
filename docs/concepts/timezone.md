---
summary: "Where timezones show up in OpenClaw — envelopes, tool payloads, system prompt"
read_when:
  - You want a quick mental model for timezone handling
  - You are deciding where to set or override a timezone
title: "Timezones"
---

OpenClaw standardizes timestamps so the model sees a **single reference time** instead of a mix of provider-local clocks. There are three surfaces where timezones show up, each with its own purpose:

## Three timezone surfaces

| Surface           | What it shows                                                                                           | Default                               | Configured via                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| Message envelopes | Wraps inbound channel messages: `[Signal +1555 2026-01-18 00:19 PST] hello`                             | Host-local                            | `agents.defaults.envelopeTimezone`                      |
| Tool payloads     | Channel `readMessages`-style tools return raw provider time + normalized `timestampMs` / `timestampUtc` | UTC fields always present             | Not configurable — preserves provider-native timestamps |
| System prompt     | A small `Current Date & Time` block with the **time zone only** (no clock value, for cache stability)   | Host timezone if `userTimezone` unset | `agents.defaults.userTimezone`                          |

The system prompt deliberately omits the live clock to keep prompt caching stable across turns. When the agent needs the current time, it calls `session_status`.

## Setting the user timezone

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
    },
  },
}
```

If `userTimezone` is unset, OpenClaw resolves the host timezone at runtime (no config write). `agents.defaults.timeFormat` (`auto` | `12` | `24`) controls 12h/24h rendering in envelopes and downstream surfaces, not in the system prompt section.

## When to override

- **Use UTC envelopes** (`envelopeTimezone: "utc"`) when you want stable timestamps across hosts in different regions, or when you want UTC-aligned logs to match diagnostics output.
- **Use a fixed IANA zone** (e.g. `"Europe/Vienna"`) when the gateway host is in one zone but the user is in another and you want envelopes to read in the user's zone regardless of host migration.
- **Set `envelopeTimestamp: "off"`** for low-token envelopes when timestamp context is not useful for the conversation.

For the full behavior reference, examples per provider, and elapsed-time formatting, see [Date & Time](/date-time).

## Related

- [Date & Time](/date-time) — full envelope/tool/prompt behavior and examples.
- [Heartbeat](/gateway/heartbeat) — active hours use timezone for scheduling.
- [Cron Jobs](/automation/cron-jobs) — cron expressions use timezone for scheduling.
