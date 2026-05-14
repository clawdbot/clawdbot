---
summary: "How active-run steering queues messages at runtime boundaries"
read_when:
  - Explaining how steer behaves while an agent is using tools
  - Changing active-run queue behavior or runtime steering integration
  - Comparing steering with followup, collect, and interrupt queue modes
title: "Steering queue"
---

When a normal prompt arrives while a session run is already streaming, OpenClaw
tries to send that prompt into the active runtime by default when the queue mode
is `steer`. No config entry and no queue directive are required for that default
behavior. Pi and the native Codex app-server harness implement the delivery
details differently.

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
internal steering queue. OpenClaw batches queued prompts for the configured
quiet window, then sends a single `turn/steer` request with all collected user
input in arrival order.

Codex review and manual compaction turns reject same-turn steering. When a
runtime cannot accept steering in `steer` mode, OpenClaw waits for the active
run to finish before starting the prompt.

This page explains queue-mode steering for normal inbound messages when the mode
is `steer`. If the mode is `followup` or `collect`, normal messages do not enter
this steering path; they wait until the active run finishes. For the explicit
`/steer <message>` command, see [Steer](/tools/steer).

## Modes

| Mode        | Active-run behavior                                    | Later behavior                                                                      |
| ----------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `steer`     | Steers the prompt into the active runtime when it can. | Waits for the active run to finish if steering is unavailable.                      |
| `followup`  | Does not steer.                                        | Runs queued messages later after the active run ends.                               |
| `collect`   | Does not steer.                                        | Coalesces compatible queued messages into one later turn after the debounce window. |
| `interrupt` | Aborts the active run instead of steering it.          | Starts the newest message after aborting.                                           |

## Burst example

If four users send messages while the agent is executing a tool call:

- With default behavior, the active runtime receives all four messages in
  arrival order before its next model decision. Pi drains them at the next model
  boundary; Codex receives them as one batched `turn/steer`.
- With `/queue collect`, OpenClaw does not steer. It waits until the active run
  ends, then creates a followup turn with compatible queued messages after the
  debounce window.
- With `/queue interrupt`, OpenClaw aborts the active run and starts the newest
  message instead of steering.

## Scope

Steering always targets the current active session run. It does not create a new
session, change the active run's tool policy, or split messages by sender. In
multi-user channels, inbound prompts already include sender and route context, so
the next model call can see who sent each message.

Use `followup` or `collect` when you want messages to queue by default instead
of steering the active run. Use `interrupt` when the newest prompt should
replace the active run.

## Debounce

`messages.queue.debounceMs` applies to queued `followup` and `collect` delivery.
In `steer` mode with the native Codex harness, it also sets the quiet window
before sending batched `turn/steer`. For Pi, active steering itself does not use
the debounce timer because Pi naturally batches messages until the next model
boundary.

## Related

- [Command queue](/concepts/queue)
- [Steer](/tools/steer)
- [Messages](/concepts/messages)
- [Agent loop](/concepts/agent-loop)
