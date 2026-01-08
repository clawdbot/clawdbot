---
summary: "What the ClaudeBot system prompt contains and how it is assembled"
read_when:
  - Editing system prompt text, tools list, or time/heartbeat sections
  - Changing workspace bootstrap or skills injection behavior
---
# System Prompt

ClaudeBot builds a custom system prompt for every agent run. The prompt is **Clawdbot-owned** and does not use the p-coding-agent default prompt.

The prompt is assembled in `src/agents/system-prompt.ts` and injected by `src/agents/pi-embedded-runner.ts`.

## Structure

The prompt is intentionally compact and uses fixed sections:

- **Tooling**: current tool list + short descriptions.
- **Skills**: tells the model how to load skill instructions on demand.
- **ClaudeBot Self-Update**: how to run `config.apply` and `update.run`.
- **Workspace**: working directory (`agent.workspace`).
- **Workspace Files (injected)**: indicates bootstrap files are included below.
- **Time**: UTC default + the user’s local time (already converted).
- **Reply Tags**: optional reply tag syntax for supported providers.
- **Heartbeats**: heartbeat prompt and ack behavior.
- **Runtime**: host, OS, node, model, thinking level (one line).

## Workspace bootstrap injection

Bootstrap files are trimmed and appended under **Project Context** so the model sees identity and profile context without needing explicit reads:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (only on brand-new workspaces)

Large files are truncated with a marker. Missing files inject a short missing-file marker.

## Time handling

The Time line is compact and explicit:

- Assume timestamps are **UTC** unless stated.
- The listed **user time** is already converted to `agent.userTimezone` (if set).

Use `agent.userTimezone` in `~/.clawdbot/clawdbot.json` to change the user time zone.

## Skills

Skills are **not** auto-injected. Instead, the prompt instructs the model to use `read` to load skill instructions on demand:

```
<workspace>/skills/<name>/SKILL.md
```

This keeps the base prompt small while still enabling targeted skill usage.

## Code references

- Prompt text: `src/agents/system-prompt.ts`
- Prompt assembly + injection: `src/agents/pi-embedded-runner.ts`
- Bootstrap trimming: `src/agents/pi-embedded-helpers.ts`
