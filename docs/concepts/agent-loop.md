---
summary: "Agent loop lifecycle, streams, and wait semantics"
read_when:
  - You need an exact walkthrough of the agent loop or lifecycle events
  - You are changing session queueing, transcript writes, or session write lock behavior
title: "Agent loop"
---

The agent loop is the serialized, per-session run that turns a message into
actions and a reply: intake, context assembly, model inference, tool
execution, streaming, persistence.

## Entry points

- Gateway RPC: `agent` and `agent.wait`.
- CLI: `openclaw agent`.

## Run sequence

1. `agent` RPC validates params, resolves the session (`sessionKey`/`sessionId`), persists session metadata, and returns `{ runId, acceptedAt }` immediately.
2. `agentCommand` runs the turn: resolves model + thinking/verbose/trace defaults, loads the skills snapshot, calls `runEmbeddedAgent`, and emits a fallback **lifecycle end/error** if the embedded loop did not already emit one.
3. `runEmbeddedAgent`: serializes runs via per-session and global queues, resolves model + auth profile, builds the OpenClaw session, subscribes to runtime events, streams assistant/tool deltas, enforces the run timeout (aborting on expiry), and returns payloads plus usage metadata. For Codex app-server turns it also aborts an accepted turn that stops producing app-server progress before a terminal event.
4. `subscribeEmbeddedAgentSession` bridges runtime events to the `agent` stream: tool events to `stream: "tool"`, assistant deltas to `stream: "assistant"`, lifecycle events to `stream: "lifecycle"` (`phase: "start" | "end" | "error"`).
5. `agent.wait` (`waitForAgentRun`) waits for **lifecycle end/error** on a `runId` and returns `{ status: ok|error|timeout, startedAt, endedAt, error? }`.

## Queueing and concurrency

Runs are serialized per session key (session lane) and optionally through a global lane, preventing tool/session races. Messaging channels choose a queue mode (steer/followup/collect/interrupt) that feeds this lane system; see [Command Queue](/concepts/queue).

Transcript writes are additionally protected by a session write lock on the session file. The lock is process-aware and file-based, so it catches writers that bypass the in-process queue or come from another process. Writers wait up to 60 seconds by default (env override `OPENCLAW_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS`) before reporting the session as busy.

Session write locks are non-reentrant by default. A helper that intentionally nests acquisition of the same lock while preserving one logical writer must opt in with `allowReentrant: true`.

## Session and workspace preparation

- Workspace is resolved and created; sandboxed runs may redirect to a sandbox workspace root.
- Skills are loaded (or reused from a snapshot) and injected into env and prompt.
- Bootstrap/context files are resolved and injected into the system prompt.
- A session write lock is acquired and the session transcript target is prepared before streaming starts. Any later transcript rewrite, compaction, or truncation path must take the same lock before mutating the SQLite transcript rows.

## Prompt assembly

System prompt is built from OpenClaw's base prompt, skills prompt, bootstrap context, and per-run overrides. Model-specific limits and compaction reserve tokens are enforced. See [System prompt](/concepts/system-prompt) for what the model sees.

## Hooks

OpenClaw has two hook systems:

- **Internal hooks** (Gateway hooks): event-driven scripts for commands and lifecycle events.
- **Plugin hooks**: extension points inside the agent/tool lifecycle and gateway pipeline.

### Internal hooks (Gateway hooks)

- **`agent:bootstrap`**: runs while building bootstrap files before the system prompt is finalized. Use it to add or remove bootstrap context files.
- **Command hooks**: `/new`, `/reset`, `/stop`, and other command events (see the Hooks doc).

See [Hooks](/automation/hooks) for setup and examples.

### Plugin hooks

These run inside the agent loop or gateway pipeline:

| Hook                                                    | Runs                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before_model_resolve`                                  | Pre-session (no `messages`), to deterministically override provider/model before resolution.                                                                                                                                                                                                |
| `before_prompt_build`                                   | After session load (with `messages`), to inject `prependContext`, `systemPrompt`, `prependSystemContext`, or `appendSystemContext` before submission. Use `prependContext` for per-turn dynamic text and the system-context fields for stable guidance that belongs in system prompt space. |
| `before_agent_reply`                                    | After inline actions, before the LLM call. Lets a plugin claim the turn and return a synthetic reply or silence it entirely.                                                                                                                                                                |
| `agent_end`                                             | After completion, with the final message list and run metadata.                                                                                                                                                                                                                             |
| `before_compaction` / `after_compaction`                | Observe or annotate compaction cycles.                                                                                                                                                                                                                                                      |
| `before_tool_call` / `after_tool_call`                  | Intercept tool params/results.                                                                                                                                                                                                                                                              |
| `before_install`                                        | After operator install policy runs, on staged skill/plugin install material, when plugin hooks are loaded in the current process.                                                                                                                                                           |
| `tool_result_persist`                                   | Synchronously transforms tool results before they are written to an OpenClaw-owned session transcript.                                                                                                                                                                                      |
| `message_received` / `message_sending` / `message_sent` | Inbound and outbound message hooks.                                                                                                                                                                                                                                                         |
| `session_start` / `session_end`                         | Session lifecycle boundaries.                                                                                                                                                                                                                                                               |
| `gateway_start` / `gateway_stop`                        | Gateway lifecycle events.                                                                                                                                                                                                                                                                   |

Hook decision rules for outbound/tool guards:

- `before_tool_call`: `{ block: true }` is terminal and stops lower-priority handlers. `{ block: false }` is a no-op and does not clear a prior block.
- `before_install`: same terminal/no-op semantics as above. Use `security.installPolicy`, not `before_install`, for operator-owned install allow/block decisions that must cover CLI install and update paths.
- `message_sending`: `{ cancel: true }` is terminal and stops lower-priority handlers. `{ cancel: false }` is a no-op and does not clear a prior cancel.

See [Plugin hooks](/plugins/hooks) for the hook API and registration details.

Harnesses can adapt these hooks. The Codex app-server harness keeps OpenClaw plugin hooks as the compatibility contract for documented mirrored surfaces; Codex native hooks are a separate, lower-level Codex mechanism.

## Streaming

- Assistant deltas stream from the agent runtime as `assistant` events.
- Block streaming can emit partial replies on `text_end` or `message_end`.
- Reasoning streaming can be a separate stream or block replies.
- See [Streaming](/concepts/streaming) for chunking and block reply behavior.

## Tool execution

- Tool start/update/end events emit on the `tool` stream.
- Tool results are sanitized for size and image payloads before logging/emitting.
- Messaging tool sends are tracked to suppress duplicate assistant confirmations.

## Reply shaping

Final payloads are assembled from assistant text (plus optional reasoning), inline tool summaries (when verbose and allowed), and assistant error text when the model errors.

- The exact silent token `NO_REPLY` is filtered from outgoing payloads.
- Messaging tool duplicates are removed from the final payload list.
- If no renderable payloads remain and a tool errored, a fallback tool error reply is emitted unless a messaging tool already sent a user-visible reply.

## Compaction and retries

Auto-compaction emits `compaction` stream events and can trigger a retry. On retry, in-memory buffers and tool summaries reset to avoid duplicate output. See [Compaction](/concepts/compaction).

## Event streams

- `lifecycle`: emitted by `subscribeEmbeddedAgentSession` (and as a fallback by `agentCommand`).
- `assistant`: streamed deltas from the agent runtime.
- `tool`: streamed tool events from the agent runtime.

The Gateway projects lifecycle and tool start/terminal events into the bounded,
metadata-only [audit ledger](/cli/audit). This projection records provenance and
result codes without copying prompts, messages, tool arguments, tool results,
or raw errors out of the transcript/runtime path.

## Chat channel handling

Assistant deltas buffer into chat `delta` messages. A chat `final` is emitted on **lifecycle end/error**.

## Timeouts

| Timeout                                          | Default                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.wait`                                     | 30s                                    | Wait-only; `timeoutMs` param overrides. Does not stop the underlying run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Agent runtime (`agents.defaults.timeoutSeconds`) | 172800s (48h)                          | Enforced by `runEmbeddedAgent`'s abort timer. Set `0` for an unlimited run budget; model stream liveness watchdogs still apply.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| CLI backend no-output watchdog                   | computed per fresh/resumed CLI run     | Separate from the agent runtime. Configure `agents.defaults.cliBackends.<id>.reliability.watchdog.{fresh,resume}` for CLIs that can remain silent while working. A CLI-internal background task shares the parent subprocess and does not outlive an overall agent timeout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Cron isolated agent turn                         | owned by cron                          | The scheduler starts its own timer when execution begins, aborts the run at the configured deadline, then runs bounded cleanup before recording the timeout so a stale child session cannot keep the lane stuck.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Model idle timeout                               | Cloud 120s; self-hosted 300s           | OpenClaw aborts a model request when no response chunks arrive before the idle window. `models.providers.<id>.timeoutSeconds` extends this idle watchdog for slow local/self-hosted providers, but stays bounded by any lower finite `agents.defaults.timeoutSeconds` or run-specific timeout, since those govern the whole agent run. Unlimited run budgets still keep the provider-class idle watchdog. Cron-triggered cloud model runs with no explicit model/agent timeout use the same default; with an explicit cron run timeout, cloud model stream stalls cap at 60s so configured model fallbacks can still run before the outer cron deadline. Cron-triggered runs on genuinely local endpoints (loopback/private baseUrl) keep the local idle opt-out; self-hosted providers on network baseUrls get the 300s implicit watchdog. With an explicit cron run timeout, local/self-hosted stalls cap at that timeout. Set `models.providers.<id>.timeoutSeconds` for slow local providers. |
| Provider HTTP request timeout                    | `models.providers.<id>.timeoutSeconds` | Covers connect, headers, body, SDK request timeout, guarded-fetch abort handling, and the model stream idle watchdog for that provider. Use for slow local/self-hosted providers (for example Ollama) before raising the whole agent runtime timeout; keep the agent/runtime timeout at least as high when the model request needs to run longer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Stuck session diagnostics

With diagnostics enabled, a built-in two-minute threshold classifies long `processing` sessions with no observed reply, tool, status, block, or ACP progress:

- Active embedded runs, model calls, and tool calls report as `session.long_running`. Owned silent model calls stay `session.long_running` until the abort threshold so slow or non-streaming providers are not flagged as stalled too early.
- Active work with no recent progress reports as `session.stalled`. Owned model calls switch to `session.stalled` at or after the abort threshold; ownerless stale model/tool activity is not hidden as long-running.
- `session.stuck` is reserved for recoverable stale session bookkeeping, including idle queued sessions with stale ownerless model/tool activity.

The abort threshold is at least 5 minutes and 3x the warning threshold. Stale session bookkeeping releases the affected session lane immediately after recovery gates pass; stalled embedded runs are abort-drained only after the abort threshold, so queued work resumes without cutting off merely slow runs. Recovery emits structured requested/completed outcomes; diagnostic state is marked idle only if the same processing generation is still current, and repeated `session.stuck` diagnostics back off while the session stays unchanged.

## Where things can end early

- Agent timeout (abort)
- AbortSignal (cancel)
- Gateway disconnect or RPC timeout
- `agent.wait` timeout (wait-only, does not stop the agent)

## Related

- [Tools](/tools) - available agent tools
- [Hooks](/automation/hooks) - event-driven scripts triggered by agent lifecycle events
- [Compaction](/concepts/compaction) - how long conversations are summarized
- [Exec Approvals](/tools/exec-approvals) - approval gates for shell commands
- [Thinking](/tools/thinking) - thinking/reasoning level configuration
