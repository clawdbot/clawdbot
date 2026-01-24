---
summary: "Heartbeat polling messages and notification rules"
read_when:
  - Adjusting heartbeat cadence or messaging
  - Deciding between heartbeat and cron for scheduled tasks
---
# Heartbeat (Gateway)

> **Heartbeat vs Cron?** See [Cron vs Heartbeat](/automation/cron-vs-heartbeat) for guidance on when to use each.

Heartbeat runs **periodic agent turns** in the main session so the model can
surface anything that needs attention without spamming you.

## Quick start (beginner)

1. Leave heartbeats enabled (default is `30m`, or `1h` for Anthropic OAuth/setup-token) or set your own cadence.
2. Create a tiny `HEARTBEAT.md` checklist in the agent workspace (optional but recommended).
3. Decide where heartbeat messages should go (`target: "last"` is the default).
4. Optional: enable heartbeat reasoning delivery for transparency.
5. Optional: restrict heartbeats to active hours (local time).

Example config:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      }
    }
  }
}
```

## Defaults

- Interval: `30m` (or `1h` when Anthropic OAuth/setup-token is the detected auth mode). Set `agents.defaults.heartbeat.every` or per-agent `agents.list[].heartbeat.every`; use `0m` to disable.
- Prompt body (configurable via `agents.defaults.heartbeat.prompt`):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- The heartbeat prompt is sent **verbatim** as the user message. The system
  prompt includes a “Heartbeat” section and the run is flagged internally.
- Active hours (`heartbeat.activeHours`) are checked in the configured timezone.
  Outside the window, heartbeats are skipped until the next tick inside the window.

## What the heartbeat prompt is for

The default prompt is intentionally broad:
- **Background tasks**: “Consider outstanding tasks” nudges the agent to review
  follow-ups (inbox, calendar, reminders, queued work) and surface anything urgent.
- **Human check-in**: “Checkup sometimes on your human during day time” nudges an
  occasional lightweight “anything you need?” message, but avoids night-time spam
  by using your configured local timezone (see [/concepts/timezone](/concepts/timezone)).

If you want a heartbeat to do something very specific (e.g. “check Gmail PubSub
stats” or “verify gateway health”), set `agents.defaults.heartbeat.prompt` (or
`agents.list[].heartbeat.prompt`) to a custom body (sent verbatim).

## Response contract

- If nothing needs attention, reply with **`HEARTBEAT_OK`**.
- During heartbeat runs, Clawdbot treats `HEARTBEAT_OK` as an ack when it appears
  at the **start or end** of the reply. The token is stripped and the reply is
  dropped if the remaining content is **≤ `ackMaxChars`** (default: 300).
- If `HEARTBEAT_OK` appears in the **middle** of a reply, it is not treated
  specially.
- For alerts, **do not** include `HEARTBEAT_OK`; return only the alert text.

Outside heartbeats, stray `HEARTBEAT_OK` at the start/end of a message is stripped
and logged; a message that is only `HEARTBEAT_OK` is dropped.

## Config

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",           // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-5",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last",         // last | whatsapp | telegram | discord | slack | signal | imessage | none
        to: "+15551234567",     // optional channel-specific override
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300         // max chars allowed after HEARTBEAT_OK
      }
    }
  }
}
```

### Per-agent heartbeats

If any `agents.list[]` entry includes a `heartbeat` block, **only those agents**
run heartbeats. The per-agent block merges on top of `agents.defaults.heartbeat`
(so you can set shared defaults once and override per agent).

Example: two agents, only the second agent runs heartbeats.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last"
      }
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK."
        }
      }
    ]
  }
}
```

### Field notes

- `every`: heartbeat interval (duration string; default unit = minutes).
- `model`: optional model override for heartbeat runs (`provider/model`).
- `includeReasoning`: when enabled, also deliver the separate `Reasoning:` message when available (same shape as `/reasoning on`).
- `session`: optional session key for heartbeat runs.
  - `main` (default): agent main session.
  - Explicit session key (copy from `clawdbot sessions --json` or the [sessions CLI](/cli/sessions)).
  - Session key formats: see [Sessions](/concepts/session) and [Groups](/concepts/groups).
- `target`:
  - `last` (default): deliver to the last used external channel.
  - explicit channel: `whatsapp` / `telegram` / `discord` / `slack` / `msteams` / `signal` / `imessage`.
  - `none`: run the heartbeat but **do not deliver** externally.
- `to`: optional recipient override (channel-specific id, e.g. E.164 for WhatsApp or a Telegram chat id).
- `prompt`: overrides the default prompt body (not merged).
- `ackMaxChars`: max chars allowed after `HEARTBEAT_OK` before delivery.

## Delivery behavior

- Heartbeats run in the agent’s main session by default (`agent:<id>:<mainKey>`),
  or `global` when `session.scope = "global"`. Set `session` to override to a
  specific channel session (Discord/WhatsApp/etc.).
- `session` only affects the run context; delivery is controlled by `target` and `to`.
- To deliver to a specific channel/recipient, set `target` + `to`. With
  `target: "last"`, delivery uses the last external channel for that session.
- If the main queue is busy, the heartbeat is skipped and retried later.
- If `target` resolves to no external destination, the run still happens but no
  outbound message is sent.
- Heartbeat-only replies do **not** keep the session alive; the last `updatedAt`
  is restored so idle expiry behaves normally.

## Visibility controls

By default, `HEARTBEAT_OK` acknowledgments are suppressed while alert content is
delivered. You can adjust this per channel or per account:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false      # Hide HEARTBEAT_OK (default)
      showAlerts: true   # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true       # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

Precedence: per-account → per-channel → channel defaults → built-in defaults.

## HEARTBEAT.md (optional)

If a `HEARTBEAT.md` file exists in the workspace, the default prompt tells the
agent to read it. Think of it as your “heartbeat checklist”: small, stable, and
safe to include every 30 minutes.

If `HEARTBEAT.md` exists but is effectively empty (only blank lines and markdown
headers like `# Heading`), Clawdbot skips the heartbeat run to save API calls.
If the file is missing, the heartbeat still runs and the model decides what to do.

Keep it tiny (short checklist or reminders) to avoid prompt bloat.

Example `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down *what is missing* and ask Peter next time.
```

### Can the agent update HEARTBEAT.md?

Yes — if you ask it to.

`HEARTBEAT.md` is just a normal file in the agent workspace, so you can tell the
agent (in a normal chat) something like:
- “Update `HEARTBEAT.md` to add a daily calendar check.”
- “Rewrite `HEARTBEAT.md` so it’s shorter and focused on inbox follow-ups.”

If you want this to happen proactively, you can also include an explicit line in
your heartbeat prompt like: “If the checklist becomes stale, update HEARTBEAT.md
with a better one.”

Safety note: don’t put secrets (API keys, phone numbers, private tokens) into
`HEARTBEAT.md` — it becomes part of the prompt context.

## Manual wake (on-demand)

You can enqueue a system event and trigger an immediate heartbeat with:

```bash
clawdbot system event --text "Check for urgent follow-ups" --mode now
```

If multiple agents have `heartbeat` configured, a manual wake runs each of those
agent heartbeats immediately.

Use `--mode next-heartbeat` to wait for the next scheduled tick.

## Reasoning delivery (optional)

By default, heartbeats deliver only the final “answer” payload.

If you want transparency, enable:
- `agents.defaults.heartbeat.includeReasoning: true`

When enabled, heartbeats will also deliver a separate message prefixed
`Reasoning:` (same shape as `/reasoning on`). This can be useful when the agent
is managing multiple sessions/codexes and you want to see why it decided to ping
you — but it can also leak more internal detail than you want. Prefer keeping it
off in group chats.

## Cost awareness

Heartbeats run full agent turns. Shorter intervals burn more tokens. Keep
`HEARTBEAT.md` small and consider a cheaper `model` or `target: "none"` if you
only want internal state updates.
