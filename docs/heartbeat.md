---
summary: "Plan for heartbeat polling messages and notification rules"
read_when:
  - Adjusting heartbeat cadence or messaging
---
# Heartbeat (Gateway)

Heartbeat runs periodic agent turns in the **main session** so the model can
surface anything that needs attention without spamming the user.

## Prompt contract
- Heartbeat body defaults to `HEARTBEAT` (configurable via `agent.heartbeat.prompt`).
- If nothing needs attention, the model should reply `HEARTBEAT_OK`.
- During heartbeat runs, Clawdbot treats `HEARTBEAT_OK` as an ack when it appears at
  the **start or end** of the reply. Clawdbot strips the token and discards the
  reply if the remaining content is **≤ `ackMaxChars`** (default: 30).
- If `HEARTBEAT_OK` is in the **middle** of a reply, it is not treated specially.
- For alerts, do **not** include `HEARTBEAT_OK`; return only the alert text.

### Stray `HEARTBEAT_OK` outside heartbeats
If the model accidentally includes `HEARTBEAT_OK` at the start or end of a
normal (non-heartbeat) reply, Clawdbot strips the token and logs a verbose
message. If the reply is only `HEARTBEAT_OK`, it is dropped.

### Outbound normalization (all providers)
For **all providers** (WhatsApp/Web, Telegram, Slack, Discord, Signal, iMessage),
Clawdbot applies the same filtering to tool summaries, streaming block replies,
and final replies:
- drop payloads that are only `HEARTBEAT_OK` with no media
- strip `HEARTBEAT_OK` at the edges when mixed with other text

## Config

```json5
{
  agent: {
    heartbeat: {
      every: "30m",           // duration string: ms|s|m|h (0m disables)
      model: "anthropic/claude-opus-4-5",
      target: "last",          // last | whatsapp | telegram | none
      to: "+15551234567",      // optional override for whatsapp/telegram
      prompt: "HEARTBEAT",     // optional override
      ackMaxChars: 30          // max chars allowed after HEARTBEAT_OK
    }
  }
}
```

### Fields
- `every`: heartbeat interval (duration string; default unit minutes). Omit or set
  to `0m` to disable.
- `model`: optional model override for heartbeat runs (`provider/model`).
- `target`: where heartbeat output is delivered.
  - `last` (default): send to the last used external channel.
  - `whatsapp` / `telegram`: force the channel (optionally set `to`).
  - `none`: do not deliver externally; output stays in the session (WebChat-visible).
- `to`: optional recipient override (E.164 for WhatsApp, chat id for Telegram).
- `prompt`: optional override for the heartbeat body (default: `HEARTBEAT`).
- `ackMaxChars`: max chars allowed after `HEARTBEAT_OK` before delivery (default: 30).

## Behavior
- Runs in the main session (`main`, or `global` when scope is global).
- Uses the main lane queue; if requests are in flight, the wake is retried.
- Empty output or `HEARTBEAT_OK` is treated as “ok” and does **not** keep the
  session alive (`updatedAt` is restored).
- If `target` resolves to no external destination (no last route or `none`), the
  heartbeat still runs but no outbound message is sent.

## Wake hook
- The gateway exposes a heartbeat wake hook so cron/jobs/webhooks can request an
  immediate run (`requestHeartbeatNow`).
- `wake` endpoints should enqueue system events and optionally trigger a wake; the
  heartbeat runner picks those up on the next tick or immediately.
