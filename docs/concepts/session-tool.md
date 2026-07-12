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

| Tool               | What it does                                                                |
| ------------------ | --------------------------------------------------------------------------- |
| `sessions_list`    | List sessions with optional filters (kind, label, agent, archive, preview)  |
| `sessions_history` | Read the transcript of a specific session                                   |
| `sessions_send`    | Send a message to another session and optionally wait                       |
| `sessions_spawn`   | Spawn an isolated sub-agent session for background work                     |
| `sessions_yield`   | End the current turn and wait for follow-up sub-agent results               |
| `subagents`        | List spawned sub-agent status for this session                              |
| `session_status`   | Show a `/status`-style card and optionally set a per-session model override |

These tools are still subject to the active tool profile and allow/deny policy. `tools.profile: "coding"` includes the full session orchestration set, including `sessions_spawn`, `sessions_yield`, and `subagents`. `tools.profile: "messaging"` includes cross-session messaging tools (`sessions_list`, `sessions_history`, `sessions_send`, `session_status`) but does not include sub-agent spawning. To keep a messaging profile and still allow native delegation, add:

```json5
{
  tools: {
    profile: "messaging",
    alsoAllow: ["sessions_spawn", "sessions_yield", "subagents"],
  },
}
```

Group, provider, sandbox, and per-agent policies can still remove those tools after the profile stage. Use `/tools` from the affected session to inspect the effective tool list.

## Listing and reading sessions

`sessions_list` returns sessions with their key, agentId, kind, channel, model, token counts, and timestamps. Filter by `kinds` (array; accepted values: `main`, `group`, `cron`, `hook`, `node`, `other`), exact `label`, exact `agentId`, `search` text, or recency (`activeMinutes`). Active sessions are returned by default; pass `archived: true` to inspect archived sessions instead. Rows include `pinned` and `archived` state. Set `includeDerivedTitles`, `includeLastMessage`, or `messageLimit` (capped at 20) when you need mailbox-style triage: a visibility-scoped derived title, a last-message preview snippet, or bounded recent messages on each row. Derived titles and previews are produced only for sessions the caller can already see under the configured session tool visibility policy, so unrelated sessions stay hidden. When visibility is restricted, `sessions_list` returns optional `visibility` metadata showing the effective mode and a warning that results may be scope-limited.

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

Both tools accept either a **session key** (like `"main"`) or a **session ID** from a previous list call.

If you need the exact raw transcript, inspect the scoped SQLite transcript rows instead of treating `sessions_history` as an unfiltered dump.

## Sending cross-session messages

`sessions_send` delivers a message to another session and optionally waits for the response:

- **Fire-and-forget:** set `timeoutSeconds: 0` to enqueue and return immediately.
- **Wait for reply:** set a timeout and get the response inline.

Thread-scoped chat sessions, such as keys ending in `:thread:<id>`, are not valid `sessions_send` targets. Use the parent channel session key for inter-agent coordination so tool-routed messages do not appear inside an active human-facing thread.

Messages and A2A follow-up replies are marked as inter-session data in the receiving prompt (`[Inter-session message ... isUser=false]`) and in transcript provenance. The receiving agent should treat them as tool-routed data, not as a direct end-user-authored instruction.

After the target responds, OpenClaw can run a **reply-back loop** where the agents alternate messages (up to `session.agentToAgent.maxPingPongTurns`, range 0-20, default 5). The target agent can reply `REPLY_SKIP` to stop early.

Pass `watch: true` to also register the sender as a state-change watcher of the target: when another actor later sends the target a direct human message or changes its goal, the sender receives a system notice pointing at `session_status` `changesSince`. Registration happens after successful dispatch, targets the session that actually received the message, and starts at its current state version, so only later changes produce notices. The result reports `watched: true` when registration succeeded. See [Session state awareness](/concepts/session-state).

## Status and orchestration helpers

`session_status` is the lightweight `/status`-equivalent tool for the current or another visible session. It reports usage, time, model/runtime state, and linked background-task context when present. Like `/status`, it can backfill sparse token/cache counters from the latest transcript usage entry, and `model=default` clears a per-session override. Use `sessionKey="current"` for the caller's current session; visible client labels such as `openclaw-tui` are not session keys.

When route metadata is available, `session_status` also includes a visible `Route context` JSON block and matching structured `details` fields. These fields disambiguate the session key from the route that is currently handling the live run:

- `origin` is where the session was created, or the provider inferred from a deliverable session-key prefix when older state lacks stored origin metadata.
- `active` is the current live-run route. It is only reported for the live or current session being handled now.
- `deliveryContext` is the persisted delivery route stored on the session, which OpenClaw can reuse for later delivery even when the active surface differs.

## Session state changes

OpenClaw keeps a durable signal log of material session state changes (direct human messages to watched sessions, child-run outcomes, goal changes, compaction). `sessions_list` rows and `session_status` expose the session's `stateVersion`, and `session_status` accepts `changesSince: <version>` to return the typed events after that version, with exact `historyGap` signaling when the requested version predates retained history. Watchers — spawn parents automatically, `sessions_send watch: true` explicitly — receive one coalesced stale-state notice when another actor changes a watched session.

See [Session state awareness](/concepts/session-state) for the full model: event kinds, watcher registration, the anti-spam notice protocol, reconciliation flow, and current limits.

`sessions_yield` intentionally ends the current turn so the next message can be the follow-up event you are waiting for. Use it after spawning sub-agents when you want completion results to arrive as the next message instead of building poll loops.

`subagents` is the visibility helper for already spawned OpenClaw sub-agents. It supports `action: "list"` to inspect active/recent runs.

## Spawning sub-agents

`sessions_spawn` creates an isolated session for a background task by default. It is always non-blocking; it returns immediately with a `runId` and `childSessionKey`. Native sub-agent runs receive the delegated task in the child session's first visible `[Subagent Task]` message, while the system prompt carries only sub-agent runtime rules and routing context.

Key options:

- `runtime: "subagent"` (default) or `"acp"` for external harness agents.
- `model` and `thinking` overrides for the child session.
- `thread: true` to bind the spawn to a chat thread (Discord, Slack, etc.).
- `sandbox: "require"` to enforce sandboxing on the child.
- `context: "fork"` for native sub-agents when the child needs the current requester transcript; omit it or use `context: "isolated"` for a clean child. `context: "fork"` is only valid with `runtime: "subagent"`. Thread-bound native sub-agents default to `context: "fork"` unless `threadBindings.defaultSpawnContext` says otherwise.

Default leaf sub-agents do not get session tools. When `maxSpawnDepth >= 2`, depth-1 orchestrator sub-agents additionally receive `sessions_spawn`, `subagents`, `sessions_list`, and `sessions_history` so they can manage their own children. Leaf runs still do not get recursive orchestration tools.

After completion, an announce step posts the result to the requester's channel. Completion delivery preserves bound thread/topic routing when available, and if the completion origin only identifies a channel, OpenClaw can still reuse the requester session's stored route (`lastChannel` / `lastTo`) for direct delivery.

For ACP-specific behavior, see [ACP Agents](/tools/acp-agents).

## Visibility

Session tools are scoped to limit what the agent can see:

| Level   | Scope                                    |
| ------- | ---------------------------------------- |
| `self`  | Only the current session                 |
| `tree`  | Current session + spawned sub-agents     |
| `agent` | All sessions for this agent              |
| `all`   | All sessions (cross-agent if configured) |

Default is `tree`. Sandboxed sessions are clamped to `tree` regardless of config.

## Further reading

- [Session Management](/concepts/session): routing, lifecycle, maintenance
- [Sub-agents](/tools/subagents): child-session lifecycle and delivery
- [ACP Agents](/tools/acp-agents): external harness spawning
- [Multi-agent](/concepts/multi-agent): multi-agent architecture
- [Gateway Configuration](/gateway/configuration): session tool config knobs

## Related

- [Session management](/concepts/session)
- [Session pruning](/concepts/session-pruning)
