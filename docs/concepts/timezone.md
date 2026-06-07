---
summary: "Where timezones show up in OpenClaw — envelopes, tool payloads, system prompt"
read_when:
  - You want a quick mental model for timezone handling
  - You are deciding where to set or override a timezone
title: "Timezones"
---

OpenClaw standardizes timestamps so the model sees a **single reference time** instead of a mix of provider-local clocks. Three surfaces show timezones, each with its own purpose:

## Three timezone surfaces

| Surface           | What it shows                                                                                              | Default                               | Configured via                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------ |
| Message envelopes | Wraps inbound channel messages: `[Signal +1555 Sun 2026-01-18 00:19:42 PST] hello`                         | Host-local                            | `agents.defaults.envelopeTimezone`                     |
| Tool payloads     | Channel `readMessages`-style tools return raw provider time plus normalized `timestampMs` / `timestampUtc` | UTC fields always present             | Not configurable; preserves provider-native timestamps |
| System prompt     | A small `Time Zone` block with the **time zone only** (no clock value, for cache stability)              | Host timezone if `userTimezone` unset | `agents.defaults.userTimezone`                          |

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

If `userTimezone` is unset, OpenClaw resolves the host timezone at runtime via `Intl.DateTimeFormat().resolvedOptions().timeZone` (no config write). `agents.defaults.timeFormat` (`auto` | `12` | `24`) controls 12h/24h rendering in envelopes and downstream surfaces, not in the system prompt section.

## Envelope timezone values

`agents.defaults.envelopeTimezone` accepts:

- `"local"` (default) or `"host"` - host machine's timezone.
- `"utc"` or `"gmt"` - UTC.
- `"user"` - the resolved `agents.defaults.userTimezone` (falls back to host timezone if unset).
- Any explicit IANA zone string, e.g. `"Europe/Vienna"`.

## When to override

- **Use `"utc"`** for stable timestamps across hosts in different regions, or to match UTC-aligned diagnostics/log output.
- **Use `"user"`** to keep envelopes aligned with the configured user timezone regardless of which zone the gateway host runs in.
- **Use a fixed IANA zone** when the gateway host is in one zone but the envelope should always read in another zone regardless of host migration.
- **Set `envelopeTimestamp: "off"`** when timestamp context is not useful for the conversation. This removes absolute timestamps from envelopes, direct agent prompt prefixes, and embedded model-input prefixes.

For the full behavior reference, examples per provider, and elapsed-time formatting, see [Date & Time](/date-time).

## Related

- [Date & Time](/date-time) - full envelope/tool/prompt behavior and examples.
- [Heartbeat](/gateway/heartbeat) - active hours use timezone for scheduling.
- [Cron Jobs](/automation/cron-jobs) - cron expressions use timezone for scheduling.
