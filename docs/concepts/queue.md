---
summary: "Auto-reply queue modes, defaults, and per-session overrides"
read_when:
  - Changing auto-reply execution or concurrency
  - Explaining /queue modes or message steering behavior
title: "Command queue"
---

OpenClaw serializes inbound auto-reply runs (all channels) through a tiny in-process queue to prevent multiple agent runs from colliding, while still allowing safe parallelism across sessions.

## Why

- Auto-reply runs can be expensive (LLM calls) and can collide when multiple inbound messages arrive close together.
- Serializing avoids competing for shared resources (session files, logs, CLI stdin) and reduces the chance of upstream rate limits.

## How it works

- A lane-aware FIFO queue drains each lane with a configurable concurrency cap (default 1 for unconfigured lanes; `main` defaults to 4, `subagent` to 8).
- `runEmbeddedAgent` enqueues by **session key** (lane `session:<key>`) to guarantee only one active run per session.
- Each session run is then queued into a **global lane** (`main` by default) so overall parallelism is capped by `agents.defaults.maxConcurrent`.
- When verbose logging is enabled, queued runs emit a short notice if they waited more than ~2s before starting.
- Typing indicators still fire immediately on enqueue (when supported by the channel) so user experience is unchanged while the run waits its turn.

## Defaults

When unset, all inbound channel surfaces use:

- `mode: "steer"`
- `debounceMs: 500`
- `cap: 20`
- `drop: "summarize"`

Same-turn steering is the default. A prompt that arrives mid-run is injected into the active runtime when the run can accept steering, so no second session run is started. If the active run cannot accept steering, OpenClaw waits for the active run to finish before starting the prompt.

## Queue modes

`/queue` controls what normal inbound messages do while a session already has an active run:

- `steer`: inject messages into the active runtime. OpenClaw delivers all pending steering messages **after the current assistant turn finishes executing its tool calls**, before the next LLM call; Codex app-server receives one batched `turn/steer`. If the run is not actively streaming or steering is unavailable, OpenClaw waits until the active run ends before starting the prompt.
- `followup`: do not steer. Enqueue each message for a later agent turn after the current run ends.
- `collect`: do not steer. Coalesce queued messages into a **single** followup turn after the quiet window. If messages target different channels/threads, they drain individually to preserve routing.
- `interrupt`: abort the active run for that session, then run the newest message.

For runtime-specific timing and dependency behavior, see [Steering queue](/concepts/queue-steering). For the explicit `/steer <message>` command, see [Steer](/tools/steer).

Configure globally or per channel via `messages.queue`:

```json5
{
  messages: {
    queue: {
      mode: "steer",
      debounceMs: 500,
      cap: 20,
      drop: "summarize",
      byChannel: { discord: "collect" },
    },
  },
}
```

## Queue options

Options apply to queued delivery. `debounceMs` also sets the Codex steering quiet window in `steer` mode:

- `debounceMs`: quiet window before draining queued followups or collect batches; in Codex `steer` mode, quiet window before sending batched `turn/steer`. Bare numbers are milliseconds; units `ms`, `s`, `m`, `h`, and `d` are accepted by `/queue` options.
- `cap`: max queued messages per session. Values below `1` are ignored.
- `drop: "summarize"` (default): drop the oldest queued entries as needed, keep compact summaries, and inject them as a synthetic followup prompt.
- `drop: "old"`: drop the oldest queued entries as needed, without preserving summaries.
- `drop: "new"`: reject the newest message when the queue is already full.

Defaults: `debounceMs: 500`, `cap: 20`, `drop: summarize`.

## Steer and streaming

When channel streaming is `partial` or `block`, steering can look like several short visible replies while the active run reaches runtime boundaries:

- `partial`: the preview may finalize early, then a new preview starts after steering is accepted.
- `block`: draft-sized blocks can create the same sequential appearance.
- Without streaming, steering falls back to a followup after the active run when the runtime cannot accept same-turn steering.

`steer` does not abort in-flight tools. Use `/queue interrupt` when the newest message should abort the current run.

## Precedence

For mode selection, OpenClaw resolves:

1. Inline or stored per-session `/queue` override.
2. `messages.queue.byChannel.<channel>`.
3. `messages.queue.mode`.
4. Default `steer`.

For options, inline or stored `/queue` options win over config. Then channel-specific debounce (`messages.queue.debounceMsByChannel`), plugin debounce defaults, global `messages.queue` options, and built-in defaults are applied, in that order. `cap` and `drop` are global/session options, not per-channel config keys.

## Per-session overrides

- Send `/queue <steer|followup|collect|interrupt>` as a standalone command to store the queue mode for the current session.
- Options can be combined: `/queue collect debounce:0.5s cap:25 drop:summarize`
- `/queue default` or `/queue reset` clears the session override.

## Queued-turn cancellation

While a prompt sits in the followup/collect queue (for example a TUI or
webchat `chat.send` arriving while another turn is active), Gateway keeps a
**Gateway-owned cancel identity** for that client `runId` until the queued
content runs or is dropped. The identity follows content folded into an
overflow summary.

- `chat.abort` with a specific `runId` cancels that turn while it is still
  queued, if the requester is authorized (same ownership rules as active runs).
- `chat.abort` for a session without `runId` cancels **authorized queued turns
  first**, then aborts authorized active runs. That order prevents queue drain
  from promoting work into a half-stopped session.
- Clearing the entire session queue without per-requester checks is not the
  stop path for multi-owner sessions.
- Queued waits are not projected as active agent runs for `sessions.list` and
  do not own active-run timeout semantics; only the active phase does.

Gateway-backed clients (including `openclaw tui`) forward mid-run prompts and
let the Gateway apply the queue mode. Esc/`/stop` uses a session-scoped abort
so lost local handles cannot leave a still-queued prompt running.

`openclaw chat` and `openclaw tui --local` apply the same four modes in the
embedded runtime. Local `steer` injects into an active embedded run when that
runtime accepts steering and otherwise becomes a followup; `followup` and
`collect` remain local pending work; `interrupt` aborts the active local run
before starting the newest message. The explicit `/steer <message>` command is
not a local-mode command.

## Scope and guarantees

- Applies to auto-reply agent runs across all inbound channels that use the gateway reply pipeline (WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat, etc.).
- Default lane (`main`) is process-wide for inbound + main heartbeats; set `agents.defaults.maxConcurrent` to allow multiple sessions in parallel.
- Additional lanes may exist (e.g. `cron`, `cron-nested`, `nested`, `subagent`) so background jobs can run in parallel without blocking inbound replies. Isolated cron agent turns hold a `cron` slot while their inner agent execution uses `cron-nested`. Shared non-cron `nested` flows keep their own lane behavior. These detached runs are tracked as [background tasks](/automation/tasks).
- Per-session lanes guarantee that only one agent run touches a given session at a time.
- No external dependencies or background worker threads; pure TypeScript + promises.

## Troubleshooting

- If commands seem stuck, enable verbose logs and look for "queued for ...ms" lines to confirm the queue is draining.
- Codex app-server runs that accept a turn and then stop emitting progress are interrupted by the Codex adapter so the active session lane can release instead of waiting for the outer run timeout.
- When diagnostics are enabled, sessions that remain in `processing` past the built-in warning threshold with no observed reply, tool, status, block, or ACP progress are classified by current activity:
  - Active work with recent progress logs as `session.long_running`. Owned silent model calls also stay `session.long_running` until the built-in abort threshold so slow or non-streaming providers are not reported as stalled too early.
  - Active work with no recent progress logs as `session.stalled`; owned model calls, blocked tool calls, and stalled embedded runs switch to `session.stalled` at or after the abort threshold. Ownerless stale model/tool activity is not hidden as long-running.
  - `session.stuck` is reserved for recoverable stale session bookkeeping, including idle queued sessions with stale ownerless model/tool activity.
  - `session.stuck` always triggers recovery that can release the affected session lane. A `session.stalled` classification past the abort threshold (blocked tool call, stalled model call, or stalled embedded run) can also trigger active-abort recovery, so both classifications can unstick a queue, not only `session.stuck`.
  - Repeated `session.stuck` and `session.long_running` warning log lines back off exponentially while the session remains unchanged; recovery attempts still run on every heartbeat tick regardless of that backoff.

## Related

- [Session management](/concepts/session)
- [Steering queue](/concepts/queue-steering)
- [Steer](/tools/steer)
- [Retry policy](/concepts/retry)
