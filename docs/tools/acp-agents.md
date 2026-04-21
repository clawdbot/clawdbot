---
summary: "Use ACP runtime sessions for Codex, Claude Code, Cursor, Gemini CLI, OpenClaw ACP, and other harness agents"
read_when:
  - Running coding harnesses through ACP
  - Setting up conversation-bound ACP sessions on messaging channels
  - Binding a message channel conversation to a persistent ACP session
  - Troubleshooting ACP backend and plugin wiring
  - Operating /acp commands from chat
title: "ACP Agents"
---

# ACP agents

[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) sessions let OpenClaw run external coding harnesses (for example Pi, Claude Code, Codex, Cursor, Copilot, OpenClaw ACP, OpenCode, Gemini CLI, and other supported ACPX harnesses) through an ACP backend plugin.

If you ask OpenClaw in plain language to "run this in Codex" or "start Claude Code in a thread", OpenClaw should route that request to the ACP runtime (not the native sub-agent runtime). Each ACP session spawn is tracked as a [background task](/automation/tasks).

If you want Codex or Claude Code to connect as an external MCP client directly
to existing OpenClaw channel conversations, use [`openclaw mcp serve`](/cli/mcp)
instead of ACP.

## Which page do I want?

There are three nearby surfaces that are easy to confuse:

| You want to...                                                                     | Use this                              | Notes                                                                                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Run Codex, Claude Code, Gemini CLI, or another external harness _through_ OpenClaw | This page: ACP agents                 | Chat-bound sessions, `/acp spawn`, `sessions_spawn({ runtime: "acp" })`, background tasks, runtime controls |
| Expose an OpenClaw Gateway session _as_ an ACP server for an editor or client      | [`openclaw acp`](/cli/acp)            | Bridge mode. IDE/client talks ACP to OpenClaw over stdio/WebSocket                                          |
| Reuse a local AI CLI as a text-only fallback model                                 | [CLI Backends](/gateway/cli-backends) | Not ACP. No OpenClaw tools, no ACP controls, no harness runtime                                             |

## Does this work out of the box?

Usually, yes.

- Fresh installs now ship the bundled `acpx` runtime plugin enabled by default.
- The bundled `acpx` plugin prefers its plugin-local pinned `acpx` binary.
- On startup, OpenClaw probes that binary and self-repairs it if needed.
- Start with `/acp doctor` if you want a fast readiness check.

What can still happen on first use:

- A target harness adapter may be fetched on demand with `npx` the first time you use that harness.
- Vendor auth still has to exist on the host for that harness.
- If the host has no npm/network access, first-run adapter fetches can fail until caches are pre-warmed or the adapter is installed another way.

Examples:

- `/acp spawn codex`: OpenClaw should be ready to bootstrap `acpx`, but the Codex ACP adapter may still need a first-run fetch.
- `/acp spawn claude`: same story for the Claude ACP adapter, plus Claude-side auth on that host.

## Fast operator flow

Use this when you want a practical `/acp` runbook:

1. Spawn a session:
   - `/acp spawn codex --bind here`
   - `/acp spawn codex --mode persistent --thread auto`
2. Work in the bound conversation or thread (or target that session key explicitly).
3. Check runtime state:
   - `/acp status`
4. Tune runtime options as needed:
   - `/acp model <provider/model>`
   - `/acp permissions <profile>`
   - `/acp timeout <seconds>`
5. Nudge an active session without replacing context:
   - `/acp steer tighten logging and continue`
6. Stop work:
   - `/acp cancel` (stop current turn), or
   - `/acp close` (close session + remove bindings)

## Quick start for humans

Examples of natural requests:

- "Bind this Discord channel to Codex."
- "Start a persistent Codex session in a thread here and keep it focused."
- "Run this as a one-shot Claude Code ACP session and summarize the result."
- "Bind this iMessage chat to Codex and keep follow-ups in the same workspace."
- "Use Gemini CLI for this task in a thread, then keep follow-ups in that same thread."

What OpenClaw should do:

1. Pick `runtime: "acp"`.
2. Resolve the requested harness target (`agentId`, for example `codex`).
3. If current-conversation binding is requested and the active channel supports it, bind the ACP session to that conversation.
4. Otherwise, if thread binding is requested and the current channel supports it, bind the ACP session to the thread.
5. Route follow-up bound messages to that same ACP session until unfocused/closed/expired.

## ACP versus sub-agents

Use ACP when you want an external harness runtime. Use sub-agents when you want OpenClaw-native delegated runs.

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

Use `/acp spawn <harness> --bind here` when you want the current conversation to become a durable ACP workspace without creating a child thread.

Behavior:

- OpenClaw keeps owning the channel transport, auth, safety, and delivery.
- The current conversation is pinned to the spawned ACP session key.
- Follow-up messages in that conversation route to the same ACP session.
- `/new` and `/reset` reset the same bound ACP session in place.
- `/acp close` closes the session and removes the current-conversation binding.

What this means in practice:

- `--bind here` keeps the same chat surface. On Discord, the current channel stays the current channel.
- `--bind here` can still create a new ACP session if you are spawning fresh work. The bind attaches that session to the current conversation.
- `--bind here` does not create a child Discord thread or Telegram topic by itself.
- The ACP runtime can still have its own working directory (`cwd`) or backend-managed workspace on disk. That runtime workspace is separate from the chat surface and does not imply a new messaging thread.
- If you spawn to a different ACP agent and do not pass `--cwd`, OpenClaw inherits the **target agent's** workspace by default, not the requester's.
- If that inherited workspace path is missing (`ENOENT`/`ENOTDIR`), OpenClaw falls back to the backend default cwd instead of silently reusing the wrong tree.
- If the inherited workspace exists but cannot be accessed (for example `EACCES`), spawn returns the real access error instead of dropping `cwd`.

Mental model:

- chat surface: where people keep talking (`Discord channel`, `Telegram topic`, `iMessage chat`)
- ACP session: the durable Codex/Claude/Gemini runtime state OpenClaw routes to
- child thread/topic: an optional extra messaging surface created only by `--thread ...`
- runtime workspace: the filesystem location where the harness runs (`cwd`, repo checkout, backend workspace)

Examples:

- `/acp spawn codex --bind here`: keep this chat, spawn or attach a Codex ACP session, and route future messages here to it
- `/acp spawn codex --thread auto`: OpenClaw may create a child thread/topic and bind the ACP session there
- `/acp spawn codex --bind here --cwd /workspace/repo`: same chat binding as above, but Codex runs in `/workspace/repo`

Current-conversation binding support:

- Chat/message channels that advertise current-conversation binding support can use `--bind here` through the shared conversation-binding path.
- Channels with custom thread/topic semantics can still provide channel-specific canonicalization behind the same shared interface.
- `--bind here` always means "bind the current conversation in place".
- Generic current-conversation binds use the shared OpenClaw binding store and survive normal gateway restarts.

Notes:

- `--bind here` and `--thread ...` are mutually exclusive on `/acp spawn`.
- On Discord, `--bind here` binds the current channel or thread in place. `spawnAcpSessions` is only required when OpenClaw needs to create a child thread for `--thread auto|here`.
- If the active channel does not expose current-conversation ACP bindings, OpenClaw returns a clear unsupported message.
- `resume` and "new session" questions are ACP-session questions, not channel questions. You can reuse or replace runtime state without changing the current chat surface.

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

### Operator smoke test

Use this after a gateway deploy when you want a quick live check that ACP spawn
is actually working end-to-end, not just passing unit tests.

Recommended gate:

1. Verify the deployed gateway version/commit on the target host.
2. Confirm the deployed source includes the ACP lineage acceptance in
   `src/gateway/sessions-patch.ts` (`subagent:* or acp:* sessions`).
3. Open a temporary ACPX bridge session to a live agent (for example
   `razor(main)` on `jpclawhq`).
4. Ask that agent to call `sessions_spawn` with:
   - `runtime: "acp"`
   - `agentId: "codex"`
   - `mode: "run"`
   - task: `Reply with exactly LIVE-ACP-SPAWN-OK`
5. Verify the agent reports:
   - `accepted=yes`
   - a real `childSessionKey`
   - no validator error
6. Clean up the temporary ACPX bridge session.

Example prompt to the live agent:

```text
Use the sessions_spawn tool now with runtime: "acp", agentId: "codex", and mode: "run".
Set the task to: "Reply with exactly LIVE-ACP-SPAWN-OK".
Then report only: accepted=<yes/no>; childSessionKey=<value or none>; error=<exact text or none>.
```

Notes:

- Keep this smoke test on `mode: "run"` unless you are intentionally testing
  thread-bound persistent ACP sessions.
- Do not require `streamTo: "parent"` for the basic gate. That path depends on
  requester/session capabilities and is a separate integration check.
- Treat thread-bound `mode: "session"` testing as a second, richer integration
  pass from a real Discord thread or Telegram topic.

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

Available command family:

- `/acp spawn`
- `/acp cancel`
- `/acp steer`
- `/acp close`
- `/acp status`
- `/acp set-mode`
- `/acp set`
- `/acp cwd`
- `/acp permissions`
- `/acp timeout`
- `/acp model`
- `/acp reset-options`
- `/acp sessions`
- `/acp doctor`
- `/acp install`

`/acp status` shows the effective runtime options and, when available, both runtime-level and backend-level session identifiers.

Some controls depend on backend capabilities. If a backend does not support a control, OpenClaw returns a clear unsupported-control error.

## ACP command cookbook

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

`/acp sessions` reads the store for the current bound or requester session. Commands that accept `session-key`, `session-id`, or `session-label` tokens resolve targets through gateway session discovery, including custom per-agent `session.store` roots.

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

## acpx harness support (current)

Current acpx built-in harness aliases:

- `claude`
- `codex`
- `copilot`
- `cursor` (Cursor CLI: `cursor-agent acp`)
- `droid`
- `gemini`
- `iflow`
- `kilocode`
- `kimi`
- `kiro`
- `openclaw`
- `opencode`
- `pi`
- `qwen`

When OpenClaw uses the acpx backend, prefer these values for `agentId` unless your acpx config defines custom agent aliases.
If your local Cursor install still exposes ACP as `agent acp`, override the `cursor` agent command in your acpx config instead of changing the built-in default.

Direct acpx CLI usage can also target arbitrary adapters via `--agent <command>`, but that raw escape hatch is an acpx CLI feature (not the normal OpenClaw `agentId` path).

## Required config

Core ACP baseline:

```json5
{
  acp: {
    enabled: true,
    // Optional. Default is true; set false to pause ACP dispatch while keeping /acp controls.
    dispatch: { enabled: true },
    backend: "acpx",
    defaultAgent: "codex",
    allowedAgents: [
      "claude",
      "codex",
      "copilot",
      "cursor",
      "droid",
      "gemini",
      "iflow",
      "kilocode",
      "kimi",
      "kiro",
      "openclaw",
      "opencode",
      "pi",
      "qwen",
    ],
    maxConcurrentSessions: 8,
    stream: {
      coalesceIdleMs: 300,
      maxChunkChars: 1200,
    },
    runtime: {
      ttlMinutes: 120,
    },
  },
}
```

Thread binding config is channel-adapter specific. Example for Discord:

```json5
{
  session: {
    threadBindings: {
      enabled: true,
      idleHours: 24,
      maxAgeHours: 0,
    },
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
        spawnAcpSessions: true,
      },
    },
  },
}
```

If thread-bound ACP spawn does not work, verify the adapter feature flag first:

- Discord: `channels.discord.threadBindings.spawnAcpSessions=true`

Current-conversation binds do not require child-thread creation. They require an active conversation context and a channel adapter that exposes ACP conversation bindings.

See [Configuration Reference](/gateway/configuration-reference).

## Plugin setup for acpx backend

Fresh installs ship the bundled `acpx` runtime plugin enabled by default, so ACP
usually works without a manual plugin install step.

Start with:

```text
/acp doctor
```

If you disabled `acpx`, denied it via `plugins.allow` / `plugins.deny`, or want
to switch to a local development checkout, use the explicit plugin path:

```bash
openclaw plugins install acpx
openclaw config set plugins.entries.acpx.enabled true
```

Local workspace install during development:

```bash
openclaw plugins install ./path/to/local/acpx-plugin
```

Then verify backend health:

```text
/acp doctor
```

### acpx command and version configuration

By default, the bundled acpx backend plugin (`acpx`) uses the plugin-local pinned binary:

1. Command defaults to the plugin-local `node_modules/.bin/acpx` inside the ACPX plugin package.
2. Expected version defaults to the extension pin.
3. Startup registers ACP backend immediately as not-ready.
4. A background ensure job verifies `acpx --version`.
5. If the plugin-local binary is missing or mismatched, it runs:
   `npm install --omit=dev --no-save acpx@<pinned>` and re-verifies.

You can override command/version in plugin config:

```json
{
  "plugins": {
    "entries": {
      "acpx": {
        "enabled": true,
        "config": {
          "command": "../acpx/dist/cli.js",
          "expectedVersion": "any"
        }
      }
    }
  }
}
```

Notes:

- `command` accepts an absolute path, relative path, or command name (`acpx`).
- Relative paths resolve from OpenClaw workspace directory.
- `expectedVersion: "any"` disables strict version matching.
- When `command` points to a custom binary/path, plugin-local auto-install is disabled.
- OpenClaw startup remains non-blocking while the backend health check runs.

See [Plugins](/tools/plugin).

### Automatic dependency install

When you install OpenClaw globally with `npm install -g openclaw`, the acpx
runtime dependencies (platform-specific binaries) are installed automatically
via a postinstall hook. If the automatic install fails, the gateway still starts
normally and reports the missing dependency through `openclaw acp doctor`.

### Plugin tools MCP bridge

By default, ACPX sessions do **not** expose OpenClaw plugin-registered tools to
the ACP harness.

If you want ACP agents such as Codex or Claude Code to call installed
OpenClaw plugin tools such as memory recall/store, enable the dedicated bridge:

```bash
openclaw config set plugins.entries.acpx.config.pluginToolsMcpBridge true
```

What this does:

- Injects a built-in MCP server named `openclaw-plugin-tools` into ACPX session
  bootstrap.
- Exposes plugin tools already registered by installed and enabled OpenClaw
  plugins.
- Keeps the feature explicit and default-off.

Security and trust notes:

- This expands the ACP harness tool surface.
- ACP agents get access only to plugin tools already active in the gateway.
- Treat this as the same trust boundary as letting those plugins execute in
  OpenClaw itself.
- Review installed plugins before enabling it.

Custom `mcpServers` still work as before. The built-in plugin-tools bridge is an
additional opt-in convenience, not a replacement for generic MCP server config.

### Runtime timeout configuration

The bundled `acpx` plugin defaults embedded runtime turns to a 120-second
timeout. This gives slower harnesses such as Gemini CLI enough time to complete
ACP startup and initialization. Override it if your host needs a different
runtime limit:

```bash
openclaw config set plugins.entries.acpx.config.timeoutSeconds 180
```

Restart the gateway after changing this value.

### Health probe agent configuration

The bundled `acpx` plugin probes one harness agent while deciding whether the
embedded runtime backend is ready. It defaults to `codex`. If your deployment
uses a different default ACP agent, set the probe agent to the same id:

```bash
openclaw config set plugins.entries.acpx.config.probeAgent claude
```

Restart the gateway after changing this value.

## Permission configuration

ACP sessions run non-interactively — there is no TTY to approve or deny file-write and shell-exec permission prompts. The acpx plugin provides two config keys that control how permissions are handled:

These ACPX harness permissions are separate from OpenClaw exec approvals and separate from CLI-backend vendor bypass flags such as Claude CLI `--permission-mode bypassPermissions`. ACPX `approve-all` is the harness-level break-glass switch for ACP sessions.

### `permissionMode`

Controls which operations the harness agent can perform without prompting.

| Value           | Behavior                                                  |
| --------------- | --------------------------------------------------------- |
| `approve-all`   | Auto-approve all file writes and shell commands.          |
| `approve-reads` | Auto-approve reads only; writes and exec require prompts. |
| `deny-all`      | Deny all permission prompts.                              |

### `nonInteractivePermissions`

Controls what happens when a permission prompt would be shown but no interactive TTY is available (which is always the case for ACP sessions).

| Value  | Behavior                                                          |
| ------ | ----------------------------------------------------------------- |
| `fail` | Abort the session with `AcpRuntimeError`. **(default)**           |
| `deny` | Silently deny the permission and continue (graceful degradation). |

### Configuration

Set via plugin config:

```bash
openclaw config set plugins.entries.acpx.config.permissionMode approve-all
openclaw config set plugins.entries.acpx.config.nonInteractivePermissions fail
```

Restart the gateway after changing these values.

> **Important:** OpenClaw currently defaults to `permissionMode=approve-reads` and `nonInteractivePermissions=fail`. In non-interactive ACP sessions, any write or exec that triggers a permission prompt can fail with `AcpRuntimeError: Permission prompt unavailable in non-interactive mode`.
>
> If you need to restrict permissions, set `nonInteractivePermissions` to `deny` so sessions degrade gracefully instead of crashing.

## Troubleshooting

| Symptom                                                                     | Likely cause                                                                    | Fix                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACP runtime backend is not configured`                                     | Backend plugin missing or disabled.                                             | Install and enable backend plugin, then run `/acp doctor`.                                                                                                        |
| `ACP is disabled by policy (acp.enabled=false)`                             | ACP globally disabled.                                                          | Set `acp.enabled=true`.                                                                                                                                           |
| `ACP dispatch is disabled by policy (acp.dispatch.enabled=false)`           | Dispatch from normal thread messages disabled.                                  | Set `acp.dispatch.enabled=true`.                                                                                                                                  |
| `ACP agent "<id>" is not allowed by policy`                                 | Agent not in allowlist.                                                         | Use allowed `agentId` or update `acp.allowedAgents`.                                                                                                              |
| `Unable to resolve session target: ...`                                     | Bad key/id/label token.                                                         | Run `/acp sessions`, copy exact key/label, retry.                                                                                                                 |
| `--bind here requires running /acp spawn inside an active ... conversation` | `--bind here` used without an active bindable conversation.                     | Move to the target chat/channel and retry, or use unbound spawn.                                                                                                  |
| `Conversation bindings are unavailable for <channel>.`                      | Adapter lacks current-conversation ACP binding capability.                      | Use `/acp spawn ... --thread ...` where supported, configure top-level `bindings[]`, or move to a supported channel.                                              |
| `--thread here requires running /acp spawn inside an active ... thread`     | `--thread here` used outside a thread context.                                  | Move to target thread or use `--thread auto`/`off`.                                                                                                               |
| `Only <user-id> can rebind this channel/conversation/thread.`               | Another user owns the active binding target.                                    | Rebind as owner or use a different conversation or thread.                                                                                                        |
| `Thread bindings are unavailable for <channel>.`                            | Adapter lacks thread binding capability.                                        | Use `--thread off` or move to supported adapter/channel.                                                                                                          |
| `Sandboxed sessions cannot spawn ACP sessions ...`                          | ACP runtime is host-side; requester session is sandboxed.                       | Use `runtime="subagent"` from sandboxed sessions, or run ACP spawn from a non-sandboxed session.                                                                  |
| `sessions_spawn sandbox="require" is unsupported for runtime="acp" ...`     | `sandbox="require"` requested for ACP runtime.                                  | Use `runtime="subagent"` for required sandboxing, or use ACP with `sandbox="inherit"` from a non-sandboxed session.                                               |
| Missing ACP metadata for bound session                                      | Stale/deleted ACP session metadata.                                             | Recreate with `/acp spawn`, then rebind/focus thread.                                                                                                             |
| `AcpRuntimeError: Permission prompt unavailable in non-interactive mode`    | `permissionMode` blocks writes/exec in non-interactive ACP session.             | Set `plugins.entries.acpx.config.permissionMode` to `approve-all` and restart gateway. See [Permission configuration](#permission-configuration).                 |
| ACP session fails early with little output                                  | Permission prompts are blocked by `permissionMode`/`nonInteractivePermissions`. | Check gateway logs for `AcpRuntimeError`. For full permissions, set `permissionMode=approve-all`; for graceful degradation, set `nonInteractivePermissions=deny`. |
| ACP session stalls indefinitely after completing work                       | Harness process finished but ACP session did not report completion.             | Monitor with `ps aux \| grep acpx`; kill stale processes manually.                                                                                                |
