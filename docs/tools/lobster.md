---
title: Lobster
description: Run Lobster pipelines (typed workflows) as a first-class Clawdbot tool.
---

# Lobster

The `lobster` tool lets Clawdbot run Lobster pipelines as a **local-first, typed workflow runtime**.

This is designed for:
- Deterministic orchestration (move multi-step tool workflows out of the LLM)
- Human-in-the-loop approvals that **halt and resume**
- Lower token usage (one `lobster.run` call instead of many tool calls)

## Security model

- Lobster runs as a **local subprocess**.
- Lobster does **not** manage OAuth or secrets.
- Side effects still go through Clawdbot tools (messaging, files, etc.).

Recommendations:
- Prefer configuring `lobsterPath` as an **absolute path** to avoid PATH hijack.
- Use Lobster approvals (`approve`) for any side-effectful step.

## Actions

### `run`

Run a pipeline in tool mode.

Example:

```json
{
  "action": "run",
  "pipeline": "exec --json \"echo [1]\" | approve --prompt 'ok?'",
  "lobsterPath": "/absolute/path/to/lobster",
  "timeoutMs": 20000
}
```

### `resume`

Resume a halted pipeline.

Example:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true,
  "lobsterPath": "/absolute/path/to/lobster"
}
```

## Output

Lobster returns a JSON envelope:

- `ok`: boolean
- `status`: `ok` | `needs_approval` | `cancelled`
- `output`: array of items
- `requiresApproval`: approval request object (when `status=needs_approval`)
