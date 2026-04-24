---
summary: "Use ACP runtime sessions for Claude Code, Cursor, Gemini CLI, explicit Codex ACP fallback, OpenClaw ACP, and other harness agents"
read_when:
  - Running coding harnesses through ACP
  - Setting up conversation-bound ACP sessions on messaging channels
  - Binding a message channel conversation to a persistent ACP session
  - Troubleshooting ACP backend and plugin wiring
  - Debugging ACP completion delivery or agent-to-agent loops
  - Operating /acp commands from chat
title: "ACP agents"
---

[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) sessions let OpenClaw run external coding harnesses (for example Pi, Claude Code, Cursor, Copilot, OpenClaw ACP, OpenCode, Gemini CLI, and other supported ACPX harnesses) through an ACP backend plugin.

If you ask OpenClaw in plain language to bind or control Codex in the current conversation, OpenClaw should use the native Codex app-server plugin (`/codex bind`, `/codex threads`, `/codex resume`). If you ask for `/acp`, ACP, acpx, or a Codex background child session, OpenClaw can still route Codex through ACP. Each ACP session spawn is tracked as a [background task](/automation/tasks).

If you ask OpenClaw in plain language to "start Claude Code in a thread" or use another external harness, OpenClaw should route that request to the ACP runtime (not the native sub-agent runtime).

If you want Codex or Claude Code to connect as an external MCP client directly
to existing OpenClaw channel conversations, use [`openclaw mcp serve`](/cli/mcp)
instead of ACP.

## Which page do I want?

There are three nearby surfaces that are easy to confuse:

| You want to...                                                                                  | Use this                              | Notes                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bind or control Codex in the current conversation                                               | `/codex bind`, `/codex threads`       | Native Codex app-server path; includes bound chat replies, image forwarding, model/fast/permissions, stop, and steer controls. ACP is an explicit fallback |
| Run Claude Code, Gemini CLI, explicit Codex ACP, or another external harness _through_ OpenClaw | This page: ACP agents                 | Chat-bound sessions, `/acp spawn`, `sessions_spawn({ runtime: "acp" })`, background tasks, runtime controls                                                |
| Expose an OpenClaw Gateway session _as_ an ACP server for an editor or client                   | [`openclaw acp`](/cli/acp)            | Bridge mode. IDE/client talks ACP to OpenClaw over stdio/WebSocket                                                                                         |
| Reuse a local AI CLI as a text-only fallback model                                              | [CLI Backends](/gateway/cli-backends) | Not ACP. No OpenClaw tools, no ACP controls, no harness runtime                                                                                            |

## Does this work out of the box?

Usually, yes. Fresh installs ship the bundled `acpx` runtime plugin enabled by default, with a plugin-local pinned `acpx` binary that OpenClaw probes and self-repairs on startup. Run `/acp doctor` for a readiness check.

First-run gotchas:

- Target harness adapters (Codex, Claude, etc.) may be fetched on demand with `npx` the first time you use them.
- Vendor auth still has to exist on the host for that harness.
- If the host has no npm or network access, first-run adapter fetches fail until caches are pre-warmed or the adapter is installed another way.

## Operator runbook

Quick `/acp` flow from chat:

1. **Spawn** — `/acp spawn claude --bind here`, `/acp spawn gemini --mode persistent --thread auto`, or explicit `/acp spawn codex --bind here`
2. **Work** in the bound conversation or thread (or target the session key explicitly).
3. **Check state** — `/acp status`
4. **Tune** — `/acp model <provider/model>`, `/acp permissions <profile>`, `/acp timeout <seconds>`
5. **Steer** without replacing context — `/acp steer tighten logging and continue`
6. **Stop** — `/acp cancel` (current turn) or `/acp close` (session + bindings)

Natural-language triggers that should route to the native Codex plugin:

- "Bind this Discord channel to Codex."
- "Attach this chat to Codex thread `<id>`."
- "Show Codex threads, then bind this one."

Native Codex conversation binding is the default chat-control path, but it is intentionally conservative for interactive Codex approval/tool flows: OpenClaw dynamic tools and approval prompts are not exposed through this bound-chat path yet, so those requests are declined with a clear explanation. Use the Codex harness path or explicit ACP fallback when the workflow depends on OpenClaw dynamic tools or long-running interactive approvals.

Natural-language triggers that should route to the ACP runtime:

- "Run this as a one-shot Claude Code ACP session and summarize the result."
- "Use Gemini CLI for this task in a thread, then keep follow-ups in that same thread."
- "Run Codex through ACP in a background thread."

OpenClaw picks `runtime: "acp"`, resolves the harness `agentId`, binds to the current conversation or thread when supported, and routes follow-ups to that session until close/expiry. Codex only follows this path when ACP is explicit or the requested background runtime still needs ACP.

## ACP versus sub-agents

Use ACP when you want an external harness runtime. Use native Codex app-server for Codex conversation binding/control. Use sub-agents when you want OpenClaw-native delegated runs.

| Area          | ACP session                           | Sub-agent run                      |
| ------------- | ------------------------------------- | ---------------------------------- |
| Runtime       | ACP backend plugin (for example acpx) | OpenClaw native sub-agent runtime  |
| Session key   | `agent:<agentId>:acp:<uuid>`          | `agent:<agentId>:subagent:<uuid>`  |
| Main commands | `/acp ...`                            | `/subagents ...`                   |
| Spawn tool    | `sessions_spawn` with `runtime:"acp"` | `sessions_spawn` (default runtime) |

See also [Sub-agents](/tools/subagents).

## How ACP runs Claude Code

For Claude Code through ACP, the stack is:

1. OpenClaw ACP session control plane
2. bundled `acpx` runtime plugin
3. Claude ACP adapter
4. Claude-side runtime/session machinery

Important distinction:

- ACP Claude is a harness session with ACP controls, session resume, background-task tracking, and optional conversation/thread binding.
- CLI backends are separate text-only local fallback runtimes. See [CLI Backends](/gateway/cli-backends).

For operators, the practical rule is:

- want `/acp spawn`, bindable sessions, runtime controls, or persistent harness work: use ACP
- want simple local text fallback through the raw CLI: use CLI backends

## Bound sessions

### Current-conversation binds

`/acp spawn <harness> --bind here` pins the current conversation to the spawned ACP session — no child thread, same chat surface. OpenClaw keeps owning transport, auth, safety, and delivery; follow-up messages in that conversation route to the same session; `/new` and `/reset` reset the session in place; `/acp close` removes the binding.

Mental model:

- **chat surface** — where people keep talking (Discord channel, Telegram topic, iMessage chat).
- **ACP session** — the durable Codex/Claude/Gemini runtime state OpenClaw routes to.
- **child thread/topic** — an optional extra messaging surface created only by `--thread ...`.
- **runtime workspace** — the filesystem location (`cwd`, repo checkout, backend workspace) where the harness runs. Independent of the chat surface.

Examples:

- `/codex bind` — keep this chat, spawn or attach native Codex app-server, route future messages here.
- `/codex model gpt-5.4`, `/codex fast on`, `/codex permissions yolo` — tune the bound native Codex thread from chat.
- `/codex stop` or `/codex steer focus on the failing tests first` — control the active native Codex turn.
- `/acp spawn codex --bind here` — explicit ACP fallback for Codex.
- `/acp spawn codex --thread auto` — OpenClaw may create a child thread/topic and bind there.
- `/acp spawn codex --bind here --cwd /workspace/repo` — same chat binding, Codex runs in `/workspace/repo`.

Notes:

- `--bind here` and `--thread ...` are mutually exclusive.
- `--bind here` only works on channels that advertise current-conversation binding; OpenClaw returns a clear unsupported message otherwise. Bindings persist across gateway restarts.
- On Discord, `spawnAcpSessions` is only required when OpenClaw needs to create a child thread for `--thread auto|here` — not for `--bind here`.
- If you spawn to a different ACP agent without `--cwd`, OpenClaw inherits the **target agent's** workspace by default. Missing inherited paths (`ENOENT`/`ENOTDIR`) fall back to the backend default; other access errors (e.g. `EACCES`) surface as spawn errors.

### Thread-bound sessions

When thread bindings are enabled for a channel adapter, ACP sessions can be bound to threads:

- OpenClaw binds a thread to a target ACP session.
- Follow-up messages in that thread route to the bound ACP session.
- ACP output is delivered back to the same thread.
- Unfocus/close/archive/idle-timeout or max-age expiry removes the binding.

Thread binding support is adapter-specific. If the active channel adapter does not support thread bindings, OpenClaw returns a clear unsupported/unavailable message.

Required feature flags for thread-bound ACP:

- `acp.enabled=true`
- `acp.dispatch.enabled` is on by default (set `false` to pause ACP dispatch)
- Channel-adapter ACP thread-spawn flag enabled (adapter-specific)
  - Discord: `channels.discord.threadBindings.spawnAcpSessions=true`
  - Telegram: `channels.telegram.threadBindings.spawnAcpSessions=true`

### Thread supporting channels

- Any channel adapter that exposes session/thread binding capability.
- Current built-in support:
  - Discord threads/channels
  - Telegram topics (forum topics in groups/supergroups and DM topics)
- Plugin channels can add support through the same binding interface.

## Channel specific settings

For non-ephemeral workflows, configure persistent ACP bindings in top-level `bindings[]` entries.

### Binding model

- `bindings[].type="acp"` marks a persistent ACP conversation binding.
- `bindings[].match` identifies the target conversation:
  - Discord channel or thread: `match.channel="discord"` + `match.peer.id="<channelOrThreadId>"`
  - Telegram forum topic: `match.channel="telegram"` + `match.peer.id="<chatId>:topic:<topicId>"`
  - BlueBubbles DM/group chat: `match.channel="bluebubbles"` + `match.peer.id="<handle|chat_id:*|chat_guid:*|chat_identifier:*>"`
    Prefer `chat_id:*` or `chat_identifier:*` for stable group bindings.
  - iMessage DM/group chat: `match.channel="imessage"` + `match.peer.id="<handle|chat_id:*|chat_guid:*|chat_identifier:*>"`
    Prefer `chat_id:*` for stable group bindings.
- `bindings[].agentId` is the owning OpenClaw agent id.
- Optional ACP overrides live under `bindings[].acp`:
  - `mode` (`persistent` or `oneshot`)
  - `label`
  - `cwd`
  - `backend`

### Runtime defaults per agent

Use `agents.list[].runtime` to define ACP defaults once per agent:

- `agents.list[].runtime.type="acp"`
- `agents.list[].runtime.acp.agent` (harness id, for example `codex` or `claude`)
- `agents.list[].runtime.acp.backend`
- `agents.list[].runtime.acp.mode`
- `agents.list[].runtime.acp.cwd`

Override precedence for ACP bound sessions:

1. `bindings[].acp.*`
2. `agents.list[].runtime.acp.*`
3. global ACP defaults (for example `acp.backend`)

Example:

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

Behavior:

- OpenClaw ensures the configured ACP session exists before use.
- Messages in that channel or topic route to the configured ACP session.
- In bound conversations, `/new` and `/reset` reset the same ACP session key in place.
- Temporary runtime bindings (for example created by thread-focus flows) still apply where present.
- For cross-agent ACP spawns without an explicit `cwd`, OpenClaw inherits the target agent workspace from agent config.
- Missing inherited workspace paths fall back to the backend default cwd; non-missing access failures surface as spawn errors.

## Start ACP sessions (interfaces)

### From `sessions_spawn`

Use `runtime: "acp"` to start an ACP session from an agent turn or tool call.

```json
{
  "task": "Open the repo and summarize failing tests",
  "runtime": "acp",
  "agentId": "codex",
  "thread": true,
  "mode": "session"
}
```

Notes:

- `runtime` defaults to `subagent`, so set `runtime: "acp"` explicitly for ACP sessions.
- If `agentId` is omitted, OpenClaw uses `acp.defaultAgent` when configured.
- `mode: "session"` requires `thread: true` to keep a persistent bound conversation.

Interface details:

- `task` (required): initial prompt sent to the ACP session.
- `runtime` (required for ACP): must be `"acp"`.
- `agentId` (optional): ACP target harness id. Falls back to `acp.defaultAgent` if set.
- `thread` (optional, default `false`): request thread binding flow where supported.
- `mode` (optional): `run` (one-shot) or `session` (persistent).
  - default is `run`
  - if `thread: true` and mode omitted, OpenClaw may default to persistent behavior per runtime path
  - `mode: "session"` requires `thread: true`
- `cwd` (optional): requested runtime working directory (validated by backend/runtime policy). If omitted, ACP spawn inherits the target agent workspace when configured; missing inherited paths fall back to backend defaults, while real access errors are returned.
- `label` (optional): operator-facing label used in session/banner text.
- `resumeSessionId` (optional): resume an existing ACP session instead of creating a new one. The agent replays its conversation history via `session/load`. Requires `runtime: "acp"`.
- `streamTo` (optional): `"parent"` streams initial ACP run progress summaries back to the requester session as system events.
  - When available, accepted responses include `streamLogPath` pointing to a session-scoped JSONL log (`<sessionId>.acp-stream.jsonl`) you can tail for full relay history.
- `model` (optional): explicit model override for the ACP child session. Honored for `runtime: "acp"` so the child uses the requested model instead of silently falling back to the target agent default.

## Delivery model

ACP sessions can be either interactive workspaces or parent-owned background work. The delivery path depends on that shape.

### Interactive ACP sessions

Interactive sessions are meant to keep talking on a visible chat surface:

- `/acp spawn ... --bind here` binds the current conversation to the ACP session.
- `/acp spawn ... --thread ...` binds a channel thread/topic to the ACP session.
- Persistent configured `bindings[].type="acp"` route matching conversations to the same ACP session.

Follow-up messages in the bound conversation route directly to the ACP session, and ACP output is delivered back to that same channel/thread/topic.

### Parent-owned one-shot ACP sessions

One-shot ACP sessions spawned by another agent run are background children, similar to sub-agents:

- The parent asks for work with `sessions_spawn({ runtime: "acp", mode: "run" })`.
- The child runs in its own ACP harness session.
- Completion reports back through the internal task-completion announce path.
- The parent rewrites the child result in normal assistant voice when a user-facing reply is useful.

Do not treat this path as a peer-to-peer chat between parent and child. The child already has a completion channel back to the parent.

### `sessions_send` and A2A delivery

`sessions_send` can target another session after spawn. For normal peer sessions, OpenClaw uses an agent-to-agent (A2A) follow-up path after injecting the message:

- wait for the target session's reply
- optionally let requester and target exchange a bounded number of follow-up turns
- ask the target to produce an announce message
- deliver that announce to the visible channel or thread

That A2A path is a fallback for peer sends where the sender needs a visible follow-up. It stays enabled when an unrelated session can see and message an ACP target, for example under broad `tools.sessions.visibility` settings.

OpenClaw skips the A2A follow-up only when the requester is the parent of its own parent-owned one-shot ACP child. In that case, running A2A on top of task completion can wake the parent with the child's result, forward the parent's reply back into the child, and create a parent/child echo loop. The `sessions_send` result reports `delivery.status="skipped"` for that owned-child case because the completion path is already responsible for the result.

### Resume an existing session

Use `resumeSessionId` to continue a previous ACP session instead of starting fresh. The agent replays its conversation history via `session/load`, so it picks up with full context of what came before.

```json
{
  "task": "Continue where we left off — fix the remaining test failures",
  "runtime": "acp",
  "agentId": "codex",
  "resumeSessionId": "<previous-session-id>"
}
```

Common use cases:

- Hand off a Codex session from your laptop to your phone — tell your agent to pick up where you left off
- Continue a coding session you started interactively in the CLI, now headlessly through your agent
- Pick up work that was interrupted by a gateway restart or idle timeout

Notes:

- `resumeSessionId` requires `runtime: "acp"` — returns an error if used with the sub-agent runtime.
- `resumeSessionId` restores the upstream ACP conversation history; `thread` and `mode` still apply normally to the new OpenClaw session you are creating, so `mode: "session"` still requires `thread: true`.
- The target agent must support `session/load` (Codex and Claude Code do).
- If the session ID isn't found, the spawn fails with a clear error — no silent fallback to a new session.

<Accordion title="Post-deploy smoke test">

After a gateway deploy, run a live end-to-end check rather than trusting unit tests:

1. Verify the deployed gateway version and commit on the target host.
2. Open a temporary ACPX bridge session to a live agent.
3. Ask that agent to call `sessions_spawn` with `runtime: "acp"`, `agentId: "codex"`, `mode: "run"`, and task `Reply with exactly LIVE-ACP-SPAWN-OK`.
4. Verify `accepted=yes`, a real `childSessionKey`, and no validator error.
5. Clean up the temporary bridge session.

Keep the gate on `mode: "run"` and skip `streamTo: "parent"` — thread-bound `mode: "session"` and stream-relay paths are separate richer integration passes.

</Accordion>

## Sandbox compatibility

ACP sessions currently run on the host runtime, not inside the OpenClaw sandbox.

Current limitations:

- If the requester session is sandboxed, ACP spawns are blocked for both `sessions_spawn({ runtime: "acp" })` and `/acp spawn`.
  - Error: `Sandboxed sessions cannot spawn ACP sessions because runtime="acp" runs on the host. Use runtime="subagent" from sandboxed sessions.`
- `sessions_spawn` with `runtime: "acp"` does not support `sandbox: "require"`.
  - Error: `sessions_spawn sandbox="require" is unsupported for runtime="acp" because ACP sessions run outside the sandbox. Use runtime="subagent" or sandbox="inherit".`

Use `runtime: "subagent"` when you need sandbox-enforced execution.

### From `/acp` command

Use `/acp spawn` for explicit operator control from chat when needed.

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

See [Slash Commands](/tools/slash-commands).

## Session target resolution

Most `/acp` actions accept an optional session target (`session-key`, `session-id`, or `session-label`).

Resolution order:

1. Explicit target argument (or `--session` for `/acp steer`)
   - tries key
   - then UUID-shaped session id
   - then label
2. Current thread binding (if this conversation/thread is bound to an ACP session)
3. Current requester session fallback

Current-conversation bindings and thread bindings both participate in step 2.

If no target resolves, OpenClaw returns a clear error (`Unable to resolve session target: ...`).

## Spawn bind modes

`/acp spawn` supports `--bind here|off`.

| Mode   | Behavior                                                               |
| ------ | ---------------------------------------------------------------------- |
| `here` | Bind the current active conversation in place; fail if none is active. |
| `off`  | Do not create a current-conversation binding.                          |

Notes:

- `--bind here` is the simplest operator path for "make this channel or chat Codex-backed."
- `--bind here` does not create a child thread.
- `--bind here` is only available on channels that expose current-conversation binding support.
- `--bind` and `--thread` cannot be combined in the same `/acp spawn` call.

## Spawn thread modes

`/acp spawn` supports `--thread auto|here|off`.

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

`/acp status` shows the effective runtime options plus runtime-level and backend-level session identifiers. Unsupported-control errors surface clearly when a backend lacks a capability. `/acp sessions` reads the store for the current bound or requester session; target tokens (`session-key`, `session-id`, or `session-label`) resolve through gateway session discovery, including custom per-agent `session.store` roots.

## Runtime options mapping

`/acp` has convenience commands and a generic setter.

Equivalent operations:

- `/acp model <id>` maps to runtime config key `model`.
- `/acp permissions <profile>` maps to runtime config key `approval_policy`.
- `/acp timeout <seconds>` maps to runtime config key `timeout`.
- `/acp cwd <path>` updates runtime cwd override directly.
- `/acp set <key> <value>` is the generic path.
  - Special case: `key=cwd` uses the cwd override path.
- `/acp reset-options` clears all runtime overrides for target session.

## acpx harness, plugin setup, and permissions

For acpx harness configuration (Claude Code / Codex / Gemini CLI aliases), the
plugin-tools and OpenClaw-tools MCP bridges, and ACP permission modes, see
[ACP agents — setup](/tools/acp-agents-setup).

## Troubleshooting

| Symptom                                                                     | Likely cause                                                                    | Fix                                                                                                                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ACP runtime backend is not configured`                                     | Backend plugin missing or disabled.                                             | Install and enable backend plugin, then run `/acp doctor`.                                                                                                               |
| `ACP is disabled by policy (acp.enabled=false)`                             | ACP globally disabled.                                                          | Set `acp.enabled=true`.                                                                                                                                                  |
| `ACP dispatch is disabled by policy (acp.dispatch.enabled=false)`           | Dispatch from normal thread messages disabled.                                  | Set `acp.dispatch.enabled=true`.                                                                                                                                         |
| `ACP agent "<id>" is not allowed by policy`                                 | Agent not in allowlist.                                                         | Use allowed `agentId` or update `acp.allowedAgents`.                                                                                                                     |
| `Unable to resolve session target: ...`                                     | Bad key/id/label token.                                                         | Run `/acp sessions`, copy exact key/label, retry.                                                                                                                        |
| `--bind here requires running /acp spawn inside an active ... conversation` | `--bind here` used without an active bindable conversation.                     | Move to the target chat/channel and retry, or use unbound spawn.                                                                                                         |
| `Conversation bindings are unavailable for <channel>.`                      | Adapter lacks current-conversation ACP binding capability.                      | Use `/acp spawn ... --thread ...` where supported, configure top-level `bindings[]`, or move to a supported channel.                                                     |
| `--thread here requires running /acp spawn inside an active ... thread`     | `--thread here` used outside a thread context.                                  | Move to target thread or use `--thread auto`/`off`.                                                                                                                      |
| `Only <user-id> can rebind this channel/conversation/thread.`               | Another user owns the active binding target.                                    | Rebind as owner or use a different conversation or thread.                                                                                                               |
| `Thread bindings are unavailable for <channel>.`                            | Adapter lacks thread binding capability.                                        | Use `--thread off` or move to supported adapter/channel.                                                                                                                 |
| `Sandboxed sessions cannot spawn ACP sessions ...`                          | ACP runtime is host-side; requester session is sandboxed.                       | Use `runtime="subagent"` from sandboxed sessions, or run ACP spawn from a non-sandboxed session.                                                                         |
| `sessions_spawn sandbox="require" is unsupported for runtime="acp" ...`     | `sandbox="require"` requested for ACP runtime.                                  | Use `runtime="subagent"` for required sandboxing, or use ACP with `sandbox="inherit"` from a non-sandboxed session.                                                      |
| Missing ACP metadata for bound session                                      | Stale/deleted ACP session metadata.                                             | Recreate with `/acp spawn`, then rebind/focus thread.                                                                                                                    |
| `AcpRuntimeError: Permission prompt unavailable in non-interactive mode`    | `permissionMode` blocks writes/exec in non-interactive ACP session.             | Set `plugins.entries.acpx.config.permissionMode` to `approve-all` and restart gateway. See [Permission configuration](/tools/acp-agents-setup#permission-configuration). |
| ACP session fails early with little output                                  | Permission prompts are blocked by `permissionMode`/`nonInteractivePermissions`. | Check gateway logs for `AcpRuntimeError`. For full permissions, set `permissionMode=approve-all`; for graceful degradation, set `nonInteractivePermissions=deny`.        |
| ACP session stalls indefinitely after completing work                       | Harness process finished but ACP session did not report completion.             | Monitor with `ps aux \| grep acpx`; kill stale processes manually.                                                                                                       |

## Related

- [Sub-agents](/tools/subagents)
- [Multi-agent sandbox tools](/tools/multi-agent-sandbox-tools)
- [Agent send](/tools/agent-send)
