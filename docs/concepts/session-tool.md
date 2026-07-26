---
summary: "Agent tools for cross-session status, recall, messaging, and sub-agent orchestration"
read_when:
  - You want to understand what session tools the agent has
  - You want to configure cross-session access or sub-agent spawning
  - You want to inspect spawned sub-agent status
title: "Session tools"
---

OpenClaw gives agents tools to work across sessions, inspect status, and orchestrate sub-agents.

## Available tools

| Tool                 | What it does                                                                |
| -------------------- | --------------------------------------------------------------------------- |
| `sessions`           | Patch visible session settings and manage the global session-group catalog  |
| `sessions_list`      | List sessions with optional filters (kind, label, agent, archive, preview)  |
| `sessions_search`    | Search visible session transcripts and return matching excerpts             |
| `sessions_history`   | Read the transcript of a specific session                                   |
| `sessions_send`      | Run another session on the same Gateway and optionally wait                 |
| `conversations_list` | List stable external conversation addresses                                 |
| `conversations_send` | Send to one exact external conversation without running a local session     |
| `conversations_turn` | Send to one exact external conversation and wait for its correlated reply   |
| `sessions_spawn`     | Spawn an isolated sub-agent session for background work                     |
| `sessions_yield`     | End the current turn and wait for follow-up sub-agent results               |
| `subagents`          | List or cancel background work in this session tree                         |
| `session_status`     | Show a `/status`-style card and optionally set a per-session model override |

These tools are still subject to the active tool profile and allow/deny policy. `tools.profile: "coding"` includes the full session orchestration set. `tools.profile: "messaging"` includes session self-service, discovery, recall, cross-session messaging, external-conversation tools, and the complete spawn lifecycle (`sessions_spawn`, `sessions_yield`, and `subagents`). The UI-only task-suggestion tools `spawn_task` and `dismiss_task` remain coding-profile tools.

Group, provider, sandbox, and per-agent policies can still remove those tools after the profile stage. Use `/tools` from the affected session to inspect the effective tool list.

## Listing and reading sessions

`sessions_list` returns focused discovery rows: session key, agent, kind, channel, label/title/preview fields, parent and child relationships, last update, archive/pin state, state version, model, context/total token counts, run status, and whether the last run aborted. Filter by `kinds` (array; accepted values: `main`, `group`, `cron`, `hook`, `node`, `other`), exact `label`, exact `agentId`, `search` text, or recency (`activeMinutes`). Active sessions are returned by default; pass `archived: true` to inspect archived sessions instead. Set `includeDerivedTitles`, `includeLastMessage`, or `messageLimit` (capped at 20) when you need mailbox-style triage: a visibility-scoped derived title, a last-message preview snippet, or bounded recent messages on each row. Delivery routing, internal session IDs, per-run timings/settings, cost estimates, and transcript paths are intentionally omitted; use `session_status`, conversation tools, and `sessions_history` for those owner-specific details. Derived titles and previews are produced only for sessions the caller can already see under the configured session tool visibility policy, so unrelated sessions stay hidden. When visibility is restricted, `sessions_list` returns optional `visibility` metadata showing the effective mode and a warning that results may be scope-limited.

`sessions_history` fetches the conversation transcript for a specific session. By default, tool results are excluded; pass `includeTools: true` to see them. Use `limit` for the newest bounded tail. Pass `offset: 0` when you need pagination metadata, then pass returned `nextOffset` values to page backward through older OpenClaw transcript windows without reading raw transcript files. Explicit offset pages do not merge external CLI fallback imports; use the default newest-tail view (no `offset`) when you need that merged display history.

The returned view is intentionally bounded and safety-filtered:

- assistant text is normalized before recall:
  - thinking tags are stripped
  - `<relevant-memories>` / `<relevant_memories>` scaffolding blocks are stripped
  - plain-text tool-call XML payload blocks such as `<tool_call>...</tool_call>`, `<function_call>...</function_call>`, `<tool_calls>...</tool_calls>`, and `<function_calls>...</function_calls>` are stripped, including truncated payloads that never close cleanly
  - downgraded tool-call/result scaffolding such as `[Tool Call: ...]`, `[Tool Result ...]`, and `[Historical context ...]` is stripped
  - leaked model control tokens such as `<|assistant|>`, other ASCII `<|...|>` tokens, and full-width `<｜...｜>` variants are stripped
  - malformed MiniMax tool-call XML such as `<invoke ...>` / `</minimax:tool_call>` is stripped
- credential/token-like text is redacted before it is returned
- long text blocks are truncated
- very large histories can drop older rows or replace an oversized row with `[sessions_history omitted: message too large]`
- the tool reports summary flags such as `truncated`, `droppedMessages`, `contentTruncated`, `contentRedacted`, `bytes`, and pagination metadata

Use the returned **session key** (like `"main"`) with `sessions_history`, `sessions_send`, and `session_status`. Those target tools can also resolve a known session ID, but `sessions_list` does not expose internal IDs.

If you need the exact raw transcript, inspect the scoped SQLite transcript rows instead of treating `sessions_history` as an unfiltered dump.

Use [`sessions_search`](/concepts/session-search) for exact full-text recall across visible user and assistant transcript text. Its results include a `sessionKey` for a follow-up `sessions_history` call; visibility filtering, snippet redaction, and output bounds match the history boundary.

## Managing session settings and groups

The owner-gated `sessions` tool exposes two bounded self-service surfaces:

- `action: "patch"` changes the current session by default, or another visible session selected by `sessionKey`. It can set the label, sidebar icon, pin/archive state, model, and thinking level. It does not expose reset, delete, or compact actions.
- `group_list`, `group_set`, `group_rename`, and `group_delete` manage the global ordered session-group catalog. `group_set` replaces the ordered name list rather than patching one entry.

An agent-selected model patch stays reversible until that selection completes a successful run. If the selected model is definitively unusable because of authentication, billing, or model-not-found failure, OpenClaw restores the previous model and writes a visible system note. Transient rate-limit, overload, timeout, network, and server failures do not undo the selection.

## Sessions versus conversations

A **session** is local model context. A **conversation** is an exact external address such as one peer, channel, or thread. The two are linked, but they are not interchangeable: direct messages can share one `main` session while retaining separate conversation addresses.

`conversations_list` returns opaque `conversationRef` values for the active agent. With an explicit `channel`, the Gateway also refreshes addresses from that channel's local directory, such as approved Reef peers; use `query` to find a specific peer beyond the current result page. Discovery catalogs the address without creating a model-context session; the backing session is created only when delivery or inbound context needs it. Conversation discovery and delivery are owner-only because they use the Gateway's channel credentials. Use `conversations_send` for fire-and-forget delivery. Use `conversations_turn` when the remote reply belongs to the current model turn: the Gateway reserves one transport message ID, persists a delivery operation and queue intent before transport I/O, and returns the correlated reply from the tool instead of starting a second local agent turn. Delivery operations live outside model transcripts; a captured reply is retained only as a side artifact while the tool result owns model context. If the Gateway restarts after queueing, delivery can recover but a later reply follows ordinary inbound dispatch because the process-local waiter is gone. Unsolicited inbound messages always continue through the normal channel dispatch path.

Use the shared `message` tool when you already have an explicit raw channel target or need a channel-specific action. Conversation references are scoped to the active agent and should be obtained through `conversations_list`, not constructed from session keys.

In Code Mode, the conversation tools reuse their exact Gateway output contracts. A single `exec` cell can list addresses, select a returned `conversationRef`, and call `conversations_send` or `conversations_turn`; normal tool policy and approvals still apply to the nested calls.

## Sending cross-session messages

`sessions_send` runs another session on the same Gateway and optionally waits for the response. Its `sessionKey`, `label`, or `agentId` selects local model context, not an external destination. The resulting reply can still be announced through the established requester or target delivery context; that existing behavior is unchanged. For exact external delivery, use a conversation tool or `message` with an explicit channel and target.

- **Fire-and-forget:** set `timeoutSeconds: 0` to enqueue and return immediately.
- **Wait for reply:** set a timeout and get the response inline.

Thread-scoped chat sessions, such as keys ending in `:thread:<id>`, are not valid `sessions_send` targets. Use the parent channel session key for inter-agent coordination so tool-routed messages do not appear inside an active human-facing thread.

Messages and A2A follow-up replies are marked as inter-session data in the receiving prompt (`[Inter-session message ... isUser=false]`) and in transcript provenance. The receiving agent should treat them as tool-routed data, not as a direct end-user-authored instruction.

After the target responds, OpenClaw can run a **reply-back loop** where the agents alternate messages up to the built-in limit. The target agent can reply `REPLY_SKIP` to stop early.

Pass `watch: true` to also register the sender as a state-change watcher of the target: when another actor later sends the target a direct human message or changes its goal, the sender receives a system notice pointing at `session_status` `changesSince`. Registration happens after successful dispatch, targets the session that actually received the message, and starts at its current state version, so only later changes produce notices. The result reports `watched: true` when registration succeeded. See [Session state awareness](/concepts/session-state).

## Status and orchestration helpers

`session_status` is the lightweight `/status`-equivalent tool for the current or another visible session. It reports usage, time, model/runtime state, and linked background-task context when present. Like `/status`, it can backfill sparse token/cache counters from the latest transcript usage entry, and `model=default` clears a per-session override. Use `sessionKey="current"` for the caller's current session; visible client labels such as `openclaw-tui` are not session keys.

When route metadata is available, `session_status` also includes a visible `Route context` JSON block and matching structured `details` fields. These fields disambiguate the session key from the route that is currently handling the live run:

- `origin` is where the session was created, or the provider inferred from a deliverable session-key prefix when older state lacks stored origin metadata.
- `active` is the current live-run route. It is only reported for the live or current session being handled now.
- `deliveryContext` is the persisted delivery route stored on the session, which OpenClaw can reuse for later delivery even when the active surface differs.

## Session state changes

OpenClaw keeps a durable signal log of material session state changes (direct human messages to watched sessions, child-run outcomes, goal changes, compaction). `sessions_list` rows and `session_status` expose the session's `stateVersion`, and `session_status` accepts `changesSince: <version>` to return the typed events after that version, with exact `historyGap` signaling when the requested version predates retained history. Watchers — spawn parents automatically, `sessions_send watch: true` explicitly — receive one coalesced stale-state notice when another actor changes a watched session.

State-change events omit repeated session/agent IDs and expose only model-useful payload fields (`outcome`, `channel`, or `turns`). The event summary and actor/run identifiers remain available for reconciliation.

See [Session state awareness](/concepts/session-state) for the full model: event kinds, watcher registration, the anti-spam notice protocol, reconciliation flow, and current limits.

`sessions_yield` intentionally ends the current turn so the next message can be the follow-up event you are waiting for. Use it after spawning sub-agents when you want completion results to arrive as the next message instead of building poll loops.

`subagents` is the session-tree view over native sub-agent runs and the shared background-task ledger. `action: "list"` reports active/recent sub-agents plus scoped ACP, CLI/media, and cron tasks. `action: "cancel"` accepts a returned `taskId` and can stop only work inside the caller's controlled session tree; leaf sub-agents cannot cancel another session's task.

## Spawning sub-agents

`sessions_spawn` creates an isolated session for a background task by default. It is always non-blocking; it returns immediately with a `runId` and `childSessionKey`. Native sub-agent runs receive the delegated task in the child session's first visible `[Subagent Task]` message, while the system prompt carries only sub-agent runtime rules and routing context.

Key options:

- `runtime: "subagent"` (default) or `"acp"` for external harness agents.
- `model` and `thinking` overrides for the child session.
- `thread: true` to bind the spawn to a chat thread (Discord, Slack, etc.).
- `sandbox: "require"` to enforce sandboxing on the child.
- `context: "fork"` for native sub-agents when the child needs the current requester transcript; omit it or use `context: "isolated"` for a clean child. `context: "fork"` is only valid with `runtime: "subagent"`. Thread-bound native sub-agents default to `context: "fork"` unless `threadBindings.defaultSpawnContext` says otherwise.
- `visible: true` to create a persistent dashboard session instead of a hidden sub-agent session. Visible spawns support an explicit model, working directory, same-agent transcript fork, and an optional [managed worktree](/concepts/managed-worktrees); see [Sub-agents](/tools/subagents#tool-parameters) for the exact compatibility limits.

Default leaf sub-agents do not get session tools. When `maxSpawnDepth >= 2`, depth-1 orchestrator sub-agents additionally receive `sessions_spawn`, `subagents`, `sessions_list`, and `sessions_history` so they can manage their own children. Leaf runs still do not get recursive orchestration tools.

After completion, an announce step posts the result to the requester's channel. Completion delivery preserves bound thread/topic routing when available, and if the completion origin only identifies a channel, OpenClaw can still reuse the requester session's stored route (`lastChannel` / `lastTo`) for direct delivery.

For ACP-specific behavior, see [ACP Agents](/tools/acp-agents).

## Visibility

Session tools are scoped to limit what the agent can see:

| Level   | Scope                                                      |
| ------- | ---------------------------------------------------------- |
| `self`  | Only the current session                                   |
| `tree`  | Current + spawned; reads include watched same-agent groups |
| `agent` | All sessions for this agent                                |
| `all`   | All sessions (cross-agent if configured)                   |

Default is `tree`. Sandboxed sessions are clamped to `tree` regardless of config.
With the default `session.dmScope: "main"`, group activity makes watched
same-agent group sessions readable from the main session.

## Further reading

- [Session Management](/concepts/session): routing, lifecycle, maintenance
- [Sub-agents](/tools/subagents): child-session lifecycle and delivery
- [ACP Agents](/tools/acp-agents): external harness spawning
- [Multi-agent](/concepts/multi-agent): multi-agent architecture
- [Gateway Configuration](/gateway/configuration): session tool config knobs

## Related

- [Session management](/concepts/session)
- [Session pruning](/concepts/session-pruning)
