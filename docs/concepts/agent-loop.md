---
summary: "Agent loop lifecycle, streams, and wait semantics"
read_when:
  - You need an exact walkthrough of the agent loop or lifecycle events
  - You are changing session queueing, transcript writes, or session write lock behavior
title: "Agent loop"
---

An agentic loop is the full “real” run of an agent: intake → context assembly → model inference →
tool execution → streaming replies → persistence. It’s the authoritative path that turns a message
into actions and a final reply, while keeping session state consistent.

In OpenClaw, a loop is a single, serialized run per session that emits lifecycle and stream events
as the model thinks, calls tools, and streams output. This doc explains how that authentic loop is
wired end-to-end.

## Entry points

- Gateway RPC: `agent` and `agent.wait`.
- CLI: `agent` command.

## How it works (high-level)

1. `agent` RPC validates params, resolves session (sessionKey/sessionId), persists session metadata, returns `{ runId, acceptedAt }` immediately.
2. `agentCommand` runs the agent:
   - resolves model + thinking/verbose/trace defaults
   - loads skills snapshot
   - calls `runEmbeddedPiAgent` (pi-agent-core runtime)
   - emits **lifecycle end/error** if the embedded loop does not emit one
3. `runEmbeddedPiAgent`:
   - serializes runs via per-session + global queues
   - resolves model + auth profile and builds the pi session
   - subscribes to pi events and streams assistant/tool deltas
   - enforces timeout -> aborts run if exceeded
   - for Codex app-server turns, aborts an accepted turn that stops producing app-server progress before a terminal event
   - returns payloads + usage metadata
4. `subscribeEmbeddedPiSession` bridges pi-agent-core events to OpenClaw `agent` stream:
   - tool events => `stream: "tool"`
   - assistant deltas => `stream: "assistant"`
   - lifecycle events => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` uses `waitForAgentRun`:
   - waits for **lifecycle end/error** for `runId`
   - returns `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## Queueing + concurrency

- Runs are serialized per session key (session lane) and optionally through a global lane.
- This prevents tool/session races and keeps session history consistent.
- Messaging channels can choose queue modes (collect/steer/followup) that feed this lane system.
  See [Command Queue](/concepts/queue).
- Transcript writes are also protected by a session write lock on the session file. The lock is
  process-aware and file-based, so it catches writers that bypass the in-process queue or come from
  another process.
- Session write locks are non-reentrant by default. If a helper intentionally nests acquisition of
  the same lock while preserving one logical writer, it must opt in explicitly with
  `allowReentrant: true`.

## Session + workspace preparation

- Workspace is resolved and created; sandboxed runs may redirect to a sandbox workspace root.
- Skills are loaded (or reused from a snapshot) and injected into env and prompt.
- Bootstrap/context files are resolved and injected into the system prompt report.
- A session write lock is acquired; `SessionManager` is opened and prepared before streaming. Any
  later transcript rewrite, compaction, or truncation path must take the same lock before opening or
  mutating the transcript file.

## Prompt assembly + system prompt

- System prompt is built from OpenClaw’s base prompt, skills prompt, bootstrap context, and per-run overrides.
- Model-specific limits and compaction reserve tokens are enforced.
- See [System prompt](/concepts/system-prompt) for what the model sees.

## Hook points (where you can intercept)

OpenClaw has two hook systems:

- **Internal hooks** (Gateway hooks): event-driven scripts for commands and lifecycle events.
- **Plugin hooks**: extension points inside the agent/tool lifecycle and gateway pipeline.

### Internal hooks (Gateway hooks)

- **`agent:bootstrap`**: runs while building bootstrap files before the system prompt is finalized.
  Use this to add/remove bootstrap context files.
- **Command hooks**: `/new`, `/reset`, `/stop`, and other command events (see Hooks doc).

See [Hooks](/automation/hooks) for setup and examples.

### Plugin hooks (agent + gateway lifecycle)

These run inside the agent loop or gateway pipeline:

- **`before_model_resolve`**: runs pre-session (no `messages`) to deterministically override provider/model before model resolution.
- **`before_prompt_build`**: runs after session load (with `messages`) to inject `prependContext`, `systemPrompt`, `prependSystemContext`, or `appendSystemContext` before prompt submission. Use `prependContext` for per-turn dynamic text and system-context fields for stable guidance that should sit in system prompt space.
- **`before_agent_start`**: legacy compatibility hook that may run in either phase; prefer the explicit hooks above.
- **`before_agent_reply`**: runs after inline actions and before the LLM call, letting a plugin claim the turn and return a synthetic reply or silence the turn entirely.
- **`agent_end`**: inspect the final message list and run metadata after completion.
- **`before_compaction` / `after_compaction`**: observe or annotate compaction cycles.
- **`before_tool_call` / `after_tool_call`**: intercept tool params/results.
- **`before_install`**: inspect built-in scan findings and optionally block skill or plugin installs.
- **`tool_result_persist`**: synchronously transform tool results before they are written to an OpenClaw-owned session transcript.
- **`message_received` / `message_sending` / `message_sent`**: inbound + outbound message hooks.
- **`session_start` / `session_end`**: session lifecycle boundaries.
- **`gateway_start` / `gateway_stop`**: gateway lifecycle events.

Hook decision rules for outbound/tool guards:

- `before_tool_call`: `{ block: true }` is terminal and stops lower-priority handlers.
- `before_tool_call`: `{ block: false }` is a no-op and does not clear a prior block.
- `before_install`: `{ block: true }` is terminal and stops lower-priority handlers.
- `before_install`: `{ block: false }` is a no-op and does not clear a prior block.
- `message_sending`: `{ cancel: true }` is terminal and stops lower-priority handlers.
- `message_sending`: `{ cancel: false }` is a no-op and does not clear a prior cancel.

See [Plugin hooks](/plugins/hooks) for the hook API and registration details.

Harnesses may adapt these hooks differently. The Codex app-server harness keeps
OpenClaw plugin hooks as the compatibility contract for documented mirrored
surfaces, while Codex native hooks remain a separate lower-level Codex mechanism.

## Streaming + partial replies

- Assistant deltas are streamed from pi-agent-core and emitted as `assistant` events.
- Block streaming can emit partial replies either on `text_end` or `message_end`.
- Reasoning streaming can be emitted as a separate stream or as block replies.
- See [Streaming](/concepts/streaming) for chunking and block reply behavior.

## Tool execution + messaging tools

- Tool start/update/end events are emitted on the `tool` stream.
- Tool results are sanitized for size and image payloads before logging/emitting.
- Messaging tool sends are tracked to suppress duplicate assistant confirmations.

## Reply shaping + suppression

- Final payloads are assembled from:
  - assistant text (and optional reasoning)
  - inline tool summaries (when verbose + allowed)
  - assistant error text when the model errors
- The exact silent token `NO_REPLY` / `no_reply` is filtered from outgoing
  payloads.
- Messaging tool duplicates are removed from the final payload list.
- If no renderable payloads remain and a tool errored, a fallback tool error reply is emitted
  (unless a messaging tool already sent a user-visible reply).

## Compaction + retries

- Auto-compaction emits `compaction` stream events and can trigger a retry.
- On retry, in-memory buffers and tool summaries are reset to avoid duplicate output.
- See [Compaction](/concepts/compaction) for the compaction pipeline.

## Event streams (today)

- `lifecycle`: emitted by `subscribeEmbeddedPiSession` (and as a fallback by `agentCommand`)
- `assistant`: streamed deltas from pi-agent-core
- `tool`: streamed tool events from pi-agent-core

## Chat channel handling

- Assistant deltas are buffered into chat `delta` messages.
- A chat `final` is emitted on **lifecycle end/error**.

## Timeouts

- `agent.wait` default: 30s (just the wait). `timeoutMs` param overrides.
- Agent runtime: `agents.defaults.timeoutSeconds` default 172800s (48 hours); enforced in `runEmbeddedPiAgent` abort timer.
- Cron runtime: isolated agent-turn `timeoutSeconds` is owned by cron. The scheduler starts that timer when execution begins, aborts the underlying run at the configured deadline, then runs bounded cleanup before recording the timeout so a stale child session cannot keep the lane stuck.
- Session liveness diagnostics: with diagnostics enabled, `diagnostics.stuckSessionWarnMs` classifies long `processing` sessions that have no observed reply, tool, status, block, or ACP progress. Active embedded runs, model calls, and tool calls report as `session.long_running`; active work with no recent progress reports as `session.stalled`; `session.stuck` is reserved for stale session bookkeeping with no active work, and only that path releases the affected session lane so queued startup work can drain. Repeated `session.stuck` diagnostics back off while the session remains unchanged.
- Model idle timeout: OpenClaw aborts a model request when no response chunks arrive before the idle window. `models.providers.<id>.timeoutSeconds` extends this idle watchdog for slow local/self-hosted providers; otherwise OpenClaw uses `agents.defaults.timeoutSeconds` when configured, capped at 120s by default. Cron-triggered runs with no explicit model or agent timeout disable the idle watchdog and rely on the cron outer timeout.
- Provider HTTP request timeout: `models.providers.<id>.timeoutSeconds` applies to that provider's model HTTP fetches, including connect, headers, body, SDK request timeout, total guarded-fetch abort handling, and model stream idle watchdog. Use this for slow local/self-hosted providers such as Ollama before raising the whole agent runtime timeout.

## Where things can end early

- Agent timeout (abort)
- AbortSignal (cancel)
- Gateway disconnect or RPC timeout
- `agent.wait` timeout (wait-only, does not stop agent)

## Related

- [Tools](/tools) — available agent tools
- [Hooks](/automation/hooks) — event-driven scripts triggered by agent lifecycle events
- [Compaction](/concepts/compaction) — how long conversations are summarized
- [Exec Approvals](/tools/exec-approvals) — approval gates for shell commands
- [Thinking](/tools/thinking) — thinking/reasoning level configuration
