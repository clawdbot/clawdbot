---
summary: "What the Clawdbot system prompt contains and how it is assembled"
read_when:
  - Editing system prompt text, tools list, or time/heartbeat sections
  - Changing workspace bootstrap or skills injection behavior
---
# System Prompt

Clawdbot builds a custom system prompt for every agent run. The prompt is **Clawdbot-owned** and does not use the p-coding-agent default prompt.

The prompt is assembled by Clawdbot and injected into each agent run.

## Structure

The prompt is intentionally compact and uses fixed sections:

- **Tooling**: current tool list + short descriptions.
- **Skills** (when available): tells the model how to load skill instructions on demand.
- **Clawdbot Self-Update**: how to run `config.apply` and `update.run`.
- **Workspace**: working directory (`agents.defaults.workspace`).
- **Workspace Files (injected)**: indicates bootstrap files are included below.
- **Sandbox** (when enabled): indicates sandboxed runtime, sandbox paths, and whether elevated exec is available.
- **Time**: UTC default + the user’s local time (already converted).
- **Reply Tags**: optional reply tag syntax for supported providers.
- **Heartbeats**: heartbeat prompt and ack behavior.
- **Runtime**: host, OS, node, model, thinking level (one line).
- **Reasoning**: current visibility level + /reasoning toggle hint.

## Workspace bootstrap injection

Bootstrap files are trimmed and appended under **Project Context** so the model sees identity and profile context without needing explicit reads:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (only on brand-new workspaces)

Large files are truncated with a marker. The max per-file size is controlled by
`agents.defaults.bootstrapMaxChars` (default: 20000). Missing files inject a
short missing-file marker.

## Time handling

The Time line is compact and explicit:

- Assume timestamps are **UTC** unless stated.
- The listed **user time** is already converted to `agents.defaults.userTimezone` (if set).

Use `agents.defaults.userTimezone` in `~/.clawdbot/clawdbot.json` to change the user time zone.

## Skills

When eligible skills exist, Clawdbot injects a compact **available skills list**
(`formatSkillsForPrompt`) that includes the **file path** for each skill. The
prompt instructs the model to use `read` to load the SKILL.md at the listed
location (workspace, managed, or bundled). If no skills are eligible, the
Skills section is omitted.

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
