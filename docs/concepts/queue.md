---
summary: "Auto-reply queue modes, shared background capacity, and per-session overrides"
read_when:
  - Changing auto-reply execution or concurrency
  - Explaining /queue modes or message steering behavior
  - Inspecting background work and command-lane diagnostics
title: "Command queue"
---

OpenClaw serializes inbound auto-reply runs (all channels) through a tiny in-process queue to prevent multiple agent runs from colliding, while still allowing safe parallelism across sessions.

## Why

- Auto-reply runs can be expensive (LLM calls) and can collide when multiple inbound messages arrive close together.
- Serializing avoids competing for shared resources (session state, logs, CLI stdin) and reduces the chance of upstream rate limits.

## How it works

- A lane-aware FIFO queue drains each lane with a configurable concurrency cap (default 1 for unconfigured lanes; `main` uses `min(16, max(8, available CPU parallelism))`, and `subagent` defaults to 8).
- CLI, embedded, and Codex runs share the same **session-key lane** (`session:<key>`). Each turn waits there before acquiring the session's execution claim, so changing runtimes cannot start a competing turn.
- Each session run is then queued into a **global lane** (`main` by default) so overall parallelism is capped by `agents.defaults.maxConcurrent`.
- Embedded attempt preparation starts one stage per event-loop turn so concurrent starts leave room for Gateway requests. Asynchronous stage work can still overlap; this does not lower the run concurrency limit or change session serialization.
- When verbose logging is enabled, queued runs emit a short notice if they waited more than ~2s before starting.
- Typing indicators still fire immediately on enqueue (when supported by the channel) so user experience is unchanged while the run waits its turn.

## Defaults

When unset, all inbound channel surfaces use:

- `mode: "steer"`
- a built-in 500ms debounce for steer, followup, and collect batching
- `cap: 20`
- `drop: "summarize"`

Same-turn steering is the default. A prompt that arrives mid-run is injected into the active runtime when the run can accept steering, so no second session run is started. If the active run cannot accept steering, OpenClaw waits for the active run to finish before starting the prompt.

## Queue modes

`/queue` controls what normal inbound messages do while a session already has an active run:

- `steer`: inject messages into the active runtime. OpenClaw lets an already-running tool finish, skips sequential calls that have not started, and makes the steer visible before the next tool launch or model decision. Parallel calls continue once their batch has crossed its launch checkpoint. Codex app-server receives one batched `turn/steer` and applies it at the next model boundary. If the run is not actively streaming or steering is unavailable, OpenClaw waits until the active run ends before starting the prompt.
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
      cap: 20,
      drop: "summarize",
      byChannel: { discord: "collect" },
      debounceMsByChannel: { discord: 1000 },
    },
  },
}
```

## Queue options

Per-session `/queue` options apply to queued delivery. The `debounce` option also sets the Codex steering quiet window in `steer` mode:

- `debounce`: quiet window before draining queued followups or collect batches; in Codex `steer` mode, quiet window before sending batched `turn/steer`. Bare numbers are milliseconds; units `ms`, `s`, `m`, `h`, and `d` are accepted.
- `cap`: max queued messages per session. Values below `1` are ignored.
- `drop: "summarize"` (default): drop the oldest queued entries as needed, keep compact summaries, and inject them as a synthetic followup prompt.
- `drop: "old"`: drop the oldest queued entries as needed, without preserving summaries.
- `drop: "new"`: reject the newest message when the queue is already full.

The queue uses a built-in 500ms debounce. `cap` defaults to `20`, and `drop` defaults to `summarize`.

## Steer and streaming

When channel streaming is `partial` or `block`, steering can look like several short visible replies while the active run reaches runtime boundaries:

- `partial`: the preview may finalize early, then a new preview starts after steering is accepted.
- `block`: draft-sized blocks can create the same sequential appearance.
- Without streaming, steering falls back to a followup after the active run when the runtime cannot accept same-turn steering.

`steer` does not abort in-flight tools. Skipped OpenClaw tool calls receive synthetic paired error results so the transcript remains valid. Use `/queue interrupt` when the newest message should abort the current run.

## Precedence

For mode selection, OpenClaw resolves:

1. Inline or stored per-session `/queue` override.
2. `messages.queue.byChannel.<channel>`.
3. `messages.queue.mode`.
4. Default `steer`.

For options, inline or stored `/queue` options win over config. Then channel-specific debounce (`messages.queue.debounceMsByChannel`), plugin debounce defaults, and built-in defaults are applied, in that order. `cap` and `drop` are global/session options, not per-channel config keys.

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

Ordinary Control UI input sent to an existing session is stored in the per-agent database
before the Gateway acknowledges it. In `collect` mode, appending the combined
turn and marking its source inputs consumed happen in one transaction. A browser
reconnect can reconcile those source inputs even if it missed their final events.

This preserves input, not execution permissions. If the Gateway stops before a
queued input reaches the transcript, it appears as interrupted input after
restart and requires an explicit resend. The in-memory queue is not replayed.
Host sleep that preserves the process can continue the existing queue normally.

- Applies to auto-reply agent runs across all inbound channels that use the gateway reply pipeline (WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat, etc.).
- Default lane (`main`) is process-wide for inbound turns; set `agents.defaults.maxConcurrent` to allow multiple sessions in parallel.
- Heartbeat embedded runs use the bounded `cron-nested` lane for global admission so slow background work does not block inbound replies, while their configured heartbeat session lane still serializes work for that session.
- Additional lanes may exist (e.g. `cron`, `cron-nested`, `nested`, `subagent`) so background jobs can run in parallel without blocking inbound replies. Isolated cron agent turns hold a `cron` slot while their inner agent execution uses `cron-nested`. Shared non-cron `nested` flows keep their own lane behavior. These detached runs are tracked as [background tasks](/automation/tasks).
- Per-session lanes guarantee that only one agent run touches a given session at a time.
- No external dependencies or background worker threads; pure TypeScript + promises.

## Background work

Skill Workshop reviews and plugin background completions, including [dreaming](/concepts/dreaming), share a separate budget of **three concurrent runs**. Workshop reviews use at most one slot; each plugin can use up to three available slots. This keeps maintenance work out of foreground reply capacity while bounding its total concurrency. These limits are built in and need no configuration.

Schedulers that await background work do not occupy this budget themselves. Only the dispatched work holds a slot, through completion or cancellation cleanup, so a scheduler cannot block the child it is waiting for. Cancelled queued work is removed before it starts; Gateway restart or runtime retirement prevents stale completions from starting or returning results.

The Control UI **System busyness** overlay and `diagnostics.lanes` report this work in one `background` row. Its active and queued counts include every owner; owner lanes are not counted again in the dynamic session-lane totals.

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
