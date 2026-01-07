---
summary: "Plan for heartbeat polling messages and notification rules"
read_when:
  - Adjusting heartbeat cadence or messaging
---
# Heartbeat (Gateway)

Heartbeat runs periodic agent turns in the **main session** so the model can
surface anything that needs attention without spamming the user.

## Defaults
- Interval: `30m` (set `agent.heartbeat.every` to change, `0m` disables).
- Prompt body (configurable via `agent.heartbeat.prompt`):
  `Read HEARTBEAT.md if exists. Consider outstanding tasks. Checkup sometimes on your human during (user local) day time.`
- Heartbeat prompt text is sent **verbatim** as the user message. Clawdbot does
  not append extra body text. The system prompt includes a Heartbeats section
  and the run is flagged as a heartbeat internally.

## Prompt contract
- If nothing needs attention, the model should reply `HEARTBEAT_OK`.
- During heartbeat runs, Clawdbot treats `HEARTBEAT_OK` as an ack when it appears at
  the **start or end** of the reply. Clawdbot strips the token and discards the
  reply if the remaining content is **≤ `ackMaxChars`** (default: 30).
- If `HEARTBEAT_OK` is in the **middle** of a reply, it is not treated specially.
- For alerts, do **not** include `HEARTBEAT_OK`; return only the alert text.

## Prompt overrides
- Overriding `agent.heartbeat.prompt` **replaces** the default body. Nothing is
  merged for you.
- If you still want `HEARTBEAT.md` instructions, keep a line like
  `Read HEARTBEAT.md if exists` in your custom prompt.
- `HEARTBEAT_OK` handling stays the same; changing the prompt won’t break acks.

### Stray `HEARTBEAT_OK` outside heartbeats
If the model accidentally includes `HEARTBEAT_OK` at the start or end of a
normal (non-heartbeat) reply, Clawdbot strips the token and logs a verbose
message. If the reply is only `HEARTBEAT_OK`, it is dropped.

### Outbound normalization (all providers)
For **all providers** (WhatsApp/Web, Telegram, Slack, Discord, Signal, iMessage, Matrix),
Clawdbot applies the same filtering to tool summaries, streaming block replies,
and final replies:
- drop payloads that are only `HEARTBEAT_OK` with no media
- strip `HEARTBEAT_OK` at the edges when mixed with other text

## Config

```json5
{
  agent: {
    heartbeat: {
      every: "30m",           // default: 30m (0m disables)
      model: "anthropic/claude-opus-4-5",
      target: "last",          // last | whatsapp | telegram | discord | slack | signal | imessage | matrix | none
      to: "+15551234567",      // optional provider-specific override (e.g. E.164 or chat id)
      prompt: "Read HEARTBEAT.md if exists. Consider outstanding tasks. Checkup sometimes on your human during (user local) day time.",
      ackMaxChars: 30          // max chars allowed after HEARTBEAT_OK
    }
  }
}
```

### Fields
- `every`: heartbeat interval (duration string; default unit minutes). Default:
  `30m`. Set to `0m` to disable.
- `model`: optional model override for heartbeat runs (`provider/model`).
- `target`: where heartbeat output is delivered.
  - `last` (default): send to the last used external provider.
  - `whatsapp` / `telegram` / `discord` / `slack` / `signal` / `imessage` / `matrix`: force the provider (optionally set `to`).
  - `none`: do not deliver externally; output stays in the session (WebChat-visible).
- `to`: optional recipient override (E.164 for WhatsApp, chat id for Telegram).
- `prompt`: optional override for the heartbeat body (default shown above). Safe to
  change; heartbeat acks are still keyed off `HEARTBEAT_OK`.
- `ackMaxChars`: max chars allowed after `HEARTBEAT_OK` before delivery (default: 30).

## Cost awareness
Heartbeats run full agent turns. Shorter intervals burn more tokens. Be
intentional about `every`, keep `HEARTBEAT.md` tiny, and consider a cheaper
`model` or `target: "none"` if you only want internal state updates.

## HEARTBEAT.md (optional)
If a `HEARTBEAT.md` file exists in the workspace, the default prompt tells the
agent to read it. Keep it tiny (short checklist or reminders) to avoid prompt
bloat.

## Behavior
- Runs in the main session (`main`, or `global` when scope is global).
- Uses the main lane queue; if requests are in flight, the wake is retried.
- Empty output or `HEARTBEAT_OK` is treated as “ok” and does **not** keep the
  session alive (`updatedAt` is restored).
- If `target` resolves to no external destination (no last route or `none`), the
  heartbeat still runs but no outbound message is sent.

## Ideas for use
- Check up on the user (light, respectful pings during daytime).
- Handle mundane tasks (triage inboxes, summarize queues, refresh notes).
- Nudge on open loops or reminders.
- Background monitoring (health checks, status polling, low-priority alerts).
- Scheduled routines (use [Cron jobs](/automation/cron-jobs) when you
  need exact schedules or isolated runs).

## Wake hook
- The gateway exposes a heartbeat wake hook so cron/jobs/webhooks can request an
  immediate run (`requestHeartbeatNow`).
- `wake` endpoints should enqueue system events and optionally trigger a wake; the
  heartbeat runner picks those up on the next tick or immediately.
