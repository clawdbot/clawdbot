---
summary: "What the OpenClaw system prompt contains and how it is assembled"
read_when:
  - Editing system prompt text, tools list, or time/heartbeat sections
  - Changing workspace bootstrap or skills injection behavior
title: "System prompt"
---

OpenClaw builds its own system prompt for every agent run; there is no runtime default prompt.

Assembly has three layers:

- `buildAgentSystemPrompt` renders the prompt from explicit inputs. It stays a pure renderer and does not read global config directly.
- `resolveAgentSystemPromptConfig` resolves config-backed prompt knobs (owner display, TTS hints, model aliases, memory citation mode, sub-agent delegation mode) for a specific agent.
- Runtime adapters (embedded, CLI, command/export previews, compaction) gather live facts (tools, sandbox state, channel capabilities, context files, provider prompt contributions) and call the configured prompt facade.

This keeps exported/debug prompt surfaces aligned with live runs without turning every runtime detail into one monolithic builder.

Provider plugins can contribute cache-aware guidance without replacing the OpenClaw-owned prompt. A provider runtime can:

- replace one of three named core sections: `interaction_style`, `tool_call_style`, `execution_bias`
- inject a **stable prefix** above the prompt cache boundary
- inject a **dynamic suffix** below the prompt cache boundary

Use provider-owned contributions for model-family-specific tuning. Reserve the legacy `before_prompt_build` hook for compatibility or truly global prompt changes.

The bundled OpenAI/Codex GPT-5-family overlay (`resolveGpt5SystemPromptContribution`) uses this mechanism: a `stablePrefix` behavior contract (execution policy, tool discipline, output contract, completion contract) plus an optional `interaction_style` override for a friendlier tone. It applies to any `gpt-5*` model id routed through the OpenAI or Codex plugins, controlled by `agents.defaults.promptOverlays.gpt5.personality` (`"friendly"`/`"on"` or `"off"`).

## Structure

The prompt is compact, with fixed sections:

- **Tooling**: structured-tool source-of-truth reminder plus runtime tool-use guidance. When the experimental `update_plan` tool is enabled (`tools.experimental.planTool`), its own tool description adds: use it only for non-trivial multi-step work, keep at most one step `in_progress`, and skip it for simple one-step work.
- **Execution Bias**: act in-turn on actionable requests, continue until done or blocked, recover from weak tool results, check mutable state live, and verify before finalizing.
- **Safety**: short guardrail reminder against power-seeking behavior or bypassing oversight.
- **Skills** (when available): tells the model how to load skill instructions on demand.
- **OpenClaw Control**: prefer the `gateway` tool for config/restart work; do not invent CLI commands.
- **OpenClaw Self-Update**: inspect config safely with `config.schema.lookup`, patch with `config.patch`, replace the full config with `config.apply`, and run `update.run` only on explicit user request. The agent-facing `gateway` tool refuses to rewrite `tools.exec.mode`.
- **Workspace**: working directory (`agents.defaults.workspace`).
- **Documentation**: local docs/source path and when to read them.
- **Workspace Files (injected)**: notes that bootstrap files are included below.
- **Sandbox** (when enabled): sandboxed runtime, sandbox paths, elevated-exec availability.
- **Current Date & Time**: time zone only (cache-stable; the live clock comes from `session_status`).
- **Assistant Output Directives**: compact attachment, voice-note, and reply-tag syntax.
- **Heartbeats**: heartbeat prompt and ack behavior, when heartbeats are enabled for the default agent.
- **Runtime**: host, OS, node, model, repo root (when detected), thinking level (one line).
- **Reasoning**: current visibility level plus the `/reasoning` toggle hint.

Large stable content (including **Project Context**) stays above the internal prompt cache boundary. Volatile per-turn sections (Control UI embed guidance, **Messaging**, **Voice**, **Group Chat Context**, **Reactions**, **Heartbeats**, **Runtime**) are appended below that boundary so local backends with prefix caches can reuse the stable workspace prefix across channel turns. Tool descriptions should avoid embedding current channel names when the accepted schema already carries that runtime detail.

Tooling also carries long-running-work guidance:

- use cron for future follow-up (`check back later`, reminders, recurring work) instead of `exec` sleep loops, `yieldMs` delay tricks, or repeated `process` polling
- use `exec` / `process` only for commands that start now and continue in the background
- when automatic completion wake is enabled, start the command once and rely on the push-based wake path
- use `process` for logs, status, input, or intervention on a running command
- for larger tasks, prefer `sessions_spawn`; sub-agent completion is push-based and auto-announces back to the requester
- do not poll `subagents list` / `sessions_list` in a loop just to wait for completion

`agents.defaults.subagents.delegationMode` (default `"suggest"`) can strengthen this. `"prefer"` adds a dedicated **Sub-Agent Delegation** section telling the main agent to act as a responsive coordinator and push anything more involved than a direct reply through `sessions_spawn`. This is prompt-only; tool policy still controls whether `sessions_spawn` is available.

Safety guardrails in the system prompt are advisory, not enforcement. Use tool policy, exec approvals, sandboxing, and channel allowlists for hard enforcement; operators can disable prompt guardrails by design.

On channels with native approval cards/buttons, the prompt tells the agent to rely on that UI first, and to include a manual `/approve` command only when the tool result says chat approvals are unavailable or manual approval is the only path.

## Prompt modes

OpenClaw renders smaller system prompts for sub-agents. The runtime sets a `promptMode` per run (not user-facing config):

- `full` (default): all sections above.
- `minimal`: used for sub-agents; omits the memory prompt section (bundled as **Memory Recall**), **OpenClaw Self-Update**, **Model Aliases**, **User Identity**, **Assistant Output Directives**, **Messaging**, **Silent Replies**, and **Heartbeats**. Tooling, **Safety**, **Skills** (when supplied), Workspace, Sandbox, Current Date & Time (when known), Runtime, and injected context stay available.
- `none`: returns only the base identity line.

Under `promptMode=minimal`, extra injected prompts are labeled **Subagent Context** instead of **Group Chat Context**.

For channel auto-reply runs, OpenClaw omits the generic **Silent Replies** section when direct, group, or message-tool-only context already owns the visible-reply contract. Only legacy automatic group/channel mode shows `NO_REPLY`; direct chats and message-tool-only replies skip silent-token guidance.

## Prompt snapshots

OpenClaw keeps committed prompt snapshots for the Codex runtime happy path under `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/`. They render selected app-server thread/turn params plus a reconstructed model-bound prompt layer stack for Telegram direct, Discord group, and heartbeat turns: a pinned Codex `gpt-5.5` model prompt fixture, the Codex happy-path permission developer text, OpenClaw developer instructions, turn-scoped collaboration-mode instructions when OpenClaw provides them, user turn input, and references to dynamic tool specs.

Refresh the pinned Codex model prompt fixture with `pnpm prompt:snapshots:sync-codex-model`. By default it looks for `$CODEX_HOME/models_cache.json`, then `~/.codex/models_cache.json`, then the maintainer checkout convention `~/code/codex/codex-rs/models-manager/models.json`; if none exist it exits without changing the committed fixture. Pass `--catalog <path>` to refresh from a specific `models_cache.json` or `models.json` file.

These snapshots are not a byte-for-byte raw OpenAI request capture. Codex can add runtime-owned workspace context (`AGENTS.md`, environment context, memories, app/plugin instructions, built-in Default collaboration-mode instructions) after OpenClaw sends thread and turn params.

Regenerate with `pnpm prompt:snapshots:gen`; verify drift with `pnpm prompt:snapshots:check`. CI runs the drift check alongside the additional-boundary shards, so prompt changes and snapshot updates land in the same PR.

## Workspace bootstrap injection

Bootstrap files are resolved from the active workspace and routed to the prompt surface matching their lifetime:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (only on brand-new workspaces)
- `MEMORY.md` when present

On the native Codex harness, OpenClaw avoids repeating stable workspace files in every user turn. Codex loads `AGENTS.md` through its own project-doc discovery. `TOOLS.md` is forwarded as inherited Codex developer instructions. `SOUL.md`, `IDENTITY.md`, and `USER.md` are forwarded as turn-scoped collaboration developer instructions so native Codex sub-agents do not inherit them. `HEARTBEAT.md` content is not injected directly; heartbeat turns get a collaboration-mode note pointing to the file when it exists and is non-empty. `MEMORY.md` content is not pasted into every native Codex turn either: when memory tools are available for the workspace, Codex turns get a small workspace-memory note directing the model to `memory_search` or `memory_get`. If tools are disabled, memory search is unavailable, or the active workspace differs from the agent memory workspace, `MEMORY.md` falls back to the normal bounded turn-context path. `BOOTSTRAP.md` keeps the normal turn-context role.

On non-Codex harnesses, bootstrap files compose into the OpenClaw prompt per their existing gates. `HEARTBEAT.md` is omitted on normal runs when heartbeats are disabled for the default agent or `agents.defaults.heartbeat.includeSystemPromptSection` is false. Keep injected files concise, especially non-Codex `MEMORY.md`: it should stay a curated long-term summary, with detailed daily notes in `memory/*.md` retrievable on demand via `memory_search` / `memory_get`. Oversized non-Codex `MEMORY.md` files increase prompt usage and can be partially injected under the bootstrap file limits below.

<Note>
`memory/*.md` daily files are **not** part of the normal bootstrap Project Context. On ordinary turns they are accessed on demand via `memory_search` / `memory_get`, so they do not count against the context window unless the model explicitly reads them. Bare `/new` and `/reset` turns are the exception: the runtime can prepend recent daily memory as a one-shot startup-context block for that first turn.
</Note>

Large files are truncated with a marker:

| Limit                                        | Config key                                         | Default  |
| -------------------------------------------- | -------------------------------------------------- | -------- |
| Per-file max characters                      | `agents.defaults.bootstrapMaxChars`                | 20000    |
| Total across all files                       | `agents.defaults.bootstrapTotalMaxChars`           | 60000    |
| Truncation warning (`off`\|`once`\|`always`) | `agents.defaults.bootstrapPromptTruncationWarning` | `always` |

Missing files inject a short missing-file marker. Detailed raw/injected counts stay in diagnostics such as `/context`, `/status`, doctor, and logs.

For memory files, truncation is not data loss: the file stays intact on disk. On native Codex, `MEMORY.md` is read on demand through memory tools when available, with bounded prompt fallback otherwise. On other harnesses, the model only sees the shortened injected copy until it reads or searches memory directly. If `MEMORY.md` is repeatedly truncated, distill it into a shorter durable summary, move detailed history into `memory/*.md`, or intentionally raise the bootstrap limits.

Sub-agent sessions only inject `AGENTS.md` and `TOOLS.md` (other bootstrap files are filtered out to keep sub-agent context small).

Internal hooks can intercept this step via the `agent:bootstrap` event to mutate or replace the injected bootstrap files (for example swapping `SOUL.md` for an alternate persona).

To sound less generic, start with [SOUL.md Personality Guide](/concepts/soul).

To inspect how much each injected file contributes (raw vs injected, truncation, tool schema overhead), use `/context list` or `/context detail`. See [Context](/concepts/context).

## Time handling

The **Current Date & Time** section appears only when the user timezone is known, and only includes the **time zone** (no dynamic clock or time format) to keep the prompt cache-stable.

Use `session_status` when the agent needs the current time; its status card includes a timestamp line. The same tool can optionally set a per-session model override (`model=default` clears it).

Configure with:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

See [Timezones](/concepts/timezone) and [Date & Time](/date-time) for full behavior details.

## Skills

When eligible skills exist, OpenClaw injects a compact `<available_skills>` list (`formatSkillsForPrompt`) with the **file path** and a content-derived `<version>sha256:...</version>` marker per skill. The prompt instructs the model to use `read` to load the SKILL.md at the listed location (workspace, managed, or bundled), and to re-read a skill when its `<version>` differs from a previous turn. If no skills are eligible, the Skills section is omitted.

Native Codex turns receive this list as turn-scoped collaboration developer instructions instead of per-turn user input, except lightweight cron turns that preserve the exact scheduled prompt. Other harnesses keep the normal prompt section.

The location can point at a nested skill, such as `skills/personal/foo/SKILL.md`. Nesting is only organizational; the prompt uses the flat skill name from `SKILL.md` frontmatter.

Eligibility includes skill metadata gates, runtime environment/config checks, and the effective agent skill allowlist when `agents.defaults.skills` or `agents.entries.*.skills` is configured. Plugin-bundled skills are eligible only when their owning plugin is enabled, letting tool plugins expose deeper operating guides without embedding all of that guidance in every tool description.

```xml
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
    <version>sha256:...</version>
  </skill>
</available_skills>
```

This keeps the base prompt small while still enabling targeted skill usage. Sizing is owned by the skills subsystem, separate from generic runtime read/injection sizing:

| Scope     | Skills prompt budget                                 | Runtime excerpt budget             |
| --------- | ---------------------------------------------------- | ---------------------------------- |
| Global    | `skills.limits.maxSkillsPromptChars`                 | `agents.defaults.contextLimits.*`  |
| Per-agent | `agents.entries.*.skillsLimits.maxSkillsPromptChars` | `agents.entries.*.contextLimits.*` |

The runtime excerpt budget covers `memory_get`, live tool results, and post-compaction `AGENTS.md` refreshes.

## Documentation

The **Documentation** section points to local docs when available (`docs/` in a Git checkout or the bundled npm package docs), falling back to [https://docs.openclaw.ai](https://docs.openclaw.ai) otherwise. It also lists the OpenClaw source location: Git checkouts expose the local source root, package installs get the GitHub source URL with instructions to review source there when docs are incomplete or stale.

The prompt frames docs as the authority for OpenClaw self-knowledge before the model understands how OpenClaw works (memory/daily notes, sessions, tools, Gateway, config, commands, project context), and tells the model to treat `AGENTS.md`, project context, workspace/profile/memory notes, and `memory_search` as instruction context or user memory rather than OpenClaw design/implementation knowledge. If docs are silent or stale, the model should say so and inspect source. It also tells the model to run `openclaw status` itself when possible, asking the user only when it lacks access.

For configuration specifically, it points agents to the `gateway` tool action `config.schema.lookup` for exact field-level docs and constraints, then to `docs/gateway/configuration.md` and `docs/gateway/configuration-reference.md` for broader guidance.

## Related

- [Agent runtime](/concepts/agent)
- [Agent workspace](/concepts/agent-workspace)
- [Context engine](/concepts/context-engine)
