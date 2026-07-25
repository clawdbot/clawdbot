---
summary: "Spawn isolated background agent runs that announce results back to the requester chat"
read_when:
  - You want background or parallel work via the agent
  - You are changing sessions_spawn or sub-agent tool policy
  - You are implementing or troubleshooting thread-bound subagent sessions
title: "Sub-agents"
sidebarTitle: "Sub-agents"
---

Sub-agents are background agent runs spawned from an existing agent run.
Each one runs in its own session (`agent:<agentId>:subagent:<uuid>`) and,
when finished, **announces** its result back to the requester chat channel.
Every sub-agent run is tracked as a [background task](/automation/tasks).

Goals:

- Parallelize research, long tasks, and slow tool work without blocking the main run.
- Keep sub-agents isolated by default (session separation, optional sandboxing).
- Keep the tool surface hard to misuse: sub-agents do **not** get session or message tools by default.
- Support configurable nesting depth for orchestrator patterns.

<Note>
**Cost note:** each sub-agent has its own context and token usage by
default. For heavy or repetitive tasks, set a cheaper model for sub-agents
and keep your main agent on a higher-quality model via
`agents.defaults.subagents.model` or per-agent overrides. When a child
genuinely needs the requester's current transcript, spawn it with
`context: "fork"`. Thread-bound subagent sessions default to
`context: "fork"` because they branch the current conversation into a
follow-up thread.
</Note>

## Slash command

`/subagents` inspects sub-agent runs for the **current session**:

```text
/subagents list
/subagents log <id|#> [limit] [tools]
/subagents info <id|#>
```

`/subagents info` shows run metadata (status, timestamps, session id,
transcript path, cleanup). `/subagents log` prints recent chat turns for a
run; add the `tools` token to include tool-call/result messages (omitted
by default). Use `sessions_history` for a bounded, safety-filtered recall
view from within an agent turn, or inspect the transcript path on disk for
the raw full transcript.

In the Control UI, parent sessions with recent child runs have an expandable
sidebar row. The nested rows show child status and runtime, and selecting one
opens that child's chat while preserving the parent hierarchy.

### Thread binding controls

These commands work on channels with persistent thread bindings. See
[Thread supporting channels](#thread-supporting-channels) below.

```text
/focus <subagent-label|session-key|session-id|session-label>
/unfocus
/agents
/session idle <duration|off>
/session max-age <duration|off>
```

### Spawn behavior

Agents start background sub-agents with the `sessions_spawn` tool.
Completions return as internal parent-session events; the parent/requester
agent decides whether a user-facing update is needed.

<AccordionGroup>
  <Accordion title="Non-blocking, push-based completion">
    - `sessions_spawn` is non-blocking; it returns a run id immediately.
    - On completion, the sub-agent reports back to the parent/requester session.
    - Agent turns that need child results should call `sessions_yield` after spawning required work. That ends the current turn and lets the completion event arrive as the next model-visible message.
    - Completion is push-based. Once spawned, do **not** poll `/subagents list`, `sessions_list`, or `sessions_history` in a loop just to wait for it to finish; check status on-demand only when debugging.
    - Child output is a report/evidence for the requester agent to synthesize. It is not user-authored instruction text and cannot override system, developer, or user policy.
    - On completion, OpenClaw best-effort closes tracked browser tabs/processes opened by that sub-agent session before the announce cleanup flow continues.

  </Accordion>
  <Accordion title="Completion delivery">
    - OpenClaw hands completions back to the requester session through an `agent` turn with a stable idempotency key.
    - If the requester run is still active, OpenClaw first tries to wake/steer that run instead of starting a second visible reply path.
    - If an active requester cannot be woken, OpenClaw falls back to a requester-agent handoff with the same completion context instead of dropping the announce.
    - A successful parent handoff completes sub-agent delivery even when the parent decides no visible user update is needed.
    - Native sub-agents do not get the message tool. They return plain assistant text to the parent/requester agent; human-visible replies stay owned by the parent/requester agent's normal delivery policy.
    - If direct handoff cannot be used, delivery falls back to queue routing, then to a short exponential-backoff retry of the announce before final give-up.
    - Delivery keeps the resolved requester route: thread-bound or conversation-bound completion routes win when available. If the completion origin only provides a channel, OpenClaw fills the missing target/account from the requester session's resolved route (`lastChannel` / `lastTo` / `lastAccountId`) so direct delivery still works.

  </Accordion>
  <Accordion title="Completion handoff metadata">
    The completion handoff to the requester session is runtime-generated
    internal context (not user-authored text) and includes:

    - `Result` — the latest visible `assistant` reply text from the child. Tool/toolResult output is not promoted into child results. Terminal failed runs do not reuse captured reply text.
    - `Status` — `completed; ready for parent review` / `failed` / `timed out` / `unknown`.
    - Compact runtime/token stats.
    - A review instruction telling the requester agent to verify the result before deciding whether the original task is done.
    - Follow-up guidance telling the requester agent to continue the task or record a follow-up when the child result leaves more action.
    - A final-update instruction for the no-more-action path, written in normal assistant voice without forwarding raw internal metadata.

  </Accordion>
  <Accordion title="Modes and ACP runtime">
    - `--model` and `--thinking` override defaults for that specific run.
    - Use `info`/`log` to inspect details and output after completion.
    - For persistent thread-bound sessions, use `sessions_spawn` with `thread: true` and `mode: "session"`.
    - If the requester channel does not support thread bindings, use `mode: "run"` instead of retrying an impossible thread-bound combination.
    - For ACP harness sessions (Claude Code, Gemini CLI, OpenCode, or explicit Codex ACP/acpx), use `sessions_spawn` with `runtime: "acp"` when the tool advertises that runtime. See [ACP delivery model](/tools/acp-agents#delivery-model) when debugging completions or agent-to-agent loops. When the `codex` plugin is enabled, Codex chat/thread control should prefer `/codex ...` over ACP unless the user explicitly asks for ACP/acpx.
    - OpenClaw hides `runtime: "acp"` until ACP is enabled, the requester is not sandboxed, and a backend plugin such as `acpx` is loaded. `runtime: "acp"` expects an external ACP harness id, or an `agents.entries.*` entry with `runtime.type="acp"`; use the default sub-agent runtime for normal OpenClaw config agents from `agents_list`.

  </Accordion>
</AccordionGroup>

## Context modes

Native sub-agents start isolated unless the caller explicitly asks to fork
the current transcript.

| Mode       | When to use it                                                                                                                         | Behavior                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `isolated` | Fresh research, independent implementation, slow tool work, or anything that can be briefed in the task text                           | Creates a clean child transcript. This is the default and keeps token use lower.  |
| `fork`     | Work that depends on the current conversation, prior tool results, or nuanced instructions already present in the requester transcript | Branches the requester transcript into the child session before the child starts. |

Use `fork` sparingly. It is for context-sensitive delegation, not a
replacement for writing a clear task prompt.

## Tool: `sessions_spawn`

Starts a sub-agent run with `deliver: false` on the global `subagent` lane,
then runs an announce step and posts the announce reply to the requester
chat channel.

Availability depends on the caller's effective tool policy. The built-in
`coding` and `messaging` profiles include `sessions_spawn`,
`sessions_yield`, and `subagents`; `minimal` does not. `full` allows every
tool. Add those tools with `tools.alsoAllow`, or use one of the profiles
above, for an agent on a custom narrower profile that should still
delegate work.
Channel/group, provider, sandbox, and per-agent allow/deny policies can
still remove the tool after the profile stage. Use `/tools` from the same
session to confirm the effective tool list.

**Defaults:**

- **Model:** native sub-agents inherit the caller unless you set `agents.defaults.subagents.model` (or per-agent `agents.entries.*.subagents.model`). ACP runtime spawns use the same configured subagent model when present; otherwise the ACP harness keeps its own default. An explicit `sessions_spawn.model` still wins.
- **Thinking:** native sub-agents inherit the caller unless you set `agents.defaults.subagents.thinking` (or per-agent `agents.entries.*.subagents.thinking`). ACP runtime spawns also apply `agents.defaults.models["provider/model"].params.thinking` for the selected model. An explicit `sessions_spawn.thinking` still wins.
- **Run timeout:** OpenClaw uses `agents.defaults.subagents.runTimeoutSeconds` when set; otherwise it falls back to `0` (no timeout). `sessions_spawn` does not accept per-call timeout overrides.
- **Process lifetime:** a detached OpenClaw sub-agent has its own run lifecycle. A background task created inside an external CLI backend is different: it shares the parent CLI subprocess and stops if that parent reaches `agents.defaults.timeoutSeconds`.
- **Task delivery:** native sub-agents receive the delegated task in their first visible `[Subagent Task]` message. The sub-agent system prompt carries runtime rules and routing context, not a hidden duplicate of the task.

Accepted native sub-agent spawns include the resolved child model metadata
in the tool result: `resolvedModel` contains the applied model ref and
`resolvedProvider` contains the provider prefix when the ref has one.

### Delegation prompt mode

`agents.defaults.subagents.delegationMode` controls prompt guidance only; it does not change tool policy or enforce delegation.

- `suggest` (default): keep the standard prompt nudge to use sub-agents for larger or slower work.
- `prefer`: tell the main agent to stay responsive and delegate anything more involved than a direct reply through `sessions_spawn`.

Per-agent override: `agents.entries.*.subagents.delegationMode`.

```json5
{
  agents: {
    defaults: {
      subagents: {
        delegationMode: "prefer",
        maxConcurrent: 4,
      },
    },
    list: [
      {
        id: "coordinator",
        subagents: { delegationMode: "prefer" },
      },
    ],
  },
}
```

### Tool parameters

<ParamField path="task" type="string" required>
  The task description for the sub-agent.
</ParamField>
<ParamField path="taskName" type="string">
  Optional stable handle for identifying a specific child in later status output. Must match `[a-z][a-z0-9_-]{0,63}` and cannot be a reserved target such as `last` or `all`.
</ParamField>
<ParamField path="label" type="string">
  Optional human-readable label.
</ParamField>
<ParamField path="agentId" type="string">
  Spawn under another configured agent id when allowed by `subagents.allowAgents`.
</ParamField>
<ParamField path="cwd" type="string">
  Optional task working directory for the child run. Native sub-agents still load bootstrap files from the target agent workspace; `cwd` only changes where runtime tools and CLI harnesses do the delegated work.
</ParamField>
<ParamField path="runtime" type='"subagent" | "acp"' default="subagent">
  `acp` is only for external ACP harnesses (`claude`, `droid`, `gemini`, `opencode`, or explicitly requested Codex ACP/acpx) and for `agents.entries.*` entries whose `runtime.type` is `acp`.
</ParamField>
<ParamField path="resumeSessionId" type="string">
  ACP-only. Resumes an existing ACP harness session when `runtime: "acp"`; ignored for native sub-agent spawns.
</ParamField>
<ParamField path="streamTo" type='"parent"'>
  ACP-only. Streams ACP run output to the parent session when `runtime: "acp"`; omit for native sub-agent spawns.
</ParamField>
<ParamField path="model" type="string">
  Override the sub-agent model. Invalid values are skipped and the sub-agent runs on the default model with a warning in the tool result.
</ParamField>
<ParamField path="thinking" type="string">
  Override thinking level for the sub-agent run. Not available with `visible: true`.
</ParamField>
<ParamField path="thread" type="boolean" default="false">
  When `true`, requests channel thread binding for this sub-agent session.
</ParamField>
<ParamField path="mode" type='"run" | "session"' default="run">
  If `thread: true` and `mode` is omitted, default becomes `session`. `mode: "session"` requires `thread: true`.
  If thread binding is unavailable for the requester channel, use `mode: "run"` instead.
  With `visible: true`, omit `mode`; visible sessions are persistent and do not support `mode: "run"`.
</ParamField>
<ParamField path="cleanup" type='"delete" | "keep"' default="keep">
  `"delete"` archives the session immediately after announce (still keeps the transcript via rename).
</ParamField>
<ParamField path="sandbox" type='"inherit" | "require"' default="inherit">
  `require` rejects the spawn unless the target child runtime is sandboxed.
</ParamField>
<ParamField path="context" type='"isolated" | "fork"' default="isolated">
  `fork` branches the requester's current transcript into the child session. Native sub-agents only. Thread-bound spawns default to `fork`; non-thread spawns default to `isolated`. A visible fork must target the same agent as the requester.
</ParamField>
<ParamField path="visible" type="boolean" default="false">
  Create a persistent dashboard session that the user can open in the Control UI. Visible spawns support only `runtime: "subagent"` and always keep the created session.
</ParamField>
<ParamField path="worktree" type="boolean" default="false">
  Provision a managed git worktree for the new dashboard session. Requires `visible: true`.
</ParamField>
<ParamField path="worktreeName" type="string">
  Optional managed-worktree name. Requires `visible: true` and `worktree: true`.
</ParamField>
<ParamField path="worktreeBaseRef" type="string">
  Optional git base ref for the managed worktree. Requires `visible: true` and `worktree: true`.
</ParamField>

<Warning>
`sessions_spawn` does **not** accept channel-delivery params (`target`,
`channel`, `to`, `threadId`, `replyTo`, `transport`). Native sub-agents report
their latest assistant turn back to the requester; external delivery stays with
the parent/requester agent.
</Warning>

With `visible: true`, `model`, `cwd`, and a same-agent `context: "fork"` are supported. A sandboxed target restricts `cwd` to that agent's workspace. Thread binding, `mode`, thinking overrides, `lightContext`, `attachments`, and `attachAs` are unavailable on this path because visible sessions are persistent dashboard sessions created through `sessions.create`. Visible spawning is rejected when the requester was itself spawned with an inherited tool allowlist or denylist; that restriction is fixed at spawn time and has no config override. Session listing and addressing obey `tools.sessions.visibility`; the default `tree` scope covers the current session and its own spawn subtree. See [Managed worktrees](/concepts/managed-worktrees) for checkout naming, setup, cleanup, and restore behavior.

### Task names and targeting

`taskName` is a model-facing handle for orchestration, not a session key.
Use it for stable child names such as `review_subagents`,
`linux_validation`, or `docs_update` when a coordinator may need to inspect
that child later.

Target resolution accepts exact `taskName` matches and unambiguous
prefixes. Matching is scoped to the same active/recent target window used
by numbered `/subagents` targets, so a stale completed child does not make
a reused handle ambiguous. If two active or recent children share the same
`taskName`, the target is ambiguous; use the list index, session key, or
run id instead.

The reserved targets `last` and `all` are not valid `taskName` values
because they already have control meanings.

## Tool: `sessions_yield`

Ends the current model turn and waits for runtime events, primarily
sub-agent completion events, to arrive as the next message. Use it after
spawning required child work when the requester cannot produce a final
answer until those completions arrive.

`sessions_yield` is the waiting primitive. Do not replace it with polling
loops over `subagents`, `sessions_list`, `sessions_history`, shell
`sleep`, or process polling just to detect child completion.

Only use `sessions_yield` when the session's effective tool list includes
it. Some minimal or custom tool profiles may expose `sessions_spawn` and
`subagents` without exposing `sessions_yield`; in that case, do not invent
a polling loop just to wait for completion.

When active children exist, OpenClaw injects a compact runtime-generated
`Active Subagents` prompt block into normal turns so the requester can see
the current child sessions, run ids, statuses, labels, tasks, and
`taskName` aliases without polling. The task and label fields in that
block are quoted as data, not instructions, because they can originate
from user/model-provided spawn arguments.

## Tool: `subagents`

Lists spawned sub-agent runs and background-task records owned by the
requester session tree. The task rows cover native sub-agents, ACP runs,
Gateway CLI/media work, and cron executions. It is scoped to the current
requester; a child can only see its own controlled children.

Use `subagents` for on-demand status and debugging. Use `sessions_yield` to
wait for completion events.

Use `action: "cancel"` with a `taskId` returned by `action: "list"` to stop
a task. Cancellation is confined to the controlled session tree; a leaf
sub-agent cannot cancel work owned by another session.

## Thread-bound sessions

When thread bindings are enabled for a channel, a sub-agent can stay bound
to a thread so follow-up user messages in that thread keep routing to the
same sub-agent session.

### Thread supporting channels

A channel supports persistent thread-bound subagent sessions
(`sessions_spawn` with `thread: true`) when it registers a conversation
binding adapter. Bundled channels with that support: **Discord**,
**iMessage**, **Matrix**, and **Telegram**. Discord and Matrix default to
creating a child thread; Telegram and iMessage default to binding the
current conversation. Use the per-channel `threadBindings` config keys for
enablement, timeouts, and `spawnSessions`.

### Quick flow

<Steps>
  <Step title="Spawn">
    `sessions_spawn` with `thread: true` (and optionally `mode: "session"`).
  </Step>
  <Step title="Bind">
    OpenClaw creates or binds a thread to that session target in the active channel.
  </Step>
  <Step title="Route follow-ups">
    Replies and follow-up messages in that thread route to the bound session.
  </Step>
  <Step title="Inspect timeouts">
    Use `/session idle` to inspect/update inactivity auto-unfocus and
    `/session max-age` to control the hard cap.
  </Step>
  <Step title="Detach">
    Use `/unfocus` to detach manually.
  </Step>
</Steps>

### Manual controls

| Command            | Effect                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `/focus <target>`  | Bind the current thread (or create one) to a sub-agent/session target                     |
| `/unfocus`         | Remove the binding for the current bound thread                                           |
| `/agents`          | List active runs and binding state (`binding:<id>`, `unbound`, or `bindings unavailable`) |
| `/session idle`    | Inspect/update idle auto-unfocus (focused bound threads only)                             |
| `/session max-age` | Inspect/update hard cap (focused bound threads only)                                      |

### Config switches

- **Global default:** `session.threadBindings.enabled`, `session.threadBindings.idleHours`, `session.threadBindings.maxAgeHours`.
- **Channel override and spawn auto-bind keys** are adapter-specific. See [Thread supporting channels](#thread-supporting-channels) above.

See [Configuration reference](/gateway/configuration-reference) and
[Slash commands](/tools/slash-commands) for current adapter details.

### Allowlist

<ParamField path="agents.entries.*.subagents.allowAgents" type="string[]">
  List of configured agent ids that can be targeted via explicit `agentId` (`["*"]` allows any configured target). Default: only the requester agent. If you set a list and still want the requester to spawn itself with `agentId`, include the requester id in the list.
</ParamField>
<ParamField path="agents.defaults.subagents.allowAgents" type="string[]">
  Default configured target-agent allowlist used when the requester agent does not set its own `subagents.allowAgents`.
</ParamField>
<ParamField path="agents.defaults.subagents.requireAgentId" type="boolean" default="false">
  Block `sessions_spawn` calls that omit `agentId` (forces explicit profile selection). Per-agent override: `agents.entries.*.subagents.requireAgentId`.
</ParamField>
<ParamField path="agents.defaults.subagents.announceTimeoutMs" type="number" default="120000">
  Per-call timeout for gateway `agent` announce delivery attempts. Values are positive integer milliseconds and are clamped to the platform-safe timer maximum. Transient retries can make the total announce wait longer than one configured timeout.
</ParamField>

If the requester session is sandboxed, `sessions_spawn` rejects targets
that would run unsandboxed.

### Discovery

Use `agents_list` to see which agent ids are currently allowed for
`sessions_spawn`. The response includes each listed agent's effective
model and embedded runtime metadata so callers can distinguish OpenClaw, Codex
app-server, and other configured native runtimes.

`allowAgents` entries must point at configured agent ids in `agents.entries.*`.
`["*"]` means any configured target agent plus the requester. If an agent config
is deleted but its id remains in `allowAgents`, `sessions_spawn` rejects that id
and `agents_list` omits it. Run `openclaw doctor --fix` to clean stale
allowlist entries, or add a minimal `agents.entries.*` entry when the target should
remain spawnable while inheriting defaults.

### Auto-archive

- Sub-agent sessions are automatically archived after `agents.defaults.subagents.archiveAfterMinutes` (default `60`).
- Archive uses `sessions.delete` and renames the transcript to `*.deleted.<timestamp>` (same folder).
- `cleanup: "delete"` archives immediately after announce (still keeps the transcript via rename).
- Auto-archive is best-effort; pending timers are lost if the gateway restarts.
- Configured run timeouts do **not** auto-archive; they only stop the run. The session remains until auto-archive.
- Auto-archive applies equally to depth-1 and depth-2 sessions.
- Browser cleanup is separate from archive cleanup: tracked browser tabs/processes are best-effort closed when the run finishes, even if the transcript/session record is kept.

## Nested sub-agents

By default, sub-agents cannot spawn their own sub-agents
(`maxSpawnDepth: 1`). Set `maxSpawnDepth: 2` to enable one level of
nesting — the **orchestrator pattern**: main → orchestrator sub-agent →
worker sub-sub-agents.

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxSpawnDepth: 2, // allow sub-agents to spawn children (default: 1, range 1-5)
        maxChildrenPerAgent: 5, // max active children per agent session (default: 5, range 1-20)
        maxConcurrent: 8, // global concurrency lane cap (default: 8)
        runTimeoutSeconds: 900, // default timeout for sessions_spawn (0 = no timeout)
        announceTimeoutMs: 120000, // per-call gateway announce timeout
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

1. Depth-2 worker finishes → announces to its parent (depth-1 orchestrator).
2. Depth-1 orchestrator receives the announce, synthesizes results, finishes → announces to main.
3. Main agent receives the announce and delivers to the user.

Each level only sees announces from its direct children.

<Note>
**Operational guidance:** start child work once and wait for completion
events instead of building poll loops around `sessions_list`,
`sessions_history`, `/subagents list`, or `exec` sleep commands.
`sessions_list` and `/subagents list` keep child-session relationships
focused on live work — live children remain attached, ended children stay
visible for a short recent window, and stale store-only child links are
ignored after their freshness window. This prevents old `spawnedBy` /
`parentSessionKey` metadata from resurrecting ghost children after
restart. If a child completion event arrives after you already sent the
final answer, the correct follow-up is the exact silent token
`NO_REPLY` / `no_reply`.
</Note>

### Tool policy by depth

- A child captures the requester's effective sender policy when it is spawned. Senderless child runs and authenticated operator resumes keep that snapshot even if `toolsBySender` changes later; current global, agent, provider, sandbox, and sub-agent restrictions still apply. A new external channel turn targeting the child re-resolves current sender policy instead.
- Role and control scope are written into session metadata at spawn time. That keeps flat or restored session keys from accidentally regaining orchestrator privileges.
- **Depth 1 (orchestrator, when `maxSpawnDepth >= 2`):** gets `sessions_spawn`, `subagents`, `sessions_list`, `sessions_history` so it can spawn children and inspect their status. Other session/system tools remain denied.
- **Depth 1 (leaf, when `maxSpawnDepth == 1`):** no session tools (current default behavior).
- **Depth 2 (leaf worker):** no session tools — `sessions_spawn` is always denied at depth 2. Cannot spawn further children.

### Per-agent spawn limit

Each agent session (at any depth) can have at most `maxChildrenPerAgent`
(default `5`) active children at a time. This prevents runaway fan-out
from a single orchestrator.

### Cascade stop

Stopping a depth-1 orchestrator automatically stops all its depth-2
children:

- `/stop` in the main chat stops all depth-1 agents and cascades to their depth-2 children.

## Authentication

Sub-agent auth is resolved by **agent id**, not by session type:

- The sub-agent session key is `agent:<agentId>:subagent:<uuid>`.
- The auth store is loaded from that agent's `agentDir`.
- The main agent's auth profiles are merged in as a **fallback**; agent profiles override main profiles on conflicts.

The merge is additive, so main profiles are always available as
fallbacks. Fully isolated auth per agent is not supported yet.

## Announce

Sub-agents report back via an announce step:

- The announce step runs inside the sub-agent session (not the requester session).
- If the sub-agent replies exactly `ANNOUNCE_SKIP`, nothing is posted.
- If the latest assistant text is the exact silent token `NO_REPLY` / `no_reply`, announce output is suppressed even if earlier visible progress existed.

Delivery depends on requester depth:

- Top-level requester sessions use a follow-up `agent` call with external delivery (`deliver=true`).
- Nested requester subagent sessions receive an internal follow-up injection (`deliver=false`) so the orchestrator can synthesize child results in-session.
- If a nested requester subagent session is gone, OpenClaw falls back to that session's requester when available.

For top-level requester sessions, completion-mode direct delivery first
resolves any bound conversation/thread route and hook override, then fills
missing channel-target fields from the requester session's stored route.
That keeps completions on the right chat/topic even when the completion
origin only identifies the channel.

Child completion aggregation is scoped to the current requester run when
building nested completion findings, preventing stale prior-run child
outputs from leaking into the current announce. Announce replies preserve
thread/topic routing when available on channel adapters.

### Announce context

Announce context is normalized to a stable internal event block:

| Field          | Source                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| Source         | `subagent` or `cron`                                                                                     |
| Session ids    | Child session key/id                                                                                     |
| Type           | Announce type + task label                                                                               |
| Status         | Derived from runtime outcome (`ok`, `error`, `timeout`, or `unknown`) — **not** inferred from model text |
| Result content | Latest visible assistant text from the child                                                             |
| Follow-up      | Instruction describing when to reply vs stay silent                                                      |

Terminal failed runs report failure status without replaying captured
reply text. Tool/toolResult output is not promoted into child result text.

### Stats line

Announce payloads include a stats line at the end (even when wrapped):

- Runtime (e.g. `runtime 5m12s`).
- Token usage (input/output/total).
- Estimated cost when model pricing is configured (`models.providers.*.models[].cost`).
- `sessionKey`, `sessionId`, and transcript path so the main agent can fetch history via `sessions_history` or inspect the file on disk.

Internal metadata is meant for orchestration only; user-facing replies
should be rewritten in normal assistant voice.

### Why prefer `sessions_history`

`sessions_history` is the safer orchestration path for reading a child's
transcript from within an agent turn:

- Redacts credential/token-like text even when general-purpose log redaction is disabled.
- Truncates long text blocks (4000 chars per block) and drops thinking signatures, reasoning replay payloads, and inline image data.
- Enforces an 80 KB response cap; oversized rows are replaced with `[sessions_history omitted: message too large]`.
- Use `nextOffset` when present to page backward through older transcript windows.
- `sessions_history` does **not** strip reasoning tags, `<relevant-memories>` scaffolding, or tool-call XML from message text — it returns structured content blocks close to the raw transcript shape, just redacted and size-bounded. `/subagents log` applies the heavier prose sanitizer (strips reasoning tags, memory scaffolding, and tool-call XML) because it renders plain chat lines instead of structured blocks.
- Raw on-disk transcript inspection is the fallback when you need the full byte-for-byte transcript.

## Tool policy

Sub-agents use the same profile and tool-policy pipeline as the parent or
target agent first. After that, OpenClaw applies the sub-agent restriction
layer.

Sub-agents always lose `gateway`, `agents_list`, `session_status`, and
`cron` regardless of depth or role (system-level/interactive tools, or
tools the main agent should coordinate). Leaf sub-agents (default depth-1
behavior, and always at depth 2) additionally lose `subagents`,
`sessions_list`, `sessions_history`, and `sessions_spawn`. Sub-agents never
get the `message` tool — it is disabled at spawn time, not filtered by
this deny list — and `sessions_send` stays denied so sub-agents
communicate only through the announce chain.

`sessions_history` remains a bounded, sanitized recall view here too — it
is not a raw transcript dump.

When `maxSpawnDepth >= 2`, depth-1 orchestrator sub-agents additionally
receive `sessions_spawn`, `subagents`, `sessions_list`, and
`sessions_history` so they can manage their children.

### Override via config

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

`tools.subagents.tools.allow` is a final allow-only filter. It can narrow
the already-resolved tool set, but it cannot **add back** a tool removed
by `tools.profile`. For example, `tools.profile: "coding"` includes
`web_search`/`web_fetch` but not the `browser` tool. To let
coding-profile sub-agents use browser automation, add browser at the
profile stage:

```json5
{
  tools: {
    profile: "coding",
    alsoAllow: ["browser"],
  },
}
```

Use per-agent `agents.entries.*.tools.alsoAllow: ["browser"]` when only one
agent should get browser automation.

## Concurrency

Sub-agents use a dedicated in-process queue lane:

- **Lane name:** `subagent`
- **Concurrency:** `agents.defaults.subagents.maxConcurrent` (default `8`)

## Liveness and recovery

OpenClaw does not treat `endedAt` absence as permanent proof that a
sub-agent is still alive. Unended runs older than the stale-run window
(2 hours, or the configured run timeout plus a short grace period,
whichever is longer) stop counting as active/pending in `/subagents list`,
status summaries, descendant completion gating, and per-session
concurrency checks.

After a gateway restart, stale unended restored runs are pruned unless
their child session is marked `abortedLastRun: true`. Restart-aborted
runs remain registered for the sub-agent orphan recovery flow: stale
runs are finalized without a resume, while fresh child sessions receive
a synthetic resume message before the aborted marker is cleared.

Automatic restart recovery is bounded per child session. If the same
sub-agent child is accepted for orphan recovery repeatedly inside the
rapid re-wedge window, OpenClaw persists a recovery tombstone on that
session and stops auto-resuming it on later restarts. Run
`openclaw tasks maintenance --apply` to reconcile the task record, or
`openclaw doctor --fix` to clear stale aborted recovery flags on
tombstoned sessions.

<Note>
If a sub-agent spawn fails with Gateway `PAIRING_REQUIRED` /
`scope-upgrade`, check the RPC caller before editing pairing state.
Internal `sessions_spawn` coordination dispatches in process when the
caller is already running inside the gateway request context, so it does
not open a loopback WebSocket or depend on the CLI's paired-device scope
baseline. Callers outside the gateway process still use the WebSocket
fallback as `client.id: "gateway-client"` with `client.mode: "backend"`
over direct loopback shared-token/password auth. Remote callers, explicit
`deviceIdentity`, explicit device-token paths, and browser/node clients
still need normal device approval for scope upgrades.
</Note>

## Stopping

- Sending `/stop` in the requester chat aborts the requester session and stops any active sub-agent runs spawned from it, cascading to nested children.

## Limitations

- Sub-agent announce is **best-effort**. If the gateway restarts, pending "announce back" work is lost.
- Sub-agents still share the same gateway process resources; treat `maxConcurrent` as a safety valve.
- `sessions_spawn` is always non-blocking: it returns `{ status: "accepted", runId, childSessionKey }` immediately.
- Sub-agent context only injects `AGENTS.md` and `TOOLS.md` (no `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, `HEARTBEAT.md`, or `BOOTSTRAP.md`). Codex-native subagents follow the same boundary: `TOOLS.md` stays in inherited Codex thread instructions, while parent-only persona, identity, and user files are injected as turn-scoped collaboration instructions so children do not clone them.
- Maximum nesting depth is 5 (`maxSpawnDepth` range: 1-5). Depth 2 is recommended for most use cases.
- `maxChildrenPerAgent` caps active children per session (default `5`, range `1-20`).

## Related

- [Session tools and state changes](/concepts/session-tool)
- [ACP agents](/tools/acp-agents)
- [Agent send](/tools/agent-send)
- [Background tasks](/automation/tasks)
- [Multi-agent sandbox tools](/tools/multi-agent-sandbox-tools)
