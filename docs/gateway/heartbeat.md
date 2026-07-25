---
summary: "Heartbeat polling messages and notification rules"
read_when:
  - Adjusting heartbeat cadence or messaging
  - Deciding between heartbeat and cron for scheduled tasks
title: "Heartbeat"
sidebarTitle: "Heartbeat"
---

<Note>
**Heartbeat vs cron?** See [Automation](/automation) for guidance on when to use each.
</Note>

Heartbeat runs **periodic agent turns** in the main session so the model can surface anything that needs attention without spamming you.

Heartbeat is a scheduled main-session turn - it does **not** create [background task](/automation/tasks) records. Task records are for detached work (ACP runs, subagents, isolated cron jobs).

Under the hood, heartbeat cadence is owned by the cron scheduler: the gateway maintains one system-owned cron job per heartbeat-enabled agent (visible in `openclaw cron list --all` as `Heartbeat (agent-id)`). Heartbeat config remains the desired-state input, while the persisted monitor schedule owns the actual tick and the runner's later cooldown. The gateway writes config changes through at startup and on config reload; `openclaw doctor --fix` can materialize missing or stale monitor rows before the next gateway start. Edit `agents.*.heartbeat`, not the cron job.

Scheduled heartbeats require cron. When `cron.enabled` is `false` or `OPENCLAW_SKIP_CRON=1`, the gateway logs a startup warning and does not run scheduled heartbeats; manual and event-driven heartbeat wakes remain available. There is no separate heartbeat fallback timer.

Troubleshooting: [Scheduled Tasks](/automation/cron-jobs#troubleshooting)

## Quick start (beginner)

<Steps>
  <Step title="Pick a cadence">
    Leave heartbeats enabled (default is `30m`, or `1h` when Anthropic OAuth/token auth is configured, including Claude CLI reuse) or set your own cadence.
  </Step>
  <Step title="Add monitor scratch (optional)">
    Store a tiny checklist in the heartbeat monitor's scratch with `openclaw cron scratch <jobId> --set "..."`.
  </Step>
  <Step title="Decide where heartbeat messages should go">
    `target: "none"` is the default; set `target: "last"` to route to the last contact.
  </Step>
  <Step title="Optional tuning">
    - Use lightweight bootstrap context if heartbeat runs only need the monitor scratch.
    - Enable isolated sessions to avoid sending full conversation history each heartbeat.
    - Restrict heartbeats to active hours (local time).

  </Step>
</Steps>

Example config:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last", // explicit delivery to last contact (default is "none")
        directPolicy: "allow", // default: allow direct/DM targets; set "block" to suppress
        lightContext: true, // optional: skip workspace bootstrap files for heartbeat runs
        isolatedSession: true, // optional: fresh session each run (no conversation history)
        // activeHours: { start: "08:00", end: "24:00" },
      },
    },
  },
}
```

## Defaults

- Interval: `30m`. Applying Anthropic provider defaults bumps this to `1h` when the resolved auth mode is OAuth/token (including Claude CLI reuse), but only while `heartbeat.every` is unset. Set `agents.defaults.heartbeat.every` or per-agent `agents.entries.*.heartbeat.every`; use `0m` to disable.
- Prompt body (configurable via `agents.defaults.heartbeat.prompt`): `Follow the heartbeat monitor scratch context when provided. Recurring tasks are cron jobs; create or change their schedules with cron tools or the openclaw cron CLI, not heartbeat scratch. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- Timeout: unset heartbeat turns use `agents.defaults.timeoutSeconds` when set. Otherwise, they use the heartbeat cadence capped at 600 seconds. Set `agents.defaults.heartbeat.timeoutSeconds` or per-agent `agents.entries.*.heartbeat.timeoutSeconds` for longer heartbeat work.
- The heartbeat prompt is sent **verbatim** as the user message. The system prompt includes a "Heartbeats" section when heartbeats are enabled for the default agent, and the run is flagged internally.
- When heartbeats are disabled with `0m`, the monitor cron job stays but is disabled, and its scratch is retained for when you re-enable the cadence.
- When cron itself is disabled, scheduled heartbeats do not run even if heartbeat cadence remains enabled.
- Active hours (`heartbeat.activeHours`) are checked in the configured timezone. Outside the window, heartbeats are skipped until the next tick inside the window.
- Heartbeats automatically defer while cron work is active or queued, or while that agent's session-keyed subagent or nested command lanes are busy. Sibling agents do not pause each other.

## What the heartbeat prompt is for

The default prompt is intentionally broad:

- **Background tasks**: "Consider outstanding tasks" nudges the agent to review follow-ups (inbox, calendar, reminders, queued work) and surface anything urgent.
- **Human check-in**: "Checkup sometimes on your human during day time" nudges an occasional lightweight "anything you need?" message, but avoids night-time spam by using your configured local timezone (see [Timezone](/concepts/timezone)).

Heartbeat can react to completed [background tasks](/automation/tasks), but a heartbeat run itself does not create a task record.

If you want a heartbeat to do something very specific (e.g. "check Gmail PubSub stats" or "verify gateway health"), set `agents.defaults.heartbeat.prompt` (or `agents.entries.*.heartbeat.prompt`) to a custom body (sent verbatim).

## Response contract

- If nothing needs attention, reply with **`HEARTBEAT_OK`**.
- Heartbeat runs may instead call `heartbeat_respond` with `notify: false` for no visible update, or `notify: true` plus `notificationText` for an alert. When present, the structured tool response takes precedence over the text fallback.
- A meaningful `heartbeat_respond` result with `notify: false` remains silent but is remembered as bounded internal context for the next user turn in that session. `no_change` acknowledgments and visible notifications are not stored this way.
- During heartbeat runs, OpenClaw treats `HEARTBEAT_OK` as an ack when it appears at the **start or end** of the reply. The token is stripped and the reply is dropped if the remaining content is at most 300 characters.
- If `HEARTBEAT_OK` appears in the **middle** of a reply, it is not treated specially.
- For alerts, **do not** include `HEARTBEAT_OK`; return only the alert text.

Outside heartbeats, stray `HEARTBEAT_OK` at the start/end of a message is stripped and logged; a message that is only `HEARTBEAT_OK` is dropped.

## Config

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        lightContext: false, // default: false; true skips workspace bootstrap files for heartbeat runs
        isolatedSession: false, // default: false; true runs each heartbeat in a fresh session (no conversation history)
        target: "last", // default: none | options: last | none | <channel id> (core or plugin, e.g. "imessage")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Follow the heartbeat monitor scratch context when provided. Recurring tasks are cron jobs; create or change their schedules with cron tools or the openclaw cron CLI, not heartbeat scratch. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
      },
    },
  },
}
```

### Scope and precedence

- `agents.defaults.heartbeat` sets global heartbeat behavior.
- `agents.entries.*.heartbeat` merges on top; if any agent has a `heartbeat` block, **only those agents** run heartbeats.
- `channels.defaults.heartbeatVisibility` sets visibility defaults for all channels.
- `channels.<channel>.heartbeatVisibility` overrides channel defaults.
- `channels.<channel>.accounts.<id>.heartbeatVisibility` (multi-account channels) overrides per-channel settings.

### Per-agent heartbeats

If any `agents.entries.*` entry includes a `heartbeat` block, **only those agents** run heartbeats. The per-agent block merges on top of `agents.defaults.heartbeat` (so you can set shared defaults once and override per agent).

Example: two agents, only the second agent runs heartbeats.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last", // explicit delivery to last contact (default is "none")
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          timeoutSeconds: 45,
          prompt: "Follow the heartbeat monitor scratch context when provided. Recurring tasks are cron jobs; create or change their schedules with cron tools or the openclaw cron CLI, not heartbeat scratch. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### Active hours example

Restrict heartbeats to business hours in a specific timezone:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last", // explicit delivery to last contact (default is "none")
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

Outside this window (before 9am or after 10pm Eastern), heartbeats are skipped. The next scheduled tick inside the window will run normally.

### 24/7 setup

If you want heartbeats to run all day, use one of these patterns:

- Omit `activeHours` entirely (no time-window restriction; this is the default behavior).
- Set a full-day window: `activeHours: { start: "00:00", end: "24:00" }`.

<Warning>
Do not set the same `start` and `end` time (for example `08:00` to `08:00`). That is treated as a zero-width window, so heartbeats are always skipped.
</Warning>

### Multi-account example

Use `accountId` to target a specific account on multi-account channels like Telegram:

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678:topic:42", // optional: route to a specific topic/thread
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### Field notes

<ParamField path="every" type="string">
  Heartbeat interval (duration string; default unit = minutes).
</ParamField>
<ParamField path="model" type="string">
  Optional model override for heartbeat runs (`provider/model`).
</ParamField>
<ParamField path="lightContext" type="boolean" default="false">
  When true, heartbeat runs use lightweight bootstrap context and skip workspace bootstrap files. Monitor scratch is injected by the heartbeat runner either way.
</ParamField>
<ParamField path="isolatedSession" type="boolean" default="false">
  When true, each heartbeat runs in a fresh session with no prior conversation history. Uses the same isolation pattern as cron `sessionTarget: "isolated"`. Dramatically reduces per-heartbeat token cost. Combine with `lightContext: true` for maximum savings. Delivery routing still uses the main session context.
</ParamField>
<ParamField path="session" type="string">
  Optional session key for heartbeat runs.

- `main` (default): agent main session.
- Explicit session key (copy from `openclaw sessions --json` or the [sessions CLI](/cli/sessions)).
- Session key formats: see [Sessions](/concepts/session) and [Groups](/channels/groups).

</ParamField>
<ParamField path="target" type="string">
- `last`: deliver to the last used external channel.
- explicit channel: any configured channel or plugin id, for example `discord`, `matrix`, `telegram`, or `whatsapp`.
- `none` (default): run the heartbeat but **do not deliver** externally.

</ParamField>
<ParamField path="directPolicy" type='"allow" | "block"' default="allow">
  Controls direct/DM delivery behavior. `allow`: allow direct/DM heartbeat delivery. `block`: suppress direct/DM delivery (`reason=dm-blocked`).

</ParamField>
<ParamField path="to" type="string">
  Optional recipient override (channel-specific id, e.g. E.164 for WhatsApp or a Telegram chat id). For Telegram topics/threads, use `<chatId>:topic:<messageThreadId>`.

</ParamField>
<ParamField path="accountId" type="string">
  Optional account id for multi-account channels. When `target: "last"`, the account id applies to the resolved last channel if it supports accounts; otherwise it is ignored. If the account id does not match a configured account for the resolved channel, delivery is skipped.

</ParamField>
<ParamField path="prompt" type="string">
  Overrides the default prompt body (not merged).

</ParamField>
<ParamField path="timeoutSeconds" type="number" default="global timeout or min(every, 600)">
  Maximum seconds allowed for a heartbeat agent turn before it is aborted. Leave unset to use `agents.defaults.timeoutSeconds` when set, otherwise the heartbeat cadence capped at 600 seconds.

</ParamField>
<ParamField path="activeHours" type="object">
  Restricts heartbeat runs to a time window. Object with `start` (HH:MM, inclusive; use `00:00` for start-of-day), `end` (HH:MM exclusive; `24:00` allowed for end-of-day), and optional `timezone`.

- Omitted or `"user"`: uses your `agents.defaults.userTimezone` if set, otherwise falls back to the host system timezone.
- `"local"`: always uses the host system timezone.
- Any IANA identifier (e.g. `America/New_York`): used directly; if invalid, falls back to the `"user"` behavior above.
- `start` and `end` must not be equal for an active window; equal values are treated as zero-width (always outside the window).
- Outside the active window, heartbeats are skipped until the next tick inside the window.

</ParamField>

## Delivery behavior

<AccordionGroup>
  <Accordion title="Session and target routing">
    - Heartbeats run in the agent's main session by default (`agent:<id>:<mainKey>`), or `global` when `session.scope = "global"`. Set `session` to override to a specific channel session (Discord/WhatsApp/etc.).
    - `session` only affects the run context; delivery is controlled by `target` and `to`.
    - To deliver to a specific channel/recipient, set `target` + `to`. With `target: "last"`, delivery uses the last external channel for that session.
    - Heartbeat deliveries allow direct/DM targets by default. Set `directPolicy: "block"` to suppress direct-target sends while still running the heartbeat turn.
    - If the main queue, target session lane, cron lane, or an active cron job is busy, the heartbeat is skipped and retried later.
    - If `target` resolves to no external destination, the run still happens but no outbound message is sent.

  </Accordion>
  <Accordion title="Visibility and skip behavior">
    - If `showOk`, `showAlerts`, and `useIndicator` are all disabled, the run is skipped up front as `reason=alerts-disabled`.
    - If only alert delivery is disabled, OpenClaw can still run the heartbeat, update due-task timestamps, restore the session idle timestamp, and suppress the outward alert payload.
    - If the resolved heartbeat target supports typing, OpenClaw shows typing while the heartbeat run is active. This uses the same target the heartbeat would send chat output to, and it is disabled by `typingMode: "never"`.

  </Accordion>
  <Accordion title="Session lifecycle and audit">
    - Heartbeat-only replies do **not** keep the session alive. Heartbeat metadata may update the session row, but idle expiry uses `lastInteractionAt` from the last real user/channel message, and daily expiry uses `sessionStartedAt`.
    - Control UI and WebChat history hide heartbeat prompts and OK-only acknowledgments. The underlying session transcript can still contain those turns for audit/replay.
    - Detached [background tasks](/automation/tasks) can enqueue a system event and wake heartbeat when the main session should notice something quickly. That wake does not make the heartbeat run a background task.

  </Accordion>
</AccordionGroup>

## Visibility controls

By default, `HEARTBEAT_OK` acknowledgments are suppressed while alert content is delivered. You can adjust this per channel or per account:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

Precedence: per-account → per-channel → channel defaults → built-in defaults.

### What each flag does

- `showOk`: sends a `HEARTBEAT_OK` acknowledgment when the model returns an OK-only reply.
- `showAlerts`: sends the alert content when the model returns a non-OK reply.
- `useIndicator`: emits indicator events for UI status surfaces.

If **all three** are false, OpenClaw skips the heartbeat run entirely (no model call).

### Per-channel vs per-account examples

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### Common patterns

| Goal                                     | Config                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Default behavior (silent OKs, alerts on) | _(no config needed)_                                                                     |
| Fully silent (no messages, no indicator) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Indicator-only (no messages)             | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OKs in one channel only                  | `channels.telegram.heartbeat: { showOk: true }`                                          |

## Monitor scratch (optional)

Each heartbeat monitor cron job owns a private scratch document stored in the shared state database. Think of it as your "heartbeat checklist": small, stable, and safe to consider every 30 minutes. When scratch exists, its content is appended to the heartbeat prompt.

Manage it with the cron CLI (the job id comes from `openclaw cron list --all`):

```bash
openclaw cron scratch <jobId>                 # print the current scratch
openclaw cron scratch <jobId> --set "..."     # replace it with exact text
openclaw cron scratch <jobId> --file notes.md # replace it from a file (- for stdin)
openclaw cron scratch <jobId> --unset         # remove it
```

Writes are compare-and-swap guarded: pass `--expected-revision <n>` to fail instead of overwriting a concurrent edit. Scratch is capped at 256 KiB and never appears in `cron list`/`cron runs` output.

The agent can also update its own scratch: during a heartbeat turn, `heartbeat_respond` accepts an optional `scratch` string that fully replaces the monitor's scratch for future heartbeats.

<Note>
**Migrating from HEARTBEAT.md or config-only cadence?** Run `openclaw doctor --fix`. Doctor first creates or updates the system-owned monitor rows from `agents.*.heartbeat`, then imports each agent's workspace `HEARTBEAT.md` into the monitor's scratch, converts any valid legacy `tasks:` entries into cron jobs, archives the original under the state directory (`backups/heartbeat-migration/`), and removes the file. Runtime heartbeat instructions come from database scratch only; the runtime never reads `HEARTBEAT.md`.
</Note>

If scratch exists but is effectively empty (only blank lines, Markdown/HTML comments, Markdown headings like `# Heading`, fence markers, or empty checklist stubs), OpenClaw skips the heartbeat run to save API calls. That skip is reported as `reason=empty-heartbeat-file`. If no scratch exists, the heartbeat still runs and the model decides what to do.

Keep it tiny (short checklist or reminders) to avoid prompt bloat.

Example scratch:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it's daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### Schedule recurring checks with cron

Heartbeat scratch is prompt context, not a scheduler. Create each recurring check as a [cron job](/automation/cron-jobs) so it has its own cadence, enable/disable state, and run history. Cron jobs can still target the main session when the check should use the normal conversation context.

Older scratch may contain a structured `tasks:` block. Run `openclaw doctor --fix` once after upgrading: Doctor converts every valid entry into an independently scheduled cron job, preserves its interval and previous last-run timing, and removes the retired block while keeping surrounding scratch prose. Runtime heartbeat turns do not parse `tasks:` text as schedules.

Doctor-created heartbeat task jobs keep heartbeat active-hours, cooldown, flood, and busy guards. Jobs due together can coalesce into one heartbeat turn. An occurrence outside active hours is skipped and tried again at its next cron occurrence.

### Can the agent update its scratch?

Yes. During a heartbeat turn, the agent can pass a `scratch` value to `heartbeat_respond` to fully replace the monitor prose for future heartbeats. You can also ask it in a normal chat to run `openclaw cron scratch <jobId> --set ...`, or edit the scratch yourself with the same command. Manage recurring schedules with cron instead of writing scheduler syntax into scratch.

<Warning>
Don't put secrets (API keys, phone numbers, private tokens) into monitor scratch - it becomes part of the prompt context.
</Warning>

## Manual wake (on-demand)

Use `openclaw system event` to enqueue a system event and optionally trigger an immediate heartbeat:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

| Flag                         | Description                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `--text <text>`              | System event text (required).                                                                    |
| `--mode <mode>`              | `now` runs an immediate heartbeat; `next-heartbeat` (default) waits for the next scheduled tick. |
| `--session-key <sessionKey>` | Target a specific session for the event; defaults to the agent's main session.                   |
| `--json`                     | Output JSON.                                                                                     |

If no `--session-key` is given and multiple agents have `heartbeat` configured, `--mode now` runs each of those agent heartbeats immediately.

Related heartbeat controls in the same CLI group:

```bash
openclaw system heartbeat last     # show the last heartbeat event
openclaw system heartbeat enable   # enable heartbeats
openclaw system heartbeat disable  # disable heartbeats
```

## Cost awareness

Heartbeats run full agent turns. Shorter intervals burn more tokens. To reduce cost:

- Use `isolatedSession: true` to avoid sending full conversation history (~100K tokens down to ~2-5K per run).
- Use `lightContext: true` to skip workspace bootstrap files for heartbeat runs.
- Set a cheaper `model` (e.g. `ollama/llama3.2:1b`).
- Keep the monitor scratch small.
- Use `target: "none"` if you only want internal state updates.

## Context overflow after heartbeat

Heartbeats preserve the shared session's existing runtime model after the run completes, so a heartbeat that switched a session to a smaller local model (for example an Ollama model with a 32k window) can leave that model in place for the next main-session turn. If that next turn then reports context overflow, and the session's last runtime model matches configured `heartbeat.model`, OpenClaw's recovery message calls out heartbeat model bleed as the likely cause and suggests a fix.

To avoid this: use `isolatedSession: true` to run heartbeats in a fresh session (optionally combined with `lightContext: true` for the smallest prompt), or choose a heartbeat model with a context window large enough for the shared session.

## Related

- [Automation](/automation) - all automation mechanisms at a glance
- [Background Tasks](/automation/tasks) - how detached work is tracked
- [Timezone](/concepts/timezone) - how timezone affects heartbeat scheduling
- [Troubleshooting](/automation/cron-jobs#troubleshooting) - debugging automation issues
