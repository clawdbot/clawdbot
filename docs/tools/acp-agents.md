---
summary: "Run external coding harnesses (Claude Code, Cursor, Gemini CLI, explicit Codex ACP, OpenClaw ACP, OpenCode) through the ACP backend"
read_when:
  - Running coding harnesses through ACP
  - Setting up conversation-bound ACP sessions on messaging channels
  - Binding a message-channel conversation to a persistent ACP session
  - Troubleshooting ACP backend, plugin wiring, or completion delivery
  - Operating /acp commands from chat
title: "ACP agents"
sidebarTitle: "ACP agents"
---

[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) sessions
let OpenClaw run external coding harnesses (for example Pi, Claude Code,
Cursor, Copilot, Droid, OpenClaw ACP, OpenCode, Gemini CLI, and other
supported ACPX harnesses) through an ACP backend plugin.

Each ACP session spawn is tracked as a [background task](/automation/tasks).

<Note>
**ACP is the external-harness path, not the default Codex path.** The
native Codex app-server plugin owns `/codex ...` controls and the
`agentRuntime.id: "codex"` embedded runtime; ACP owns
`/acp ...` controls and `sessions_spawn({ runtime: "acp" })` sessions.

If you want Codex or Claude Code to connect as an external MCP client
directly to existing OpenClaw channel conversations, use
[`openclaw mcp serve`](/cli/mcp) instead of ACP.
</Note>

## Which page do I want?

| You want to…                                                                                    | Use this                              | Notes                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bind or control Codex in the current conversation                                               | `/codex bind`, `/codex threads`       | Native Codex app-server path when the `codex` plugin is enabled; includes bound chat replies, image forwarding, model/fast/permissions, stop, and steer controls. ACP is an explicit fallback |
| Run Claude Code, Gemini CLI, explicit Codex ACP, or another external harness _through_ OpenClaw | This page                             | Chat-bound sessions, `/acp spawn`, `sessions_spawn({ runtime: "acp" })`, background tasks, runtime controls                                                                                   |
| Expose an OpenClaw Gateway session _as_ an ACP server for an editor or client                   | [`openclaw acp`](/cli/acp)            | Bridge mode. IDE/client talks ACP to OpenClaw over stdio/WebSocket                                                                                                                            |
| Reuse a local AI CLI as a text-only fallback model                                              | [CLI Backends](/gateway/cli-backends) | Not ACP. No OpenClaw tools, no ACP controls, no harness runtime                                                                                                                               |

## Does this work out of the box?

Usually yes. Fresh installs ship the bundled `acpx` runtime plugin enabled
by default with a plugin-local pinned `acpx` binary that OpenClaw probes
and self-repairs immediately after the Gateway HTTP listener is live. Run
`/acp doctor` for a readiness check.

OpenClaw only teaches agents about ACP spawning when ACP is **truly
usable**: ACP must be enabled, dispatch must not be disabled, the current
session must not be sandbox-blocked, and a runtime backend must be
loaded. If those conditions are not met, ACP plugin skills and
`sessions_spawn` ACP guidance stay hidden so the agent does not suggest
an unavailable backend.

<AccordionGroup>
  <Accordion title="First-run gotchas">
    - If `plugins.allow` is set, it is a restrictive plugin inventory and **must** include `acpx`; otherwise the bundled default is intentionally blocked and `/acp doctor` reports the missing allowlist entry.
    - The bundled Codex ACP adapter is staged with the `acpx` plugin and launched locally when possible.
    - Other target harness adapters may still be fetched on demand with `npx` the first time you use them.
    - Vendor auth still has to exist on the host for that harness.
    - If the host has no npm or network access, first-run adapter fetches fail until caches are pre-warmed or the adapter is installed another way.

  </Accordion>
  <Accordion title="Runtime prerequisites">
    ACP launches a real external harness process. OpenClaw owns routing,
    background-task state, delivery, bindings, and policy; the harness
    owns its provider login, model catalog, filesystem behavior, and
    native tools.

    Before blaming OpenClaw, verify:

    - `/acp doctor` reports an enabled, healthy backend.
    - The target id is allowed by `acp.allowedAgents` when that allowlist is set.
    - The harness command can start on the Gateway host.
    - Provider auth is present for that harness (`claude`, `codex`, `gemini`, `opencode`, `droid`, etc.).
    - The selected model exists for that harness — model ids are not portable across harnesses.
    - The requested `cwd` exists and is accessible, or omit `cwd` and let the backend use its default.
    - Permission mode matches the work. Non-interactive sessions cannot click native permission prompts, so write/exec-heavy coding runs usually need an ACPX permission profile that can proceed headlessly.

  </Accordion>
</AccordionGroup>

OpenClaw plugin tools and built-in OpenClaw tools are **not** exposed to
ACP harnesses by default. Enable the explicit MCP bridges in
[ACP agents — setup](/tools/acp-agents-setup) only when the harness
should call those tools directly.

## Supported harness targets

With the bundled `acpx` backend, use these harness ids as `/acp spawn <id>`
or `sessions_spawn({ runtime: "acp", agentId: "<id>" })` targets:

| Harness id | Typical backend                                | Notes                                                                               |
| ---------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `claude`   | Claude Code ACP adapter                        | Requires Claude Code auth on the host.                                              |
| `codex`    | Codex ACP adapter                              | Explicit ACP fallback only when native `/codex` is unavailable or ACP is requested. |
| `copilot`  | GitHub Copilot ACP adapter                     | Requires Copilot CLI/runtime auth.                                                  |
| `cursor`   | Cursor CLI ACP (`cursor-agent acp`)            | Override the acpx command if a local install exposes a different ACP entrypoint.    |
| `droid`    | Factory Droid CLI                              | Requires Factory/Droid auth or `FACTORY_API_KEY` in the harness environment.        |
| `gemini`   | Gemini CLI ACP adapter                         | Requires Gemini CLI auth or API key setup.                                          |
| `iflow`    | iFlow CLI                                      | Adapter availability and model control depend on the installed CLI.                 |
| `kilocode` | Kilo Code CLI                                  | Adapter availability and model control depend on the installed CLI.                 |
| `kimi`     | Kimi/Moonshot CLI                              | Requires Kimi/Moonshot auth on the host.                                            |
| `kiro`     | Kiro CLI                                       | Adapter availability and model control depend on the installed CLI.                 |
| `opencode` | OpenCode ACP adapter                           | Requires OpenCode CLI/provider auth.                                                |
| `openclaw` | OpenClaw Gateway bridge through `openclaw acp` | Lets an ACP-aware harness talk back to an OpenClaw Gateway session.                 |
| `pi`       | Pi/embedded OpenClaw runtime                   | Used for OpenClaw-native harness experiments.                                       |
| `qwen`     | Qwen Code / Qwen CLI                           | Requires Qwen-compatible auth on the host.                                          |

Custom acpx agent aliases can be configured in acpx itself, but OpenClaw
policy still checks `acp.allowedAgents` and any
`agents.list[].runtime.acp.agent` mapping before dispatch.

## Operator runbook

Quick `/acp` flow from chat:

<Steps>
  <Step title="Spawn">
    `/acp spawn claude --bind here`,
    `/acp spawn gemini --mode persistent --thread auto`, or explicit
    `/acp spawn codex --bind here`.
  </Step>
  <Step title="Work">
    Continue in the bound conversation or thread (or target the session
    key explicitly).
  </Step>
  <Step title="Check state">
    `/acp status`
  </Step>
  <Step title="Tune">
    `/acp model <provider/model>`,
    `/acp permissions <profile>`,
    `/acp timeout <seconds>`.
  </Step>
  <Step title="Steer">
    Without replacing context: `/acp steer tighten logging and continue`.
  </Step>
  <Step title="Stop">
    `/acp cancel` (current turn) or `/acp close` (session + bindings).
  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Lifecycle details">
    - Spawn creates or resumes an ACP runtime session, records ACP metadata in the OpenClaw session store, and may create a background task when the run is parent-owned.
    - Parent-owned ACP sessions are treated as background work even when the runtime session is persistent; completion and cross-surface delivery go through the parent task notifier rather than acting like a normal user-facing chat session.
    - Task maintenance closes terminal or orphaned parent-owned one-shot ACP sessions. Persistent ACP sessions are preserved while an active conversation binding remains; stale persistent sessions without an active binding are closed so they cannot be silently resumed after the owning task is done or its task record is gone.
    - Bound follow-up messages go directly to the ACP session until the binding is closed, unfocused, reset, or expired.
    - Gateway commands stay local. `/acp ...`, `/status`, and `/unfocus` are never sent as normal prompt text to a bound ACP harness.
    - `cancel` aborts the active turn when the backend supports cancellation; it does not delete the binding or session metadata.
    - `close` ends the ACP session from OpenClaw's point of view and removes the binding. A harness may still keep its own upstream history if it supports resume.
    - Idle runtime workers are eligible for cleanup after `acp.runtime.ttlMinutes`; stored session metadata remains available for `/acp sessions`.

  </Accordion>
  <Accordion title="Native Codex routing rules">
    Natural-language triggers that should route to the **native Codex
    plugin** when it is enabled:

    - "Bind this Discord channel to Codex."
    - "Attach this chat to Codex thread `<id>`."
    - "Show Codex threads, then bind this one."

    Native Codex conversation binding is the default chat-control path.
    OpenClaw dynamic tools still execute through OpenClaw, while
    Codex-native tools such as shell/apply-patch execute inside Codex.
    For Codex-native tool events, OpenClaw injects a per-turn native
    hook relay so plugin hooks can block `before_tool_call`, observe
    `after_tool_call`, and route Codex `PermissionRequest` events
    through OpenClaw approvals. Codex `Stop` hooks are relayed to
    OpenClaw `before_agent_finalize`, where plugins can request one more
    model pass before Codex finalizes its answer. The relay remains
    deliberately conservative: it does not mutate Codex-native tool
    arguments or rewrite Codex thread records. Use explicit ACP only
    when you want the ACP runtime/session model. The embedded Codex
    support boundary is documented in the
    [Codex harness v1 support contract](/plugins/codex-harness#v1-support-contract).

  </Accordion>
  <Accordion title="Model / provider / runtime selection cheat sheet">
    - `openai-codex/*` — PI Codex OAuth/subscription route.
    - `openai/*` plus `agentRuntime.id: "codex"` — native Codex app-server embedded runtime.
    - `/codex ...` — native Codex conversation control.
    - `/acp ...` or `runtime: "acp"` — explicit ACP/acpx control.

  </Accordion>
  <Accordion title="ACP-routing natural-language triggers">
    Triggers that should route to the ACP runtime:

    - "Run this as a one-shot Claude Code ACP session and summarize the result."
    - "Use Gemini CLI for this task in a thread, then keep follow-ups in that same thread."
    - "Run Codex through ACP in a background thread."

    OpenClaw picks `runtime: "acp"`, resolves the harness `agentId`,
    binds to the current conversation or thread when supported, and
    routes follow-ups to that session until close/expiry. Codex only
    follows this path when ACP/acpx is explicit or the native Codex
    plugin is unavailable for the requested operation.

    For `sessions_spawn`, `runtime: "acp"` is advertised only when ACP
    is enabled, the requester is not sandboxed, and an ACP runtime
    backend is loaded. `acp.dispatch.enabled=false` pauses automatic
    ACP thread dispatch but does not hide or block explicit
    `sessions_spawn({ runtime: "acp" })` calls. It targets ACP harness ids such as `codex`,
    `claude`, `droid`, `gemini`, or `opencode`. Do not pass a normal
    OpenClaw config agent id from `agents_list` unless that entry is
    explicitly configured with `agents.list[].runtime.type="acp"`;
    otherwise use the default sub-agent runtime. When an OpenClaw agent
    is configured with `runtime.type="acp"`, OpenClaw uses
    `runtime.acp.agent` as the underlying harness id.

  </Accordion>
</AccordionGroup>

## ACP versus sub-agents

Use ACP when you want an external harness runtime. Use **native Codex
app-server** for Codex conversation binding/control when the `codex`
plugin is enabled. Use **sub-agents** when you want OpenClaw-native
delegated runs.

| Area          | ACP session                           | Sub-agent run                      |
| ------------- | ------------------------------------- | ---------------------------------- |
| Runtime       | ACP backend plugin (for example acpx) | OpenClaw native sub-agent runtime  |
| Session key   | `agent:<agentId>:acp:<uuid>`          | `agent:<agentId>:subagent:<uuid>`  |
| Main commands | `/acp ...`                            | `/subagents ...`                   |
| Spawn tool    | `sessions_spawn` with `runtime:"acp"` | `sessions_spawn` (default runtime) |

See also [Sub-agents](/tools/subagents).

## How ACP runs Claude Code

For Claude Code through ACP, the stack is:

1. OpenClaw ACP session control plane.
2. Bundled `acpx` runtime plugin.
3. Claude ACP adapter.
4. Claude-side runtime/session machinery.

ACP Claude is a **harness session** with ACP controls, session resume,
background-task tracking, and optional conversation/thread binding.

CLI backends are separate text-only local fallback runtimes — see
[CLI Backends](/gateway/cli-backends).

For operators, the practical rule is:

- **Want `/acp spawn`, bindable sessions, runtime controls, or persistent harness work?** Use ACP.
- **Want simple local text fallback through the raw CLI?** Use CLI backends.

## Bound sessions

### Mental model

- **Chat surface** — where people keep talking (Discord channel, Telegram topic, iMessage chat).
- **ACP session** — the durable Codex/Claude/Gemini runtime state OpenClaw routes to.
- **Child thread/topic** — an optional extra messaging surface created only by `--thread ...`.
- **Runtime workspace** — the filesystem location (`cwd`, repo checkout, backend workspace) where the harness runs. Independent of the chat surface.

### Current-conversation binds

`/acp spawn <harness> --bind here` pins the current conversation to the
spawned ACP session — no child thread, same chat surface. OpenClaw keeps
owning transport, auth, safety, and delivery. Follow-up messages in that
conversation route to the same session; `/new` and `/reset` reset the
session in place; `/acp close` removes the binding.

Examples:

```text
/codex bind                                              # native Codex bind, route future messages here
/codex model gpt-5.4                                     # tune the bound native Codex thread
/codex stop                                              # control the active native Codex turn
/acp spawn codex --bind here                             # explicit ACP fallback for Codex
/acp spawn codex --thread auto                           # may create a child thread/topic and bind there
/acp spawn codex --bind here --cwd /workspace/repo       # same chat binding, Codex runs in /workspace/repo
```

<AccordionGroup>
  <Accordion title="Binding rules and exclusivity">
    - `--bind here` and `--thread ...` are mutually exclusive.
    - `--bind here` only works on channels that advertise current-conversation binding; OpenClaw returns a clear unsupported message otherwise. Bindings persist across gateway restarts.
    - On Discord, `spawnAcpSessions` is only required when OpenClaw needs to create a child thread for `--thread auto|here` — not for `--bind here`.
    - If you spawn to a different ACP agent without `--cwd`, OpenClaw inherits the **target agent's** workspace by default. Missing inherited paths (`ENOENT`/`ENOTDIR`) fall back to the backend default; other access errors (e.g. `EACCES`) surface as spawn errors.
    - Gateway management commands stay local in bound conversations — `/acp ...` commands are handled by OpenClaw even when normal follow-up text routes to the bound ACP session; `/status` and `/unfocus` also stay local whenever command handling is enabled for that surface.

  </Accordion>
  <Accordion title="Thread-bound sessions">
    When thread bindings are enabled for a channel adapter:

    - OpenClaw binds a thread to a target ACP session.
    - Follow-up messages in that thread route to the bound ACP session.
    - ACP output is delivered back to the same thread.
    - Unfocus/close/archive/idle-timeout or max-age expiry removes the binding.
    - `/acp close`, `/acp cancel`, `/acp status`, `/status`, and `/unfocus` are Gateway commands, not prompts to the ACP harness.

    Required feature flags for thread-bound ACP:

    - `acp.enabled=true`
    - `acp.dispatch.enabled` is on by default (set `false` to pause automatic ACP thread dispatch; explicit `sessions_spawn({ runtime: "acp" })` calls still work).
    - Channel-adapter ACP thread-spawn flag enabled (adapter-specific):
      - Discord: `channels.discord.threadBindings.spawnAcpSessions=true`
      - Telegram: `channels.telegram.threadBindings.spawnAcpSessions=true`

    Thread binding support is adapter-specific. If the active channel
    adapter does not support thread bindings, OpenClaw returns a clear
    unsupported/unavailable message.

  </Accordion>
  <Accordion title="Thread-supporting channels">
    - Any channel adapter that exposes session/thread binding capability.
    - Current built-in support: **Discord** threads/channels, **Telegram** topics (forum topics in groups/supergroups and DM topics).
    - Plugin channels can add support through the same binding interface.

  </Accordion>
</AccordionGroup>

## Persistent channel bindings

For non-ephemeral workflows, configure persistent ACP bindings in
top-level `bindings[]` entries.

### Binding model

<ParamField path="bindings[].type" type='"acp"'>
  Marks a persistent ACP conversation binding.
</ParamField>
<ParamField path="bindings[].match" type="object">
  Identifies the target conversation. Per-channel shapes:

- **Discord channel/thread:** `match.channel="discord"` + `match.peer.id="<channelOrThreadId>"`
- **Telegram forum topic:** `match.channel="telegram"` + `match.peer.id="<chatId>:topic:<topicId>"`
- **BlueBubbles DM/group:** `match.channel="bluebubbles"` + `match.peer.id="<handle|chat_id:*|chat_guid:*|chat_identifier:*>"`. Prefer `chat_id:*` or `chat_identifier:*` for stable group bindings.
- **iMessage DM/group:** `match.channel="imessage"` + `match.peer.id="<handle|chat_id:*|chat_guid:*|chat_identifier:*>"`. Prefer `chat_id:*` for stable group bindings.

</ParamField>
<ParamField path="bindings[].agentId" type="string">
  The owning OpenClaw agent id.
</ParamField>
<ParamField path="bindings[].acp.mode" type='"persistent" | "oneshot"'>
  Optional ACP override.
</ParamField>
<ParamField path="bindings[].acp.label" type="string">
  Optional operator-facing label.
</ParamField>
<ParamField path="bindings[].acp.cwd" type="string">
  Optional runtime working directory.
</ParamField>
<ParamField path="bindings[].acp.backend" type="string">
  Optional backend override.
</ParamField>

### Runtime defaults per agent

Use `agents.list[].runtime` to define ACP defaults once per agent:

- `agents.list[].runtime.type="acp"`
- `agents.list[].runtime.acp.agent` (harness id, e.g. `codex` or `claude`)
- `agents.list[].runtime.acp.backend`
- `agents.list[].runtime.acp.mode`
- `agents.list[].runtime.acp.cwd`

**Override precedence for ACP bound sessions:**

1. `bindings[].acp.*`
2. `agents.list[].runtime.acp.*`
3. Global ACP defaults (e.g. `acp.backend`)

### Example

```json5
{
  agents: {
    list: [
      {
        id: "codex",
        runtime: {
          type: "acp",
          acp: {
            agent: "codex",
            backend: "acpx",
            mode: "persistent",
            cwd: "/workspace/openclaw",
          },
        },
      },
      {
        id: "claude",
        runtime: {
          type: "acp",
          acp: { agent: "claude", backend: "acpx", mode: "persistent" },
        },
      },
    ],
  },
  bindings: [
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "discord",
        accountId: "default",
        peer: { kind: "channel", id: "222222222222222222" },
      },
      acp: { label: "codex-main" },
    },
    {
      type: "acp",
      agentId: "claude",
      match: {
        channel: "telegram",
        accountId: "default",
        peer: { kind: "group", id: "-1001234567890:topic:42" },
      },
      acp: { cwd: "/workspace/repo-b" },
    },
    {
      type: "route",
      agentId: "main",
      match: { channel: "discord", accountId: "default" },
    },
    {
      type: "route",
      agentId: "main",
      match: { channel: "telegram", accountId: "default" },
    },
  ],
  channels: {
    discord: {
      guilds: {
        "111111111111111111": {
          channels: {
            "222222222222222222": { requireMention: false },
          },
        },
      },
    },
    telegram: {
      groups: {
        "-1001234567890": {
          topics: { "42": { requireMention: false } },
        },
      },
    },
  },
}
```

### Behavior

- OpenClaw ensures the configured ACP session exists before use.
- Messages in that channel or topic route to the configured ACP session.
- In bound conversations, `/new` and `/reset` reset the same ACP session key in place.
- Temporary runtime bindings (for example created by thread-focus flows) still apply where present.
- For cross-agent ACP spawns without an explicit `cwd`, OpenClaw inherits the target agent workspace from agent config.
- Missing inherited workspace paths fall back to the backend default cwd; non-missing access failures surface as spawn errors.

## Start ACP sessions

Two ways to start an ACP session:

<Tabs>
  <Tab title="From sessions_spawn">
    Use `runtime: "acp"` to start an ACP session from an agent turn or
    tool call.

    ```json
    {
      "task": "Open the repo and summarize failing tests",
      "runtime": "acp",
      "agentId": "codex",
      "thread": true,
      "mode": "session"
    }
    ```

    <Note>
    `runtime` defaults to `subagent`, so set `runtime: "acp"` explicitly
    for ACP sessions. If `agentId` is omitted, OpenClaw uses
    `acp.defaultAgent` when configured. `mode: "session"` requires
    `thread: true` to keep a persistent bound conversation.
    </Note>

  </Tab>
  <Tab title="From /acp command">
    Use `/acp spawn` for explicit operator control from chat.

    ```text
    /acp spawn codex --mode persistent --thread auto
    /acp spawn codex --mode oneshot --thread off
    /acp spawn codex --bind here
    /acp spawn codex --thread here
    ```

    Key flags:

    - `--mode persistent|oneshot`
    - `--bind here|off`
    - `--thread auto|here|off`
    - `--cwd <absolute-path>`
    - `--label <name>`

    See [Slash commands](/tools/slash-commands).

  </Tab>
</Tabs>

### `sessions_spawn` parameters

<ParamField path="task" type="string" required>
  Initial prompt sent to the ACP session.
</ParamField>
<ParamField path="runtime" type='"acp"' required>
  Must be `"acp"` for ACP sessions.
</ParamField>
<ParamField path="agentId" type="string">
  ACP target harness id. Falls back to `acp.defaultAgent` if set.
</ParamField>
<ParamField path="thread" type="boolean" default="false">
  Request thread binding flow where supported.
</ParamField>
<ParamField path="mode" type='"run" | "session"' default="run">
  `"run"` is one-shot; `"session"` is persistent. If `thread: true` and
  `mode` is omitted, OpenClaw may default to persistent behaviour per
  runtime path. `mode: "session"` requires `thread: true`.
</ParamField>
<ParamField path="cwd" type="string">
  Requested runtime working directory (validated by backend/runtime
  policy). If omitted, ACP spawn inherits the target agent workspace
  when configured; missing inherited paths fall back to backend
  defaults, while real access errors are returned.
</ParamField>
<ParamField path="label" type="string">
  Operator-facing label used in session/banner text.
</ParamField>
<ParamField path="resumeSessionId" type="string">
  Resume an existing ACP session instead of creating a new one. The
  agent replays its conversation history via `session/load`. Requires
  `runtime: "acp"`.
</ParamField>
<ParamField path="streamTo" type='"parent"'>
  `"parent"` streams initial ACP run progress summaries back to the
  requester session as system events. Accepted responses include
  `streamLogPath` pointing to a session-scoped JSONL log
  (`<sessionId>.acp-stream.jsonl`) you can tail for full relay history.
</ParamField>
<ParamField path="runTimeoutSeconds" type="number">
  Aborts the ACP child turn after N seconds. `0` keeps the turn on the
  gateway's no-timeout path. The same value is applied to the Gateway
  run and ACP runtime so stalled/quota-exhausted harnesses do not
  occupy the parent agent lane indefinitely.
</ParamField>
<ParamField path="model" type="string">
  Explicit model override for the ACP child session. Codex ACP spawns
  normalize OpenClaw Codex refs such as `openai-codex/gpt-5.4` to Codex
  ACP startup config before `session/new`; slash forms such as
  `openai-codex/gpt-5.4/high` also set Codex ACP reasoning effort.
  Other harnesses must advertise ACP `models` and support
  `session/set_model`; otherwise OpenClaw/acpx fails clearly instead of
  silently falling back to the target agent default.
</ParamField>
<ParamField path="thinking" type="string">
  Explicit thinking/reasoning effort. For Codex ACP, `minimal` maps to
  low effort, `low`/`medium`/`high`/`xhigh` map directly, and `off`
  omits the reasoning-effort startup override.
</ParamField>

## Spawn bind and thread modes

<Tabs>
  <Tab title="--bind here|off">
    | Mode   | Behavior                                                               |
    | ------ | ---------------------------------------------------------------------- |
    | `here` | Bind the current active conversation in place; fail if none is active. |
    | `off`  | Do not create a current-conversation binding.                          |

    Notes:

    - `--bind here` is the simplest operator path for "make this channel or chat Codex-backed."
    - `--bind here` does not create a child thread.
    - `--bind here` is only available on channels that expose current-conversation binding support.
    - `--bind` and `--thread` cannot be combined in the same `/acp spawn` call.

  </Tab>
  <Tab title="--thread auto|here|off">
    | Mode   | Behavior                                                                                            |
    | ------ | --------------------------------------------------------------------------------------------------- |
    | `auto` | In an active thread: bind that thread. Outside a thread: create/bind a child thread when supported. |
    | `here` | Require current active thread; fail if not in one.                                                  |
    | `off`  | No binding. Session starts unbound.                                                                 |

    Notes:

    - On non-thread binding surfaces, default behavior is effectively `off`.
    - Thread-bound spawn requires channel policy support:
      - Discord: `channels.discord.threadBindings.spawnAcpSessions=true`
      - Telegram: `channels.telegram.threadBindings.spawnAcpSessions=true`
    - Use `--bind here` when you want to pin the current conversation without creating a child thread.

  </Tab>
</Tabs>

## Delivery model

ACP sessions can be either interactive workspaces or parent-owned
background work. The delivery path depends on that shape.

<AccordionGroup>
  <Accordion title="Interactive ACP sessions">
    Interactive sessions are meant to keep talking on a visible chat
    surface:

    - `/acp spawn ... --bind here` binds the current conversation to the ACP session.
    - `/acp spawn ... --thread ...` binds a channel thread/topic to the ACP session.
    - Persistent configured `bindings[].type="acp"` route matching conversations to the same ACP session.

    Follow-up messages in the bound conversation route directly to the
    ACP session, and ACP output is delivered back to that same
    channel/thread/topic.

    What OpenClaw sends to the harness:

    - Normal bound follow-ups are sent as prompt text, plus attachments only when the harness/backend supports them.
    - `/acp` management commands and local Gateway commands are intercepted before ACP dispatch.
    - Runtime-generated completion events are materialized per target. OpenClaw agents get OpenClaw's internal runtime-context envelope; external ACP harnesses get a plain prompt with the child result and instruction. The raw `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>` envelope should never be sent to external harnesses or persisted as ACP user transcript text.
    - ACP transcript entries use the user-visible trigger text or the plain completion prompt. Internal event metadata stays structured in OpenClaw where possible and is not treated as user-authored chat content.

  </Accordion>
  <Accordion title="Parent-owned one-shot ACP sessions">
    One-shot ACP sessions spawned by another agent run are background
    children, similar to sub-agents:

    - The parent asks for work with `sessions_spawn({ runtime: "acp", mode: "run" })`.
    - The child runs in its own ACP harness session.
    - Child turns run on the same background lane used by native sub-agent spawns, so a slow ACP harness does not block unrelated main-session work.
    - Completion reports back through the task-completion announce path. OpenClaw converts internal completion metadata into a plain ACP prompt before sending it to an external harness, so harnesses do not see OpenClaw-only runtime context markers.
    - The parent rewrites the child result in normal assistant voice when a user-facing reply is useful.

    Do **not** treat this path as a peer-to-peer chat between parent
    and child. The child already has a completion channel back to the
    parent.

  </Accordion>
  <Accordion title="sessions_send and A2A delivery">
    `sessions_send` can target another session after spawn. For normal
    peer sessions, OpenClaw uses an agent-to-agent (A2A) follow-up path
    after injecting the message:

    - Wait for the target session's reply.
    - Optionally let requester and target exchange a bounded number of follow-up turns.
    - Ask the target to produce an announce message.
    - Deliver that announce to the visible channel or thread.

    That A2A path is a fallback for peer sends where the sender needs a
    visible follow-up. It stays enabled when an unrelated session can
    see and message an ACP target, for example under broad
    `tools.sessions.visibility` settings.

    OpenClaw skips the A2A follow-up only when the requester is the
    parent of its own parent-owned one-shot ACP child. In that case,
    running A2A on top of task completion can wake the parent with the
    child's result, forward the parent's reply back into the child, and
    create a parent/child echo loop. The `sessions_send` result reports
    `delivery.status="skipped"` for that owned-child case because the
    completion path is already responsible for the result.

  </Accordion>
  <Accordion title="Resume an existing session">
    Use `resumeSessionId` to continue a previous ACP session instead of
    starting fresh. The agent replays its conversation history via
    `session/load`, so it picks up with full context of what came before.

    ```json
    {
      "task": "Continue where we left off — fix the remaining test failures",
      "runtime": "acp",
      "agentId": "codex",
      "resumeSessionId": "<previous-session-id>"
    }
    ```

    Common use cases:

    - Hand off a Codex session from your laptop to your phone — tell your agent to pick up where you left off.
    - Continue a coding session you started interactively in the CLI, now headlessly through your agent.
    - Pick up work that was interrupted by a gateway restart or idle timeout.

    Notes:

    - `resumeSessionId` only applies when `runtime: "acp"`; the default sub-agent runtime ignores this ACP-only field.
    - `streamTo` only applies when `runtime: "acp"`; the default sub-agent runtime ignores this ACP-only field.
    - `resumeSessionId` is a host-local ACP/harness resume id, not an OpenClaw channel session key; OpenClaw still checks ACP spawn policy and target agent policy before dispatch, while the ACP backend or harness owns authorization for loading that upstream id.
    - `resumeSessionId` restores the upstream ACP conversation history; `thread` and `mode` still apply normally to the new OpenClaw session you are creating, so `mode: "session"` still requires `thread: true`.
    - The target agent must support `session/load` (Codex and Claude Code do).
    - If the session id is not found, the spawn fails with a clear error — no silent fallback to a new session.

  </Accordion>
  <Accordion title="Post-deploy smoke test">
    After a gateway deploy, run a live end-to-end check rather than
    trusting unit tests:

    1. Verify the deployed gateway version and commit on the target host.
    2. Open a temporary ACPX bridge session to a live agent.
    3. Ask that agent to call `sessions_spawn` with `runtime: "acp"`, `agentId: "codex"`, `mode: "run"`, and task `Reply with exactly LIVE-ACP-SPAWN-OK`.
    4. Verify `accepted=yes`, a real `childSessionKey`, and no validator error.
    5. Clean up the temporary bridge session.

    Keep the gate on `mode: "run"` and skip `streamTo: "parent"` —
    thread-bound `mode: "session"` and stream-relay paths are separate
    richer integration passes.

  </Accordion>
</AccordionGroup>

## Sandbox compatibility

ACP sessions currently run on the host runtime, **not** inside the
OpenClaw sandbox.

<Warning>
**Security boundary:**

- The external harness can read/write according to its own CLI permissions and the selected `cwd`.
- OpenClaw's sandbox policy does **not** wrap ACP harness execution.
- OpenClaw still enforces ACP feature gates, allowed agents, session ownership, channel bindings, and Gateway delivery policy.
- Use `runtime: "subagent"` for sandbox-enforced OpenClaw-native work.

</Warning>

Current limitations:

- If the requester session is sandboxed, ACP spawns are blocked for both `sessions_spawn({ runtime: "acp" })` and `/acp spawn`.
- `sessions_spawn` with `runtime: "acp"` does not support `sandbox: "require"`.

## Session target resolution

Most `/acp` actions accept an optional session target (`session-key`,
`session-id`, or `session-label`).

**Resolution order:**

1. Explicit target argument (or `--session` for `/acp steer`)
   - tries key
   - then UUID-shaped session id
   - then label
2. Current thread binding (if this conversation/thread is bound to an ACP session).
3. Current requester session fallback.

Current-conversation bindings and thread bindings both participate in
step 2.

If no target resolves, OpenClaw returns a clear error
(`Unable to resolve session target: ...`).

## ACP controls

| Command              | What it does                                              | Example                                                       |
| -------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| `/acp spawn`         | Create ACP session; optional current bind or thread bind. | `/acp spawn codex --bind here --cwd /repo`                    |
| `/acp cancel`        | Cancel in-flight turn for target session.                 | `/acp cancel agent:codex:acp:<uuid>`                          |
| `/acp steer`         | Send steer instruction to running session.                | `/acp steer --session support inbox prioritize failing tests` |
| `/acp close`         | Close session and unbind thread targets.                  | `/acp close`                                                  |
| `/acp status`        | Show backend, mode, state, runtime options, capabilities. | `/acp status`                                                 |
| `/acp set-mode`      | Set runtime mode for target session.                      | `/acp set-mode plan`                                          |
| `/acp set`           | Generic runtime config option write.                      | `/acp set model openai/gpt-5.4`                               |
| `/acp cwd`           | Set runtime working directory override.                   | `/acp cwd /Users/user/Projects/repo`                          |
| `/acp permissions`   | Set approval policy profile.                              | `/acp permissions strict`                                     |
| `/acp timeout`       | Set runtime timeout (seconds).                            | `/acp timeout 120`                                            |
| `/acp model`         | Set runtime model override.                               | `/acp model anthropic/claude-opus-4-6`                        |
| `/acp reset-options` | Remove session runtime option overrides.                  | `/acp reset-options`                                          |
| `/acp sessions`      | List recent ACP sessions from store.                      | `/acp sessions`                                               |
| `/acp doctor`        | Backend health, capabilities, actionable fixes.           | `/acp doctor`                                                 |
| `/acp install`       | Print deterministic install and enable steps.             | `/acp install`                                                |

`/acp status` shows the effective runtime options plus runtime-level and
backend-level session identifiers. Unsupported-control errors surface
clearly when a backend lacks a capability. `/acp sessions` reads the
store for the current bound or requester session; target tokens
(`session-key`, `session-id`, or `session-label`) resolve through
gateway session discovery, including custom per-agent `session.store`
roots.

### Runtime options mapping

`/acp` has convenience commands and a generic setter. Equivalent
operations:

| Command                      | Maps to                              | Notes                                                                                                                                                                          |
| ---------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/acp model <id>`            | runtime config key `model`           | For Codex ACP, OpenClaw normalizes `openai-codex/<model>` to the adapter model id and maps slash reasoning suffixes such as `openai-codex/gpt-5.4/high` to `reasoning_effort`. |
| `/acp set thinking <level>`  | runtime config key `thinking`        | For Codex ACP, OpenClaw sends the corresponding `reasoning_effort` where the adapter supports one.                                                                             |
| `/acp permissions <profile>` | runtime config key `approval_policy` | —                                                                                                                                                                              |
| `/acp timeout <seconds>`     | runtime config key `timeout`         | —                                                                                                                                                                              |
| `/acp cwd <path>`            | runtime cwd override                 | Direct update.                                                                                                                                                                 |
| `/acp set <key> <value>`     | generic                              | `key=cwd` uses the cwd override path.                                                                                                                                          |
| `/acp reset-options`         | clears all runtime overrides         | —                                                                                                                                                                              |

## acpx harness, plugin setup, and permissions

For acpx harness configuration (Claude Code / Codex / Gemini CLI
aliases), the plugin-tools and OpenClaw-tools MCP bridges, and ACP
permission modes, see
[ACP agents — setup](/tools/acp-agents-setup).

## Troubleshooting

| Symptom                                                                     | Likely cause                                                                                                           | Fix                                                                                                                                                                      |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ACP runtime backend is not configured`                                     | Backend plugin missing, disabled, or blocked by `plugins.allow`.                                                       | Install and enable backend plugin, include `acpx` in `plugins.allow` when that allowlist is set, then run `/acp doctor`.                                                 |
| `ACP is disabled by policy (acp.enabled=false)`                             | ACP globally disabled.                                                                                                 | Set `acp.enabled=true`.                                                                                                                                                  |
| `ACP dispatch is disabled by policy (acp.dispatch.enabled=false)`           | Automatic dispatch from normal thread messages disabled.                                                               | Set `acp.dispatch.enabled=true` to resume automatic thread routing; explicit `sessions_spawn({ runtime: "acp" })` calls still work.                                      |
| `ACP agent "<id>" is not allowed by policy`                                 | Agent not in allowlist.                                                                                                | Use allowed `agentId` or update `acp.allowedAgents`.                                                                                                                     |
| `/acp doctor` reports backend not ready right after startup                 | Plugin dependency probe or self-repair is still running.                                                               | Wait briefly and rerun `/acp doctor`; if it stays unhealthy, inspect the backend install error and plugin allow/deny policy.                                             |
| Harness command not found                                                   | Adapter CLI is not installed, staged plugin deps are missing, or first-run `npx` fetch failed for a non-Codex adapter. | Run `/acp doctor`, repair plugin dependencies, install/prewarm the adapter on the Gateway host, or configure the acpx agent command explicitly.                          |
| Model-not-found from the harness                                            | Model id is valid for another provider/harness but not this ACP target.                                                | Use a model listed by that harness, configure the model in the harness, or omit the override.                                                                            |
| Vendor auth error from the harness                                          | OpenClaw is healthy, but the target CLI/provider is not logged in.                                                     | Log in or provide the required provider key on the Gateway host environment.                                                                                             |
| `Unable to resolve session target: ...`                                     | Bad key/id/label token.                                                                                                | Run `/acp sessions`, copy exact key/label, retry.                                                                                                                        |
| `--bind here requires running /acp spawn inside an active ... conversation` | `--bind here` used without an active bindable conversation.                                                            | Move to the target chat/channel and retry, or use unbound spawn.                                                                                                         |
| `Conversation bindings are unavailable for <channel>.`                      | Adapter lacks current-conversation ACP binding capability.                                                             | Use `/acp spawn ... --thread ...` where supported, configure top-level `bindings[]`, or move to a supported channel.                                                     |
| `--thread here requires running /acp spawn inside an active ... thread`     | `--thread here` used outside a thread context.                                                                         | Move to target thread or use `--thread auto`/`off`.                                                                                                                      |
| `Only <user-id> can rebind this channel/conversation/thread.`               | Another user owns the active binding target.                                                                           | Rebind as owner or use a different conversation or thread.                                                                                                               |
| `Thread bindings are unavailable for <channel>.`                            | Adapter lacks thread binding capability.                                                                               | Use `--thread off` or move to supported adapter/channel.                                                                                                                 |
| `Sandboxed sessions cannot spawn ACP sessions ...`                          | ACP runtime is host-side; requester session is sandboxed.                                                              | Use `runtime="subagent"` from sandboxed sessions, or run ACP spawn from a non-sandboxed session.                                                                         |
| `sessions_spawn sandbox="require" is unsupported for runtime="acp" ...`     | `sandbox="require"` requested for ACP runtime.                                                                         | Use `runtime="subagent"` for required sandboxing, or use ACP with `sandbox="inherit"` from a non-sandboxed session.                                                      |
| `Cannot apply --model ... did not advertise model support`                  | The target harness does not expose generic ACP model switching.                                                        | Use a harness that advertises ACP `models`/`session/set_model`, use Codex ACP model refs, or configure the model directly in the harness if it has its own startup flag. |
| Missing ACP metadata for bound session                                      | Stale/deleted ACP session metadata.                                                                                    | Recreate with `/acp spawn`, then rebind/focus thread.                                                                                                                    |
| `AcpRuntimeError: Permission prompt unavailable in non-interactive mode`    | `permissionMode` blocks writes/exec in non-interactive ACP session.                                                    | Set `plugins.entries.acpx.config.permissionMode` to `approve-all` and restart gateway. See [Permission configuration](/tools/acp-agents-setup#permission-configuration). |
| ACP session fails early with little output                                  | Permission prompts are blocked by `permissionMode`/`nonInteractivePermissions`.                                        | Check gateway logs for `AcpRuntimeError`. For full permissions, set `permissionMode=approve-all`; for graceful degradation, set `nonInteractivePermissions=deny`.        |
| ACP session stalls indefinitely after completing work                       | Harness process finished but ACP session did not report completion.                                                    | Monitor with `ps aux \| grep acpx`; kill stale processes manually.                                                                                                       |
| Harness sees `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>`                        | Internal event envelope leaked across the ACP boundary.                                                                | Update OpenClaw and rerun the completion flow; external harnesses should receive plain completion prompts only.                                                          |

## Related

- [ACP agents — setup](/tools/acp-agents-setup)
- [Agent send](/tools/agent-send)
- [CLI Backends](/gateway/cli-backends)
- [Codex harness](/plugins/codex-harness)
- [Multi-agent sandbox tools](/tools/multi-agent-sandbox-tools)
- [`openclaw acp` (bridge mode)](/cli/acp)
- [Sub-agents](/tools/subagents)
