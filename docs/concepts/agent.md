---
summary: "Agent runtime, workspace contract, and session bootstrap"
read_when:
  - Changing agent runtime, workspace bootstrap, or session behavior
title: "Agent runtime"
---

OpenClaw ships one **embedded agent runtime**: a built-in agent loop, tool
wiring, and prompt assembly, distinct from delegating turns to an external
harness process. Each configured agent (see [Multi-agent routing](/concepts/multi-agent)
for running several) has its own workspace, bootstrap files, and session
store. This page covers that runtime contract: what the workspace must
contain, which files get injected, and how sessions bootstrap against it.

## Workspace (required)

Each agent uses a single workspace directory (`agents.defaults.workspace`, or
`agents.list[].workspace` per agent) as its **only** working directory (`cwd`)
for tools and context.

Recommended: use `openclaw setup` to create `~/.openclaw/openclaw.json` if missing and initialize the workspace files.

Full workspace layout + backup guide: [Agent workspace](/concepts/agent-workspace)

If `agents.defaults.sandbox` is enabled, non-main sessions can override this with
per-session workspaces under `agents.defaults.sandbox.workspaceRoot` (see
[Gateway configuration](/gateway/configuration)).

## Bootstrap files (injected)

Inside the workspace, OpenClaw expects these user-editable files:

| File           | Purpose                                              |
| -------------- | ---------------------------------------------------- |
| `AGENTS.md`    | Operating instructions + "memory"                    |
| `SOUL.md`      | Persona, boundaries, tone                            |
| `TOOLS.md`     | User-maintained tool notes and conventions           |
| `IDENTITY.md`  | Agent name/vibe/emoji                                |
| `USER.md`      | User profile + preferred address                     |
| `HEARTBEAT.md` | Heartbeat-specific instructions                      |
| `BOOTSTRAP.md` | One-time first-run ritual (deleted after completion) |
| `MEMORY.md`    | Root long-term memory file, if present               |

On the first turn of a new session, OpenClaw injects the contents of these files into the system prompt's Project Context. `MEMORY.md` is only injected when it exists at the workspace root.

Blank files are skipped. Large files are trimmed and truncated with a marker so prompts stay lean (read the file for full content). A missing file (other than `MEMORY.md`) injects a single "missing file" marker line instead; `openclaw setup` creates a safe default template for it.

`BOOTSTRAP.md` is only created for a **brand new workspace** (no other bootstrap files present). While it is pending, OpenClaw keeps it in Project Context and adds system-prompt bootstrap guidance for the initial ritual instead of copying it into the user message. If you delete it after completing the ritual, it is not recreated on later restarts.

After a workspace has been observed, OpenClaw stores its setup state and
attestation in the shared SQLite database at
`~/.openclaw/state/openclaw.sqlite`. If a recently attested workspace
disappears or is wiped, startup refuses to silently reseed `BOOTSTRAP.md`;
restore the workspace or use a full onboard reset so the workspace and its
database state are cleared together.

Older releases used workspace JSON and `.attested` sidecar files. Runtime does
not read those files. Run `openclaw doctor --fix` to validate them, import their
state into SQLite, and remove each source after the imported rows are verified.

To disable bootstrap file creation entirely (for pre-seeded workspaces), set:

```json5
{ agents: { defaults: { skipBootstrap: true } } }
```

## Built-in tools

Core tools (read/exec/edit/write and related system tools) are always available,
subject to tool policy. `apply_patch` is on by default for OpenAI models and gated by
`tools.exec.applyPatch` (`enabled`, `workspaceOnly`, `allowModels`). `TOOLS.md` does **not** control which tools exist; it's
guidance for how _you_ want them used.

## Skills

OpenClaw loads skills from these locations (highest precedence first):

- Workspace: `<workspace>/skills`
- Project agent skills: `<workspace>/.agents/skills`
- Personal agent skills: `~/.agents/skills`
- Managed/local: `~/.openclaw/skills`
- Bundled (shipped with the install)
- Extra skill folders: `skills.load.extraDirs`

Skill roots can contain grouped folders such as
`<workspace>/skills/personal/foo/SKILL.md`; the skill is still exposed by its
flat frontmatter name, for example `foo`.

Skills can be gated by config/env (see `skills` in [Gateway configuration](/gateway/configuration)).

## Runtime boundaries

The embedded agent runtime is OpenClaw-owned: model discovery, tool wiring,
prompt assembly, session management, and channel delivery share one integrated
runtime surface.

## Sessions

Session rows are stored in the per-agent SQLite database:

- `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`

Transcript JSONL files can still live under
`~/.openclaw/agents/<agentId>/sessions/` as legacy migration inputs, deleted or
reset archives, imports, exports, and support artifacts. Active agent history is
stored in SQLite with the session rows. The session ID is stable and chosen by
OpenClaw. OpenClaw does not read session folders from other tools.

## Steering while streaming

Inbound prompts that arrive mid-run are steered into the current run by default.
Steering is delivered **after the current assistant turn finishes executing its
tool calls**, before the next LLM call, and no longer skips remaining tool calls
from the current assistant message.

`/queue steer` is the default active-run behavior. `/queue followup` and
`/queue collect` make messages wait for a later turn instead of steering.
`/queue interrupt` aborts the active run instead. See [Queue](/concepts/queue)
and [Steering queue](/concepts/queue-steering) for queue and boundary behavior.

Block streaming sends completed assistant blocks as soon as they finish; it is
**off by default** (`agents.defaults.blockStreamingDefault: "off"`).
Tune the boundary via `agents.defaults.blockStreamingBreak` (`text_end` vs `message_end`; defaults to `text_end`).
Control soft block chunking with `agents.defaults.blockStreamingChunk` (defaults to
800-1200 chars; prefers paragraph breaks, then newlines; sentences last).
Coalesce streamed chunks with `agents.defaults.blockStreamingCoalesce` to reduce
single-line spam (idle-based merging before send). Non-Telegram channels require
explicit `*.streaming.block.enabled: true` to enable block replies (QQ Bot
instead streams block replies unless `channels.qqbot.streaming.mode` is `"off"`).
Verbose tool summaries are emitted at tool start (no debounce); Control UI
streams tool output via agent events when available.
More details: [Streaming + chunking](/concepts/streaming).

## Model refs

Model refs in config (for example `agents.defaults.model` and `agents.defaults.models`) are parsed by splitting on the **first** `/`.

- Use `provider/model` when configuring models.
- If the model ID itself contains `/` (OpenRouter-style), include the provider prefix (example: `openrouter/moonshotai/kimi-k2`).
- If you omit the provider, OpenClaw tries an alias first, then a unique
  configured-provider match for that exact model id, and only then falls back
  to the configured default provider. If that provider no longer exposes the
  configured default model, OpenClaw falls back to the first configured
  provider/model instead of surfacing a stale removed-provider default.

## Configuration (minimal)

At minimum, set:

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (strongly recommended)

## Related

- [Agent workspace](/concepts/agent-workspace)
- [Multi-agent routing](/concepts/multi-agent)
- [Session management](/concepts/session)
- [Group chats](/channels/group-messages)
