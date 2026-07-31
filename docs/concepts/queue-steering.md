---
summary: "How active-run steering queues messages at runtime boundaries"
read_when:
  - Explaining how steer behaves while an agent is using tools
  - Explaining why steering does not cancel an in-flight tool-call batch
  - Changing active-run queue behavior or runtime steering integration
  - Comparing steering with followup, collect, and interrupt queue modes
title: "Steering queue"
---

When a normal prompt arrives while a session run is already streaming and the queue mode is `steer` (the default, no config needed), OpenClaw tries to send that prompt into the active runtime. OpenClaw and the native Codex app-server harness implement the delivery details differently.

This page covers queue-mode steering for normal inbound messages in `steer` mode. In `followup` or `collect` mode, normal messages skip this path and wait until the active run finishes. For the explicit `/steer <message>` command, see [Steer](/tools/steer).

## Runtime boundary

Steering does not interrupt a tool call that is already running. OpenClaw checks for queued steering messages at model boundaries:

1. The assistant asks for tool calls.
2. OpenClaw executes the current assistant message's tool-call batch.
3. OpenClaw emits the turn end event.
4. OpenClaw drains queued steering messages.
5. OpenClaw appends those messages as user messages before the next LLM call.

This keeps tool results paired with the assistant message that requested them, then lets the next model call see the latest user input.

The native Codex app-server harness exposes `turn/steer` instead of OpenClaw runtime's internal steering queue. OpenClaw batches queued prompts for the configured quiet window, then sends a single `turn/steer` request with all collected user input in arrival order.

Codex review and manual compaction turns reject same-turn steering. When a runtime cannot accept steering in `steer` mode, OpenClaw waits for the active run to finish before starting the prompt.

## Why steering waits for the current batch

Steering applies corrections at the next model step instead of cancelling tool calls the assistant already requested. This is a deliberate design decision, not a missing feature:

- A tool-call batch is one unit of work. When the model requests several tool calls in one assistant message, they usually depend on each other, for example edits across multiple files. Cancelling the not-yet-started calls leaves that work half applied, and the next model step typically has to redo the whole batch to get back to a consistent state.
- Every tool call keeps a real result. Dropping requested calls means fabricating aborted results for them, and models routinely misread synthetic failures as real ones, then retry or route around tools that never actually failed.
- The context stays append-only. Steered messages are appended at the tail, so nothing already sent to the model is rewritten and provider prompt caches stay valid.

The wait is bounded by the current tool-call batch, not by the run: a steered correction is visible to the model at its next reasoning step. Stopping the current work is a different intent than redirecting it; use `/queue interrupt` (or `/stop`) when the newest message should abort the active run instead of steering it.

## Modes

| Mode        | Active-run behavior                                    | Later behavior                                                                      |
| ----------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `steer`     | Steers the prompt into the active runtime when it can. | Waits for the active run to finish if steering is unavailable.                      |
| `followup`  | Does not steer.                                        | Runs queued messages later after the active run ends.                               |
| `collect`   | Does not steer.                                        | Coalesces compatible queued messages into one later turn after the debounce window. |
| `interrupt` | Aborts the active run instead of steering it.          | Starts the newest message after aborting.                                           |

## Burst example

If four users send messages while the agent is executing a tool call:

- With default behavior, the active runtime receives all four messages in arrival order before its next model decision. OpenClaw drains them at the next model boundary; Codex receives them as one batched `turn/steer`.
- With `/queue collect`, OpenClaw does not steer. It waits until the active run ends, then creates a followup turn with compatible queued messages after the debounce window.
- With `/queue interrupt`, OpenClaw aborts the active run and starts the newest message instead of steering.

## Scope

Steering always targets the current active session run. It does not create a new session, change the active run's tool policy, or split messages by sender. In multi-user channels, inbound prompts already include sender and route context, so the next model call can see who sent each message.

Use `followup` or `collect` when you want messages to queue by default instead of steering the active run. Use `interrupt` when the newest prompt should replace the active run.

## Debounce

The built-in queue debounce applies to queued `followup` and `collect` delivery. In `steer` mode with the native Codex harness, it also sets the quiet window before sending batched `turn/steer`. For OpenClaw, active steering itself does not use the debounce timer because OpenClaw naturally batches messages until the next model boundary.

## Related

- [Command queue](/concepts/queue)
- [Steer](/tools/steer)
- [Messages](/concepts/messages)
- [Agent loop](/concepts/agent-loop)
