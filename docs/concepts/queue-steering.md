---
summary: "How active-run steering queues messages at runtime boundaries"
read_when:
  - Explaining how steer behaves while an agent is using tools
  - Explaining why steering does not cancel an already-running tool
  - Changing active-run queue behavior or runtime steering integration
  - Comparing steering with followup, collect, and interrupt queue modes
title: "Steering queue"
---

When a normal prompt arrives while a session run is already streaming and the queue mode is `steer` (the default, no config needed), OpenClaw tries to send that prompt into the active runtime. OpenClaw and the native Codex app-server harness implement the delivery details differently.

This page covers queue-mode steering for normal inbound messages in `steer` mode. In `followup` or `collect` mode, normal messages skip this path and wait until the active run finishes. For the explicit `/steer <message>` command, see [Steer](/tools/steer).

## Runtime boundary

Steering does not interrupt a tool call that is already running. The OpenClaw runtime checks at tool-launch boundaries as well as model boundaries:

1. The assistant asks for tool calls.
2. In sequential mode, OpenClaw checks immediately before each call starts, including after asynchronous resolution, validation, and pre-execution hooks.
3. A running call finishes. If a steer is waiting afterward, the unstarted sequential tail is skipped.
4. In parallel mode, OpenClaw prepares calls first, then checks once immediately before launching the prepared calls. Calls that have crossed that checkpoint continue together.
5. Every skipped call receives paired tool start/end events and a synthetic error result (`Skipped due to queued user message.`), in assistant source order.
6. OpenClaw appends the exact drained steering message before the next LLM call.

This keeps every requested tool call paired with a result while ensuring accepted steering is model-visible before any later tool can start.

The native Codex app-server harness exposes `turn/steer` instead of OpenClaw runtime's internal steering queue. OpenClaw batches queued prompts for the configured quiet window, then sends a single `turn/steer` request with all collected user input in arrival order. Codex's upstream turn scheduler owns its tool scheduling and consumes accepted steering at the next model boundary; OpenClaw does not add per-tool preemption to that runtime.

Codex review and manual compaction turns reject same-turn steering. When a runtime cannot accept steering in `steer` mode, OpenClaw waits for the active run to finish before starting the prompt.

## Tool launch boundaries

OpenClaw distinguishes started work from requested work:

- A sequential call that is already running completes. Later calls have not started, so OpenClaw returns synthetic skipped results for them and lets the model reconsider with the steer visible.
- A parallel batch has one atomic launch checkpoint. A steer present before it suppresses all prepared calls; a steer arriving after it does not recall any of them.
- Validation or policy outcomes finalized before the parallel checkpoint remain truthful. Only executable calls that did not start receive the steering skip result.
- The transcript stays append-only and structurally paired: assistant tool calls, real or synthetic tool results, then the steering user message.

Stopping already-running work is a different intent from redirecting future work. Use `/queue interrupt` (or `/stop`) when the newest message should abort the active run instead of steering it.

## Modes

| Mode        | Active-run behavior                                    | Later behavior                                                                      |
| ----------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `steer`     | Steers the prompt into the active runtime when it can. | Waits for the active run to finish if steering is unavailable.                      |
| `followup`  | Does not steer.                                        | Runs queued messages later after the active run ends.                               |
| `collect`   | Does not steer.                                        | Coalesces compatible queued messages into one later turn after the debounce window. |
| `interrupt` | Aborts the active run instead of steering it.          | Starts the newest message after aborting.                                           |

## Burst example

If four users send messages while the agent is executing a tool call:

- OpenClaw preserves the runtime's configured steering drain mode and FIFO order. One-at-a-time consumers keep later messages for later boundaries; `all` consumers inject the queued FIFO batch together. Codex receives messages collected during its quiet window as one batched `turn/steer`.
- With `/queue collect`, OpenClaw does not steer. It waits until the active run ends, then creates a followup turn with compatible queued messages after the debounce window.
- With `/queue interrupt`, OpenClaw aborts the active run and starts the newest message instead of steering.

## Scope

Steering always targets the current active session run. It does not create a new session, change the active run's tool policy, or split messages by sender. In multi-user channels, inbound prompts already include sender and route context, so the next model call can see who sent each message.

Use `followup` or `collect` when you want messages to queue by default instead of steering the active run. Use `interrupt` when the newest prompt should replace the active run.

## Debounce

The built-in queue debounce applies to queued `followup` and `collect` delivery. In `steer` mode with the native Codex harness, it also sets the quiet window before sending batched `turn/steer`. OpenClaw active steering does not use the debounce timer; at tool-launch and model boundaries it drains FIFO according to the runtime's configured steering drain mode.

## Related

- [Command queue](/concepts/queue)
- [Steer](/tools/steer)
- [Messages](/concepts/messages)
- [Agent loop](/concepts/agent-loop)
