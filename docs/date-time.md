---
summary: "Date and time handling across envelopes, prompts, tools, and connectors"
read_when:
  - You are changing how timestamps are shown to the model or users
  - You are debugging time formatting in messages or system prompt output
title: "Date and time"
---

OpenClaw uses **host-local time for transport timestamps** and puts **only the time zone** in the system prompt.
Provider timestamps are preserved so tools keep their native semantics. When the agent needs the current
time, it runs the `session_status` tool.

## Message envelopes (local by default)

Inbound messages are wrapped with a weekday plus second-precision timestamp:

```
[WhatsApp +1555 Mon 2026-01-05 16:26:34 PST] message text
```

The envelope timestamp is **host-local by default**, regardless of the provider timezone.
Override under `agents.defaults`:

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

| Key                 | Values                                               | Behavior                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `envelopeTimezone`  | `local` (default), `utc`, `user`, explicit IANA name | `user` uses `agents.defaults.userTimezone` (host timezone when unset). An explicit IANA name (e.g. `"America/Chicago"`) pins a fixed zone; unrecognized names fall back to UTC. |
| `envelopeTimestamp` | `on` (default), `off`                                | `off` removes absolute timestamps from envelope headers, direct agent prompt prefixes, and embedded model-input prefixes.                                                       |
| `envelopeElapsed`   | `on` (default), `off`                                | `off` removes the elapsed-time suffix (the `+30s` / `+2m` style) shown since the previous message in the session.                                                               |

### Examples

**Local (default):**

```
[WhatsApp +1555 Sun 2026-01-18 00:19:42 PST] hello
```

**User timezone:**

```
[WhatsApp +1555 Sun 2026-01-18 00:19:42 CST] hello
```

**Elapsed time with `envelopeTimezone: "utc"`:**

```
[WhatsApp +1555 +30s Sun 2026-01-18T05:19:00Z] follow-up
```

## System prompt: time zone

If the user timezone is known, the system prompt includes a dedicated
**Time Zone** section with the **time zone only** (no clock/time format)
to keep prompt caching stable:

```
Time zone: America/Chicago
```

The zone is `agents.defaults.userTimezone` when configured, otherwise the host timezone.
The prompt also instructs the agent to run the `session_status` tool whenever it needs the
current date, time, or day of week.

## System event lines (local by default)

Queued system events inserted into agent context are prefixed with a timestamp using the
same `envelopeTimezone` selection as message envelopes (default: host-local).

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### Configure user timezone + format

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
      timeFormat: "auto", // auto | 12 | 24
    },
  },
}
```

- `userTimezone` sets the **user-local timezone** for prompt context (and for `envelopeTimezone: "user"`).
- `timeFormat` controls **12h/24h display** in prompt-facing times. `auto` follows OS preferences.

## Time format detection (auto)

When `timeFormat: "auto"`, OpenClaw inspects the OS preference (macOS and Windows)
and falls back to locale formatting. The detected value is **cached per process**
to avoid repeated system calls.

## Tool payloads + connectors (raw provider time + normalized fields)

Channel tools return **provider-native timestamps** and add normalized fields for consistency:

- `timestampMs`: epoch milliseconds (UTC)
- `timestampUtc`: ISO 8601 UTC string

Raw provider fields are preserved so nothing is lost.

- Discord: UTC ISO timestamps
- Slack: epoch-like strings from the API
- Telegram/WhatsApp: provider-specific numeric/ISO timestamps

If you need local time, convert it downstream using the known timezone.

## Related docs

- [System Prompt](/concepts/system-prompt)
- [Timezones](/concepts/timezone)
- [Messages](/concepts/messages)
