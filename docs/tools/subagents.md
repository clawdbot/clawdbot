---
summary: "Sub-agents: spawning isolated agent runs that announce results back to the requester chat"
read_when:
  - You want background/parallel work via the agent
  - You are changing sessions_spawn or sub-agent tool policy
  - You are implementing or troubleshooting thread-bound subagent sessions
title: "Sub-agents"
---

Sub-agents are background agent runs spawned from an existing agent run. They run in their own session (`agent:<agentId>:subagent:<uuid>`) and, when finished, **announce** their result back to the requester chat channel. Each sub-agent run is tracked as a [background task](/automation/tasks).

## Slash command

Use `/subagents` to inspect or control sub-agent runs for the **current session**:

- `/subagents list`
- `/subagents kill <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`
- `/subagents steer <id|#> <message>`
- `/subagents spawn <agentId> <task> [--model <model>] [--thinking <level>]`

Thread binding controls:

These commands work on channels that support persistent thread bindings. See **Thread supporting channels** below.

- `/focus <subagent-label|session-key|session-id|session-label>`
- `/unfocus`
- `/agents`
- `/session idle <duration|off>`
- `/session max-age <duration|off>`

`/subagents info` shows run metadata (status, timestamps, session id, transcript path, cleanup).
Use `sessions_history` for a bounded, safety-filtered recall view; inspect the
transcript path on disk when you need the raw full transcript.

### Spawn behavior

`/subagents spawn` starts a background sub-agent as a user command, not an internal relay, and it sends one final completion update back to the requester chat when the run finishes.

- The spawn command is non-blocking; it returns a run id immediately.
- On completion, the sub-agent announces a summary/result message back to the requester chat channel.
- Completion is push-based. Once spawned, do not poll `/subagents list`,
  `sessions_list`, or `sessions_history` in a loop just to wait for it to
  finish; inspect status only on-demand for debugging or intervention.
- On completion, OpenClaw best-effort closes tracked browser tabs/processes opened by that sub-agent session before the announce cleanup flow continues.
- For manual spawns, delivery is resilient:
  - OpenClaw tries direct `agent` delivery first with a stable idempotency key.
  - If direct delivery fails, it falls back to queue routing.
  - If queue routing is still not available, the announce is retried with a short exponential backoff before final give-up.
- Completion delivery keeps the resolved requester route:
  - thread-bound or conversation-bound completion routes win when available
  - if the completion origin only provides a channel, OpenClaw fills the missing target/account from the requester session's resolved route (`lastChannel` / `lastTo` / `lastAccountId`) so direct delivery still works
- The completion handoff to the requester session is runtime-generated internal context (not user-authored text) and includes:
  - `Result` (latest visible `assistant` reply text, otherwise sanitized latest tool/toolResult text; terminal failed runs do not reuse captured reply text)
  - `Status` (`completed successfully` / `failed` / `timed out` / `unknown`)
  - compact runtime/token stats
  - a delivery instruction telling the requester agent to rewrite in normal assistant voice (not forward raw internal metadata)
- `--model` and `--thinking` override defaults for that specific run.
- Use `info`/`log` to inspect details and output after completion.
- `/subagents spawn` is one-shot mode (`mode: "run"`). For persistent thread-bound sessions, use `sessions_spawn` with `thread: true` and `mode: "session"`.
- For ACP harness sessions (Codex, Claude Code, Gemini CLI), use `sessions_spawn` with `runtime: "acp"` and see [ACP Agents](/tools/acp-agents), especially the [ACP delivery model](/tools/acp-agents#delivery-model) when debugging completions or agent-to-agent loops.

Primary goals:

- Parallelize "research / long task / slow tool" work without blocking the main run.
- Keep sub-agents isolated by default (session separation + optional sandboxing).
- Keep the tool surface hard to misuse: sub-agents do **not** get session tools by default.
- Support configurable nesting depth for orchestrator patterns.

Cost note: each sub-agent has its **own** context and token usage by default. For heavy or
repetitive tasks, set a cheaper model for sub-agents and keep your main agent on a
higher-quality model. You can configure this via `agents.defaults.subagents.model` or per-agent
overrides. When a child genuinely needs the requester's current transcript, the agent can request
`context: "fork"` on that one spawn.

## Tool

Use `sessions_spawn`:

- Starts a sub-agent run (`deliver: false`, global lane: `subagent`)
- Then runs an announce step and posts the announce reply to the requester chat channel
- Default model: inherits the caller unless you set `agents.defaults.subagents.model` (or per-agent `agents.list[].subagents.model`); an explicit `sessions_spawn.model` still wins.
- Default thinking: inherits the caller unless you set `agents.defaults.subagents.thinking` (or per-agent `agents.list[].subagents.thinking`); an explicit `sessions_spawn.thinking` still wins.
- Default run timeout: if `sessions_spawn.runTimeoutSeconds` is omitted, OpenClaw uses `agents.defaults.subagents.runTimeoutSeconds` when set; otherwise it falls back to `0` (no timeout).

Tool params:

- `task` (required)
- `label?` (optional)
- `agentId?` (optional; spawn under another agent id if allowed)
- `model?` (optional; overrides the sub-agent model; invalid values are skipped and the sub-agent runs on the default model with a warning in the tool result)
- `thinking?` (optional; overrides thinking level for the sub-agent run)
- `runTimeoutSeconds?` (defaults to `agents.defaults.subagents.runTimeoutSeconds` when set, otherwise `0`; when set, the sub-agent run is aborted after N seconds)
- `thread?` (default `false`; when `true`, requests channel thread binding for this sub-agent session)
- `mode?` (`run|session`)
  - default is `run`
  - if `thread: true` and `mode` omitted, default becomes `session`
  - `mode: "session"` requires `thread: true`
- `cleanup?` (`delete|keep`, default `keep`)
- `sandbox?` (`inherit|require`, default `inherit`; `require` rejects spawn unless target child runtime is sandboxed)
- `context?` (`isolated|fork`, default `isolated`; native sub-agents only)
  - `isolated` creates a clean child transcript and is the default.
  - `fork` branches the requester's current transcript into the child session so the child starts with the same conversation context.
  - Use `fork` only when the child needs the current transcript. For scoped work, omit `context`.
- `sessions_spawn` does **not** accept channel-delivery params (`target`, `channel`, `to`, `threadId`, `replyTo`, `transport`). For delivery, use `message`/`sessions_send` from the spawned run.

## Thread-bound sessions

When thread bindings are enabled for a channel, a sub-agent can stay bound to a thread so follow-up user messages in that thread keep routing to the same sub-agent session.

### Thread supporting channels

- Discord (currently the only supported channel): supports persistent thread-bound subagent sessions (`sessions_spawn` with `thread: true`), manual thread controls (`/focus`, `/unfocus`, `/agents`, `/session idle`, `/session max-age`), and adapter keys `channels.discord.threadBindings.enabled`, `channels.discord.threadBindings.idleHours`, `channels.discord.threadBindings.maxAgeHours`, and `channels.discord.threadBindings.spawnSubagentSessions`.

Quick flow:

1. Spawn with `sessions_spawn` using `thread: true` (and optionally `mode: "session"`).
2. OpenClaw creates or binds a thread to that session target in the active channel.
3. Replies and follow-up messages in that thread route to the bound session.
4. Use `/session idle` to inspect/update inactivity auto-unfocus and `/session max-age` to control the hard cap.
5. Use `/unfocus` to detach manually.

Manual controls:

- `/focus <target>` binds the current thread (or creates one) to a sub-agent/session target.
- `/unfocus` removes the binding for the current bound thread.
- `/agents` lists active runs and binding state (`thread:<id>` or `unbound`).
- `/session idle` and `/session max-age` only work for focused bound threads.

Config switches:

- Global default: `session.threadBindings.enabled`, `session.threadBindings.idleHours`, `session.threadBindings.maxAgeHours`
- Channel override and spawn auto-bind keys are adapter-specific. See **Thread supporting channels** above.

See [Configuration Reference](/gateway/configuration-reference) and [Slash commands](/tools/slash-commands) for current adapter details.

Allowlist:

- `agents.list[].subagents.allowAgents`: list of agent ids that can be targeted via `agentId` (`["*"]` to allow any). Default: only the requester agent.
- `agents.defaults.subagents.allowAgents`: default target-agent allowlist used when the requester agent does not set its own `subagents.allowAgents`.
- Sandbox inheritance guard: if the requester session is sandboxed, `sessions_spawn` rejects targets that would run unsandboxed.
- `agents.defaults.subagents.requireAgentId` / `agents.list[].subagents.requireAgentId`: when true, block `sessions_spawn` calls that omit `agentId` (forces explicit profile selection). Default: false.

Discovery:

- Use `agents_list` to see which agent ids are currently allowed for `sessions_spawn`.

Auto-archive:

- Sub-agent sessions are automatically archived after `agents.defaults.subagents.archiveAfterMinutes` (default: 60).
- Archive uses `sessions.delete` and renames the transcript to `*.deleted.<timestamp>` (same folder).
- `cleanup: "delete"` archives immediately after announce (still keeps the transcript via rename).
- Auto-archive is best-effort; pending timers are lost if the gateway restarts.
- `runTimeoutSeconds` does **not** auto-archive; it only stops the run. The session remains until auto-archive.
- Auto-archive applies equally to depth-1 and depth-2 sessions.
- Browser cleanup is separate from archive cleanup: tracked browser tabs/processes are best-effort closed when the run finishes, even if the transcript/session record is kept.

## Nested Sub-Agents

By default, sub-agents cannot spawn their own sub-agents (`maxSpawnDepth: 1`). You can enable one level of nesting by setting `maxSpawnDepth: 2`, which allows the **orchestrator pattern**: main → orchestrator sub-agent → worker sub-sub-agents.

### How to enable

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxSpawnDepth: 2, // allow sub-agents to spawn children (default: 1)
        maxChildrenPerAgent: 5, // max active children per agent session (default: 5)
        maxConcurrent: 8, // global concurrency lane cap (default: 8)
        runTimeoutSeconds: 900, // default timeout for sessions_spawn when omitted (0 = no timeout)
      },
    },
  },
}
```

### Depth levels

| Depth | Session key shape                            | Role                                          | Can spawn?                   |
| ----- | -------------------------------------------- | --------------------------------------------- | ---------------------------- |
| 0     | `agent:<id>:main`                            | Main agent                                    | Always                       |
| 1     | `agent:<id>:subagent:<uuid>`                 | Sub-agent (orchestrator when depth 2 allowed) | Only if `maxSpawnDepth >= 2` |
| 2     | `agent:<id>:subagent:<uuid>:subagent:<uuid>` | Sub-sub-agent (leaf worker)                   | Never                        |

### Announce chain

Results flow back up the chain:

1. Depth-2 worker finishes → announces to its parent (depth-1 orchestrator)
2. Depth-1 orchestrator receives the announce, synthesizes results, finishes → announces to main
3. Main agent receives the announce and delivers to the user

Each level only sees announces from its direct children.

Operational guidance:

- Start child work once and wait for completion events instead of building poll
  loops around `sessions_list`, `sessions_history`, `/subagents list`, or
  `exec` sleep commands.
- If a child completion event arrives after you already sent the final answer,
  the correct follow-up is the exact silent token `NO_REPLY` / `no_reply`.

### Tool policy by depth

- Role and control scope are written into session metadata at spawn time. That keeps flat or restored session keys from accidentally regaining orchestrator privileges.
- **Depth 1 (orchestrator, when `maxSpawnDepth >= 2`)**: Gets `sessions_spawn`, `subagents`, `sessions_list`, `sessions_history` so it can manage its children. Other session/system tools remain denied.
- **Depth 1 (leaf, when `maxSpawnDepth == 1`)**: No session tools (current default behavior).
- **Depth 2 (leaf worker)**: No session tools — `sessions_spawn` is always denied at depth 2. Cannot spawn further children.

### Per-agent spawn limit

Each agent session (at any depth) can have at most `maxChildrenPerAgent` (default: 5) active children at a time. This prevents runaway fan-out from a single orchestrator.

### Cascade stop

Stopping a depth-1 orchestrator automatically stops all its depth-2 children:

- `/stop` in the main chat stops all depth-1 agents and cascades to their depth-2 children.
- `/subagents kill <id>` stops a specific sub-agent and cascades to its children.
- `/subagents kill all` stops all sub-agents for the requester and cascades.

## Authentication

Sub-agent auth is resolved by **agent id**, not by session type:

- The sub-agent session key is `agent:<agentId>:subagent:<uuid>`.
- The auth store is loaded from that agent's `agentDir`.
- The main agent's auth profiles are merged in as a **fallback**; agent profiles override main profiles on conflicts.

Note: the merge is additive, so main profiles are always available as fallbacks. Fully isolated auth per agent is not supported yet.

## Announce

Sub-agents report back via an announce step:

- The announce step runs inside the sub-agent session (not the requester session).
- If the sub-agent replies exactly `ANNOUNCE_SKIP`, nothing is posted.
- If the latest assistant text is the exact silent token `NO_REPLY` / `no_reply`,
  announce output is suppressed even if earlier visible progress existed.
- Otherwise delivery depends on requester depth:
  - top-level requester sessions use a follow-up `agent` call with external delivery (`deliver=true`)
  - nested requester subagent sessions receive an internal follow-up injection (`deliver=false`) so the orchestrator can synthesize child results in-session
  - if a nested requester subagent session is gone, OpenClaw falls back to that session's requester when available
- For top-level requester sessions, completion-mode direct delivery first resolves any bound conversation/thread route and hook override, then fills missing channel-target fields from the requester session's stored route. That keeps completions on the right chat/topic even when the completion origin only identifies the channel.
- Child completion aggregation is scoped to the current requester run when building nested completion findings, preventing stale prior-run child outputs from leaking into the current announce.
- Announce replies preserve thread/topic routing when available on channel adapters.
- Announce context is normalized to a stable internal event block:
  - source (`subagent` or `cron`)
  - child session key/id
  - announce type + task label
  - status line derived from runtime outcome (`success`, `error`, `timeout`, or `unknown`)
  - result content selected from the latest visible assistant text, otherwise sanitized latest tool/toolResult text; terminal failed runs report failure status without replaying captured reply text
  - a follow-up instruction describing when to reply vs. stay silent
- `Status` is not inferred from model output; it comes from runtime outcome signals.
- On timeout, if the child only got through tool calls, announce can collapse that history into a short partial-progress summary instead of replaying raw tool output.

Announce payloads include a stats line at the end (even when wrapped):

- Runtime (e.g., `runtime 5m12s`)
- Token usage (input/output/total)
- Estimated cost when model pricing is configured (`models.providers.*.models[].cost`)
- `sessionKey`, `sessionId`, and transcript path (so the main agent can fetch history via `sessions_history` or inspect the file on disk)
- Internal metadata is meant for orchestration only; user-facing replies should be rewritten in normal assistant voice.

`sessions_history` is the safer orchestration path:

- assistant recall is normalized first:
  - thinking tags are stripped
  - `<relevant-memories>` / `<relevant_memories>` scaffolding blocks are stripped
  - plain-text tool-call XML payload blocks such as `<tool_call>...</tool_call>`,
    `<function_call>...</function_call>`, `<tool_calls>...</tool_calls>`, and
    `<function_calls>...</function_calls>` are stripped, including truncated
    payloads that never close cleanly
  - downgraded tool-call/result scaffolding and historical-context markers are stripped
  - leaked model control tokens such as `<|assistant|>`, other ASCII
    `<|...|>` tokens, and full-width `<｜...｜>` variants are stripped
  - malformed MiniMax tool-call XML is stripped
- credential/token-like text is redacted
- long blocks can be truncated
- very large histories can drop older rows or replace an oversized row with
  `[sessions_history omitted: message too large]`
- raw on-disk transcript inspection is the fallback when you need the full byte-for-byte transcript

## Tool Policy (sub-agent tools)

By default, sub-agents get **all tools except session tools** and system tools:

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

`sessions_history` remains a bounded, sanitized recall view here too; it is not
a raw transcript dump.

When `maxSpawnDepth >= 2`, depth-1 orchestrator sub-agents additionally receive `sessions_spawn`, `subagents`, `sessions_list`, and `sessions_history` so they can manage their children.

Override via config:

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1,
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // deny wins
        deny: ["gateway", "cron"],
        // if allow is set, it becomes allow-only (deny still wins)
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## Concurrency

Sub-agents use a dedicated in-process queue lane:

- Lane name: `subagent`
- Concurrency: `agents.defaults.subagents.maxConcurrent` (default `8`)

## Stopping

- Sending `/stop` in the requester chat aborts the requester session and stops any active sub-agent runs spawned from it, cascading to nested children.
- `/subagents kill <id>` stops a specific sub-agent and cascades to its children.

## Limitations

- Sub-agent announce is **best-effort**. If the gateway restarts, pending "announce back" work is lost.
- Sub-agents still share the same gateway process resources; treat `maxConcurrent` as a safety valve.
- `sessions_spawn` is always non-blocking: it returns `{ status: "accepted", runId, childSessionKey }` immediately.
- Sub-agent context only injects `AGENTS.md` + `TOOLS.md` (no `SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, or `BOOTSTRAP.md`).
- Maximum nesting depth is 5 (`maxSpawnDepth` range: 1–5). Depth 2 is recommended for most use cases.
- `maxChildrenPerAgent` caps active children per session (default: 5, range: 1–20).

## Related

- [ACP agents](/tools/acp-agents)
- [Multi-agent sandbox tools](/tools/multi-agent-sandbox-tools)
- [Agent send](/tools/agent-send)
