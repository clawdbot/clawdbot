---
summary: "How active-run steering queues messages at runtime boundaries"
read_when:
  - Explaining how steer behaves while an agent is using tools
  - Changing active-run queue behavior or runtime steering integration
  - Comparing steer, queue, collect, and followup modes
title: "Steering queue"
---

When a message arrives while a session run is already streaming, OpenClaw can
send that message into the active runtime instead of starting another run for
the same session. The public modes are runtime-neutral; Pi and the native Codex
app-server harness implement the delivery details differently.

## Runtime boundary

Steering does not interrupt a tool call that is already running. Pi checks for
queued steering messages at model boundaries:

1. The assistant asks for tool calls.
2. Pi executes the current assistant message's tool-call batch.
3. Pi emits the turn end event.
4. Pi drains queued steering messages.
5. Pi appends those messages as user messages before the next LLM call.

This keeps tool results paired with the assistant message that requested them,
then lets the next model call see the latest user input.

The native Codex app-server harness exposes `turn/steer` instead of Pi's
internal steering queue. OpenClaw adapts the same modes there:

- `steer` batches queued messages for the configured quiet window, then sends a
  single `turn/steer` request with all collected user input in arrival order.
- `queue` keeps the legacy serialized shape by sending separate `turn/steer`
  requests.
- `followup`, `collect`, `steer-backlog`, and `interrupt` stay OpenClaw-owned
  queue behavior around the active Codex turn.

Codex review and manual compaction turns reject same-turn steering. When a
runtime cannot accept steering, OpenClaw falls back to the followup queue where
that mode allows it.

## Modes

| Mode            | Active-run behavior                                                                                                          | Later followup behavior                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `steer`         | Injects all queued steering messages together at the next runtime boundary. This is the default.                             | Falls back to followup only when steering is unavailable.                           |
| `queue`         | Legacy one-at-a-time steering. Pi injects one queued message per model boundary; Codex sends separate `turn/steer` requests. | Falls back to followup only when steering is unavailable.                           |
| `steer-backlog` | Same active-run steering behavior as `steer`.                                                                                | Also keeps the same message for a later followup turn.                              |
| `followup`      | Does not steer the current run.                                                                                              | Runs queued messages later.                                                         |
| `collect`       | Does not steer the current run.                                                                                              | Coalesces compatible queued messages into one later turn after the debounce window. |
| `interrupt`     | Aborts the active run, then starts the newest message.                                                                       | None.                                                                               |

## Burst example

If four users send messages while the agent is executing a tool call:

- `steer`: the active runtime receives all four messages in arrival order before
  its next model decision. Pi drains them at the next model boundary; Codex
  receives them as one batched `turn/steer`.
- `queue`: legacy serialized steering. Pi injects one queued message at a time;
  Codex receives separate `turn/steer` requests.
- `collect`: OpenClaw waits until the active run ends, then creates a followup
  turn with compatible queued messages after the debounce window.

## Scope

Steering always targets the current active session run. It does not create a new
session, change the active run's tool policy, or split messages by sender. In
multi-user channels, inbound prompts already include sender and route context, so
the next model call can see who sent each message.

Use `collect` when you want OpenClaw to build a later followup turn that can
coalesce compatible messages and preserve followup queue drop policy. Use
`queue` only when you need the older one-at-a-time steering behavior.

## Debounce

`messages.queue.debounceMs` applies to followup delivery, including `collect`,
`followup`, `steer-backlog`, and `steer` fallback when active-run steering is not
available. For Pi, active `steer` itself does not use the debounce timer because
Pi naturally batches messages until the next model boundary. For the native
Codex harness, OpenClaw uses the same debounce value as the quiet window before
sending the batched `turn/steer`.

## Related

- [Command queue](/concepts/queue)
- [Messages](/concepts/messages)
- [Agent loop](/concepts/agent-loop)
