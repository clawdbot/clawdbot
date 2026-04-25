---
summary: "What the OpenClaw system prompt contains and how it is assembled"
read_when:
  - Editing system prompt text, tools list, or time/heartbeat sections
  - Changing workspace bootstrap or skills injection behavior
title: "System prompt"
---

OpenClaw builds a custom system prompt for every agent run. The prompt is **OpenClaw-owned** and does not use the pi-coding-agent default prompt.

The prompt is assembled by OpenClaw and injected into each agent run.

Provider plugins can contribute cache-aware prompt guidance without replacing
the full OpenClaw-owned prompt. The provider runtime can:

- replace a small set of named core sections (`interaction_style`,
  `tool_call_style`, `execution_bias`)
- inject a **stable prefix** above the prompt cache boundary
- inject a **dynamic suffix** below the prompt cache boundary

Use provider-owned contributions for model-family-specific tuning. Keep legacy
`before_prompt_build` prompt mutation for compatibility or truly global prompt
changes, not normal provider behavior.

The OpenAI GPT-5 family overlay keeps the core execution rule small and adds
model-specific guidance for persona latching, concise output, tool discipline,
parallel lookup, deliverable coverage, verification, missing context, and
terminal-tool hygiene.

## Structure

The prompt is intentionally compact and uses fixed sections:

- **Tooling**: structured-tool source-of-truth reminder plus runtime tool-use guidance.
- **Execution Bias**: compact follow-through guidance: act in-turn on
  actionable requests, continue until done or blocked, recover from weak tool
  results, check mutable state live, and verify before finalizing.
- **Safety**: short guardrail reminder to avoid power-seeking behavior or bypassing oversight.
- **Skills** (when available): tells the model how to load skill instructions on demand.
- **OpenClaw Self-Update**: how to inspect config safely with
  `config.schema.lookup`, patch config with `config.patch`, replace the full
  config with `config.apply`, and run `update.run` only on explicit user
  request. The owner-only `gateway` tool also refuses to rewrite
  `tools.exec.ask` / `tools.exec.security`, including legacy `tools.bash.*`
  aliases that normalize to those protected exec paths.
- **Workspace**: working directory (`agents.defaults.workspace`).
- **Documentation**: local path to OpenClaw docs (repo or npm package) and when to read them.
- **Workspace Files (injected)**: indicates bootstrap files are included below.
- **Sandbox** (when enabled): indicates sandboxed runtime, sandbox paths, and whether elevated exec is available.
- **Current Date & Time**: user-local time, timezone, and time format.
- **Reply Tags**: optional reply tag syntax for supported providers.
- **Heartbeats**: heartbeat prompt and ack behavior, when heartbeats are enabled for the default agent.
- **Runtime**: host, OS, node, model, repo root (when detected), thinking level (one line).
- **Reasoning**: current visibility level + /reasoning toggle hint.

The Tooling section also includes runtime guidance for long-running work:

- use cron for future follow-up (`check back later`, reminders, recurring work)
  instead of `exec` sleep loops, `yieldMs` delay tricks, or repeated `process`
  polling
- use `exec` / `process` only for commands that start now and continue running
  in the background
- when automatic completion wake is enabled, start the command once and rely on
  the push-based wake path when it emits output or fails
- use `process` for logs, status, input, or intervention when you need to
  inspect a running command
- if the task is larger, prefer `sessions_spawn`; sub-agent completion is
  push-based and auto-announces back to the requester
- do not poll `subagents list` / `sessions_list` in a loop just to wait for
  completion

When the experimental `update_plan` tool is enabled, Tooling also tells the
model to use it only for non-trivial multi-step work, keep exactly one
`in_progress` step, and avoid repeating the whole plan after each update.

Safety guardrails in the system prompt are advisory. They guide model behavior but do not enforce policy. Use tool policy, exec approvals, sandboxing, and channel allowlists for hard enforcement; operators can disable these by design.

On channels with native approval cards/buttons, the runtime prompt now tells the
agent to rely on that native approval UI first. It should only include a manual
`/approve` command when the tool result says chat approvals are unavailable or
manual approval is the only path.

## Prompt modes

OpenClaw can render smaller system prompts for sub-agents. The runtime sets a
`promptMode` for each run (not a user-facing config):

- `full` (default): includes all sections above.
- `minimal`: used for sub-agents; omits **Skills**, **Memory Recall**, **OpenClaw
  Self-Update**, **Model Aliases**, **User Identity**, **Reply Tags**,
  **Messaging**, **Silent Replies**, and **Heartbeats**. Tooling, **Safety**,
  Workspace, Sandbox, Current Date & Time (when known), Runtime, and injected
  context stay available.
- `none`: returns only the base identity line.

When `promptMode=minimal`, extra injected prompts are labeled **Subagent
Context** instead of **Group Chat Context**.

## Workspace bootstrap injection

Bootstrap files are trimmed and appended under **Project Context** so the model sees identity and profile context without needing explicit reads:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (only on brand-new workspaces)
- `MEMORY.md` when present

All of these files are **injected into the context window** on every turn unless
a file-specific gate applies. `HEARTBEAT.md` is omitted on normal runs when
heartbeats are disabled for the default agent or
`agents.defaults.heartbeat.includeSystemPromptSection` is false. Keep injected
files concise — especially `MEMORY.md`, which can grow over time and lead to
unexpectedly high context usage and more frequent compaction.

> **Note:** `memory/*.md` daily files are **not** part of the normal bootstrap
> Project Context. On ordinary turns they are accessed on demand via the
> `memory_search` and `memory_get` tools, so they do not count against the
> context window unless the model explicitly reads them. Bare `/new` and
> `/reset` turns are the exception: the runtime can prepend recent daily memory
> as a one-shot startup-context block for that first turn.

Large files are truncated with a marker. The max per-file size is controlled by
`agents.defaults.bootstrapMaxChars` (default: 12000). Total injected bootstrap
content across files is capped by `agents.defaults.bootstrapTotalMaxChars`
(default: 60000). Missing files inject a short missing-file marker. When truncation
occurs, OpenClaw can inject a warning block in Project Context; control this with
`agents.defaults.bootstrapPromptTruncationWarning` (`off`, `once`, `always`;
default: `once`).

Sub-agent sessions only inject `AGENTS.md` and `TOOLS.md` (other bootstrap files
are filtered out to keep the sub-agent context small).

Internal hooks can intercept this step via `agent:bootstrap` to mutate or replace
the injected bootstrap files (for example swapping `SOUL.md` for an alternate persona).

If you want to make the agent sound less generic, start with
[SOUL.md Personality Guide](/concepts/soul).

To inspect how much each injected file contributes (raw vs injected, truncation, plus tool schema overhead), use `/context list` or `/context detail`. See [Context](/concepts/context).

## Time handling

The system prompt includes a dedicated **Current Date & Time** section when the
user timezone is known. To keep the prompt cache-stable, it now only includes
the **time zone** (no dynamic clock or time format).

Use `session_status` when the agent needs the current time; the status card
includes a timestamp line. The same tool can optionally set a per-session model
override (`model=default` clears it).

Configure with:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

See [Date & Time](/date-time) for full behavior details.

## Skills

When eligible skills exist, OpenClaw injects a compact **available skills list**
(`formatSkillsForPrompt`) that includes the **file path** for each skill. The
prompt instructs the model to use `read` to load the SKILL.md at the listed
location (workspace, managed, or bundled). If no skills are eligible, the
Skills section is omitted.

Eligibility includes skill metadata gates, runtime environment/config checks,
and the effective agent skill allowlist when `agents.defaults.skills` or
`agents.list[].skills` is configured.

Plugin-bundled skills are eligible only when their owning plugin is enabled.
This lets tool plugins expose deeper operating guides without embedding all of
that guidance directly in every tool description.

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

This keeps the base prompt small while still enabling targeted skill usage.

The skills list budget is owned by the skills subsystem:

- Global default: `skills.limits.maxSkillsPromptChars`
- Per-agent override: `agents.list[].skillsLimits.maxSkillsPromptChars`

Generic bounded runtime excerpts use a different surface:

- `agents.defaults.contextLimits.*`
- `agents.list[].contextLimits.*`

That split keeps skills sizing separate from runtime read/injection sizing such
as `memory_get`, live tool results, and post-compaction AGENTS.md refreshes.

## Documentation

The system prompt includes a **Documentation** section. When local docs are available, it
points to the local OpenClaw docs directory (`docs/` in a Git checkout or the bundled npm
package docs). If local docs are unavailable, it falls back to
[https://docs.openclaw.ai](https://docs.openclaw.ai).

The same section also includes the OpenClaw source location. Git checkouts expose the local
source root so the agent can inspect code directly. Package installs include the GitHub
source URL and tell the agent to review source there whenever the docs are incomplete or
stale. The prompt also notes the public docs mirror, community Discord, and ClawHub
([https://clawhub.ai](https://clawhub.ai)) for skills discovery. It tells the model to
consult docs first for OpenClaw behavior, commands, configuration, or architecture, and to
run `openclaw status` itself when possible (asking the user only when it lacks access).

## Related

- [Agent runtime](/concepts/agent)
- [Agent workspace](/concepts/agent-workspace)
- [Context engine](/concepts/context-engine)
