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

| Tool                 | What it does                                                                            |
| -------------------- | --------------------------------------------------------------------------------------- |
| `sessions`           | Patch, reset, delete, or assign ownership of visible sessions and manage session groups |
| `sessions_list`      | List sessions with optional filters (kind, label, agent, archive, preview)              |
| `sessions_search`    | Search visible session transcripts and return matching excerpts                         |
| `sessions_history`   | Read the transcript of a specific session                                               |
| `sessions_send`      | Run another session on the same Gateway and optionally wait                             |
| `conversations_list` | List stable external conversation addresses                                             |
| `conversations_send` | Send to one exact external conversation without running a local session                 |
| `conversations_turn` | Send to one exact external conversation and wait for its correlated reply               |
| `sessions_spawn`     | Spawn an isolated sub-agent session for background work                                 |
| `sessions_yield`     | End the current turn and wait for follow-up sub-agent results                           |
| `subagents`          | List or cancel background work in this session tree                                     |
| `session_status`     | Show a `/status`-style card and optionally set a per-session model override             |

These tools are still subject to the active tool profile and allow/deny policy. `tools.profile: "coding"` includes the full session orchestration set. `tools.profile: "messaging"` includes session self-service, discovery, recall, cross-session messaging, external-conversation tools, and the complete spawn lifecycle (`sessions_spawn`, `sessions_yield`, and `subagents`). The UI-only task-suggestion tools `suggest_task` and `dismiss_task` remain coding-profile tools.

Group, provider, sandbox, and per-agent policies can still remove those tools after the profile stage. Use `/tools` from the affected session to inspect the effective tool list.

Session access denials are rendered from the same typed visibility decision
used by the enforcement boundary. When execution audit collection is enabled
for an admitted run, a private queued fact retains the evaluated policy inputs
and an installation-local opaque target reference, not the raw target session
key. Public inspection renders that generic fact as an unverified
`decision.record`; it does not claim a trusted reason or target display. A
successful session operation is not labeled `enforced` merely because its
mechanics succeeded.

For the same admitted run, create, fork, send, patch, reset, archive, restore,
and delete results can queue attribution-only generic facts. The private facts
distinguish committed or scheduled work from typed lifecycle conflicts and
definitive no-ops; their public display remains generic and unverified. Direct
Gateway sharing operations are outside this run-audit boundary.

## Listing and reading sessions

`sessions_list` returns focused discovery rows: session key, durable session ID, agent, kind, channel, label/title/preview fields, sidebar group, parent and child relationships, last update, archive/pin state, state version, model, context/total token counts, run status, and whether the last run aborted. Filter by `kinds` (array; accepted values: `main`, `group`, `cron`, `hook`, `node`, `other`), exact `label`, exact `agentId`, `search` text, or recency (`activeMinutes`). Active sessions are returned by default; pass `archived: true` to inspect archived sessions instead. Set `includeDerivedTitles`, `includeLastMessage`, or `messageLimit` (capped at 20) when you need mailbox-style triage: a visibility-scoped derived title, a last-message preview snippet, or bounded recent messages on each row. Use the returned `sessionId` as `expectedSessionId` when the `sessions` tool archives, restores, or deletes another session; this prevents a stale key from targeting a replacement. Delivery routing, other internal IDs, per-run timings/settings, cost estimates, and transcript paths remain omitted; use `session_status`, conversation tools, and `sessions_history` for those owner-specific details. Derived titles and previews are produced only for sessions the caller can already see under the configured session tool visibility policy, so unrelated sessions stay hidden. When visibility is restricted, `sessions_list` returns optional `visibility` metadata showing the effective mode and a warning that results may be scope-limited.

`sessions_history` fetches the conversation transcript for a specific session. By default, tool results are excluded; pass `includeTools: true` to see them. Use `limit` for the newest bounded tail. Pass `offset: 0` when you need pagination metadata, then pass returned `nextOffset` values to page backward through older OpenClaw transcript windows without reading raw transcript files. When an eligible bound external CLI transcript contributes messages, history returns a merged snapshot instead of a numeric offset page—even with an explicit `offset`. The Gateway treats these as terminal snapshots (`hasMore: false`); oversized snapshots remain byte-bounded, so terminal does not imply complete. Local offset paging applies when no external import survives. A requested `messageId` that is absent from the visible history returns empty history rather than the newest messages.

Durably admitted inputs from `sessions_send` or the Gateway `agent` method
appear separately in `pendingInputs`, not in transcript `messages`. Each row
records `queued`, `cancelled`, or `interrupted`.
Cancelled and interrupted inputs are retained for inspection and never run
automatically. Use `pendingBefore` with the page's `nextBefore` to read older
inputs; `limit` bounds both pages. Pending previews share a 4 KB budget within
the overall 80 KB response budget, so use a smaller `limit` for richer previews.

The returned view is intentionally bounded and redacted:

- credential/token-like text is redacted even when general-purpose log redaction is disabled
- thinking signatures, reasoning replay payloads, and inline image data are omitted
- long text blocks are truncated to 4000 characters, with a truncation marker appended
- returned messages are capped at 80 KB; older rows can be dropped or an oversized row replaced with `[sessions_history omitted: message too large]`
- the tool reports summary flags such as `truncated`, `droppedMessages`, `contentTruncated`, `contentRedacted`, `bytes`, and pagination metadata

This is structured history, not the plain-text rendering used by [`/subagents log`](/tools/subagents#slash-command). `sessions_history` does not apply that command's assistant prose sanitizer: reasoning tags, `<relevant-memories>` / `<relevant_memories>` scaffolding, plain-text tool-call XML (including malformed MiniMax XML), downgraded tool markers, and model control tokens can remain in returned message text. `includeTools` controls tool-result messages, not those embedded text forms.

Use the returned **session key** (like `"main"`) with `sessions_history`, `sessions_send`, and `session_status`. To reopen a search hit, also pass its `messageId` and `sessionId` to `sessions_history`; see [Session search](/concepts/session-search). Outside anchored recall, use the durable `sessionId` as the lifecycle identity described above.

If you need the exact raw transcript, inspect the scoped SQLite transcript rows instead of treating `sessions_history` as an unfiltered dump.

Use [`sessions_search`](/concepts/session-search) for exact full-text recall across visible user and assistant transcript text. Its results include a `sessionKey` for a follow-up `sessions_history` call; visibility filtering, snippet redaction, and output bounds match the history boundary.

## Managing session settings and groups

The owner-gated `sessions` tool exposes bounded self-service surfaces:

- `action: "patch"` changes the current session by default, or another visible session selected by `sessionKey`. It can set the label, persistent sidebar `icon`, custom sidebar `group`, pin/archive state, model, and thinking level. Pass `null` or an empty string to clear `group`; assigning a new name creates the group on first use. The icon must be one emoji grapheme or one of the named icons `braces`, `book`, `monitor`, `bot`, `kanban`, and `coins`; pass an empty string to clear it. The Control UI picker also accepts a custom emoji and shows the macOS (Control-Command-Space) or Windows (Windows-period) system emoji picker shortcut. Archiving or restoring another session requires its `sessions_list` `sessionId` as `expectedSessionId`.
- `action: "reset"` resets another visible session selected by `sessionKey`.
- `action: "delete"` first archives and then deletes the exact same generation of another visible session selected by `sessionKey`. By default its transcript is retained as a deleted archive; pass `deleteTranscript: false` to leave the transcript state untouched. Resetting or deleting the session currently running the tool is rejected.
- `action: "assign_owner"` hands session responsibility to a person or agent. Pass `ownerType` (`"human"` or `"agent"`) and `ownerId`; the target is the current session by default, or another visible session via `sessionKey`. Agent owner ids must name a configured agent. The assignment records who reassigned it and when, and the Control UI reflects the new owner immediately. Ownership is display and responsibility, not access control; see [Multi-user mode](/concepts/multi-user).
- `group_list`, `group_set`, `group_rename`, and `group_delete` manage the global ordered session-group catalog. `group_set` (`names`) declaratively replaces the catalog: array order becomes sidebar order, new names are created, and existing empty groups left out of the list are deleted — reorder by passing the complete current list in the new order, and prefer `group_delete` to remove a single group. `group_set` never moves sessions; use `action: "patch"` with `group` for selected memberships. `group_rename` updates all member categories, and `group_delete` clears them. `group_set` rejects dropping a group that still has member sessions; use `group_delete` first.

Interrupted group rename/delete operations retain groups needed by remaining
members. A rename can leave both source and destination groups visible; retry
the operation to finish moving the remaining members.

To apply the same patch to several sessions, pass `targets` with 1–100
`{ sessionKey, expectedSessionId? }` objects instead of top-level `sessionKey`
and `expectedSessionId`. For example:

```json
{
  "action": "patch",
  "targets": [
    { "sessionKey": "agent:main:dashboard:review-api" },
    { "sessionKey": "agent:main:dashboard:review-ui" }
  ],
  "group": "Reviews"
}
```

Each target uses the same visibility rules as a single patch. Supply its
`sessions_list` `sessionId` as `expectedSessionId` to reject a stale selection;
archive and restore require this identity for every target. Valid targets can
succeed when another target fails. The result's `succeeded` and `failed` arrays
contain zero-based indexes into `targets`; bounded `errors` explain failures.
An explicit warning identifies omitted error details. Retry those failed targets
individually when more detail is needed. Duplicate targets that pass these checks
reject the batch before mutation. To archive an eligible current session, use a single patch;
its archive is deferred until the run finishes, while a batch reports that
current-session target as failed and continues with the others.

Use `sessions_spawn` with `visible: true` to create a persistent dashboard session. Pass `group` to place it in a sidebar group atomically; omit `group` or pass an empty string to leave it ungrouped. This keeps session creation on the controlled spawn path, which enforces the parent's tool policy, sandbox, concurrency limits, and run timeout.

If startup or registration fails, cleanup removes only the child created by that spawn. A session reset or replaced meanwhile is preserved. When cleanup cannot be confirmed, the error includes the child session key for inspection before retrying.

An agent-selected model patch stays reversible until that selection completes a successful run. If the selected model is definitively unusable because of authentication, billing, or model-not-found failure, OpenClaw restores the previous model and writes a visible system note. Transient rate-limit, overload, timeout, network, and server failures do not undo the selection.

## Sessions versus conversations

A **session** is local model context. A **conversation** is an exact external address such as one peer, channel, or thread. The two are linked, but they are not interchangeable: direct messages can share one `main` session while retaining separate conversation addresses.

`conversations_list` returns opaque `conversationRef` values for the active agent. With an explicit `channel`, the Gateway also refreshes addresses from that channel's local directory, such as approved Reef peers; use `query` to find a specific peer beyond the current result page. Discovery catalogs the address without creating a model-context session; the backing session is created only when delivery or inbound context needs it. Conversation discovery and delivery are owner-only because they use the Gateway's channel credentials. Use `conversations_send` for fire-and-forget delivery. Use `conversations_turn` when the remote reply belongs to the current model turn: the Gateway reserves one transport message ID, persists a delivery operation and queue intent before transport I/O, and returns the correlated reply from the tool instead of starting a second local agent turn. Delivery operations live outside model transcripts; a captured reply is retained only as a side artifact while the tool result owns model context. If the Gateway restarts after queueing, delivery can recover but a later reply follows ordinary inbound dispatch because the process-local waiter is gone. Unsolicited inbound messages always continue through the normal channel dispatch path.

Use the shared `message` tool when you already have an explicit raw channel target or need a channel-specific action. Conversation references are scoped to the active agent and should be obtained through `conversations_list`, not constructed from session keys.

In Code Mode, the conversation tools reuse their exact Gateway output contracts. A single `exec` cell can list addresses, select a returned `conversationRef`, and call `conversations_send` or `conversations_turn`; normal tool policy and approvals still apply to the nested calls.

## Sending cross-session messages

`sessions_send` runs another session on the same Gateway and optionally waits for the response. Its `sessionKey`, `label`, or `agentId` selects local model context, not an external destination. The resulting reply can still be announced through the established requester or target delivery context; that existing behavior is unchanged. For exact external delivery, use a conversation tool or `message` with an explicit channel and target.

Sessions keep their addresses when execution moves between the Gateway, a paired device, and a cloud worker. An OpenClaw worker can send to an authorized parent, child, or sibling using its exact session key, including a target running on the Gateway. The Gateway validates the current session identities and normal visibility policy before admitting the target turn; target placement does not grant messaging access. Targets outside the configured visibility scope, archived targets, and replaced targets remain denied.

- **Fire-and-forget:** set `timeoutSeconds: 0` to enqueue and return immediately.
- **Wait for reply:** set a timeout and get the response inline.

An accepted result keeps target admission separate from announcement delivery.
`targetDisposition` is `queued` for a new turn or `steered` for an active turn;
`delivery.status` describes only the later announcement as `pending` or `skipped`.
Neither field is a target-completion receipt.

A waited send that finishes without visible assistant text returns `status: "no_reply"`. That is a terminal, intentional non-outcome: no announcement remains pending. Continue without waiting, or send a new message if a response is required.

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

`sessions_yield` intentionally ends the current turn so the next message can be an announced child completion event. Use it for announcing sub-agents, not [Swarm collectors](/tools/swarm): collectors require explicit result collection through `agents_wait` or an awaited `agents.run()` in OpenClaw Code Mode, and send no completion notification.

`subagents` is the session-tree view over native sub-agent runs and the shared background-task ledger. `action: "list"` reports active/recent sub-agents plus scoped ACP, CLI/media, and cron tasks. `action: "cancel"` accepts a returned `taskId` and can stop only work inside the caller's controlled session tree; leaf sub-agents cannot cancel another session's task.

## Spawning sub-agents

`sessions_spawn` creates a separate session for a background task. Non-thread spawns start with isolated context by default; thread-bound spawns follow the configured context policy described below. It returns a `runId` and `childSessionKey` when startup is accepted, without waiting for the child task to finish. Spawns from an OpenClaw cloud worker can first wait for child provisioning and node enrollment. Native sub-agent runs receive their delegated task in a `[Subagent Task]` message appended after any forked history; inherited task envelopes are context, not the current child's assignment. The system prompt carries only sub-agent runtime rules and routing context.

Key options:

- `runtime: "subagent"` (default) or `"acp"` for external harness agents.
- `model` and `thinking` overrides for the child session.
- `runTimeoutSeconds` to override the configured child-run timeout; `0` disables it.
- `thread: true` to bind the spawn to a chat thread (Discord, Slack, etc.).
- `sandbox: "require"` to enforce sandboxing on the child.
- `context: "fork"` when the child needs the current requester transcript; this requires `runtime: "subagent"` and the same agent as the requester, whether the child is hidden or visible. Use `context: "isolated"` explicitly for a clean child. Omission means isolated context for non-thread spawns; thread-bound native sub-agents follow `threadBindings.defaultSpawnContext`, which defaults to `fork`.
- `visible: true` to create a persistent dashboard session instead of a hidden sub-agent session. Visible spawns support an explicit sidebar `group`, model, working directory, same-agent transcript fork, and an optional [managed worktree](/concepts/managed-worktrees); see [Sub-agents](/tools/subagents#tool-parameters) for the exact compatibility limits. The accepted result is a receipt: it includes the child session key, run id, a Control UI `sessionUrl` (omitted when the Control UI is disabled), and an `owner` record naming the requesting agent. When acknowledging the spawn in a channel, put the session URL on the first line and `Owner: <label>` on the second. The spawned session is attributed to the requesting agent in the sidebar; see [Multi-user mode](/concepts/multi-user#agent-spawned-sessions).

Default leaf sub-agents do not get session tools. When `maxSpawnDepth >= 2`, depth-1 orchestrator sub-agents additionally receive `sessions_spawn`, `subagents`, `sessions_list`, and `sessions_history` so they can manage their own children. Leaf runs still do not get recursive orchestration tools.

Ordinary announcing runs return a completion event to the requester. Follow the accepted receipt for other completion modes: collectors require explicit collection, directly routed thread sessions reply in the bound thread, and quiet runs send no completion notification. Announce delivery preserves bound thread/topic routing when available, and if the completion origin only identifies a channel, OpenClaw can still reuse the requester session's stored route (`lastChannel` / `lastTo`) for direct delivery.

For ACP-specific behavior, see [ACP Agents](/tools/acp-agents).

## Visibility

Session tools are scoped to limit what the agent can see:

| Level   | Scope                                                             |
| ------- | ----------------------------------------------------------------- |
| `self`  | Only the current session                                          |
| `tree`  | Current + spawned; when called from main, all same-agent sessions |
| `agent` | All sessions for this agent                                       |
| `all`   | All sessions (cross-agent access is on by default)                |

Default is `all`: unsandboxed sessions, including retained cron sessions, can
list, read, search, message, and inspect status across agents on the Gateway.
This can include other users' transcripts. Cross-agent access is on by default
and governed by `tools.agentToAgent`; set `enabled: false` to block ordinary
cross-agent access or use `allow` to restrict permitted agent pairs; requester-owned native subagent and ACP child sessions stay reachable under `tree` or `all` either way. Set `agent` for same-agent-only
access, or `tree` for current plus spawned scope; its canonical main-session
exception still covers all same-agent sessions. Set `self` for strict
current-session access, including main.

The `agent` scope does not include children owned by another agent.
Keep explicit `tree` when relying on its owned native/ACP child exception, or
use the default `all` with the appropriate `tools.agentToAgent` policy. A sandboxed
caller under the default spawned-only session
tool clamp stays limited to its spawn subtree. Incognito sessions remain hidden
from every cross-session tool. Ambient group watches still add activity notices
and prompt hints; they do not grant access.

## Further reading

- [Session Management](/concepts/session): routing, lifecycle, maintenance
- [Sub-agents](/tools/subagents): child-session lifecycle and delivery
- [ACP Agents](/tools/acp-agents): external harness spawning
- [Multi-agent](/concepts/multi-agent): multi-agent architecture
- [Gateway Configuration](/gateway/configuration): session tool config knobs

## Related

- [Session management](/concepts/session)
- [Session pruning](/concepts/session-pruning)
