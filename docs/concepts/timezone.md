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
| Message envelopes | Wraps inbound channel messages: `[Signal +1555 Sun 2026-01-18 00:19:42 PST] hello`                         | Host timezone if `userTimezone` unset | `agents.defaults.userTimezone`                         |
| Tool payloads     | Channel `readMessages`-style tools return raw provider time plus normalized `timestampMs` / `timestampUtc` | UTC fields always present             | Not configurable; preserves provider-native timestamps |
| System prompt     | A volatile `Temporal Context` block with the local date and time zone; exact time remains tool-backed      | Host timezone if `userTimezone` unset | `agents.defaults.userTimezone`                         |

The date and zone live below the system-prompt cache boundary, so day rollover does not invalidate the stable prefix. The prompt deliberately omits the live clock; when the agent needs exact current time and `session_status` is available, it calls that tool.

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

If `userTimezone` is unset, OpenClaw resolves the host timezone at runtime via
`Intl.DateTimeFormat().resolvedOptions().timeZone` without writing config. The same
resolved zone is used for message envelopes, queued system events, the prompt's local
date, and heartbeat active hours.

Clock rendering follows the host operating-system and locale preference. There is no
separate 12-hour or 24-hour config setting.

For provider examples and elapsed-time formatting, see [Date & Time](/date-time).

## Related

- [Date & Time](/date-time) - full envelope/tool/prompt behavior and examples.
- [Heartbeat](/gateway/heartbeat) - active hours use timezone for scheduling.
- [Cron Jobs](/automation/cron-jobs) - cron expressions use timezone for scheduling.
