---
title: Lobster
summary: "Typed workflow runtime for Clawdbot with resumable approval gates."
description: Typed workflow runtime for Clawdbot — composable pipelines with approval gates.
read_when:
  - You want deterministic multi-step workflows with explicit approvals
  - You need to resume a workflow without re-running earlier steps
---

# Lobster

Lobster is a workflow shell that lets Clawdbot run multi-step tool sequences as a single, deterministic operation with explicit approval checkpoints.

## Why

Today, complex workflows require many back-and-forth tool calls. Each call costs tokens, and the LLM has to orchestrate every step. Lobster moves that orchestration into a typed runtime:

- **One call instead of many**: Clawdbot runs one Lobster tool call and gets a structured result.
- **Approvals built in**: Side effects (send email, post comment) halt the workflow until explicitly approved.
- **Resumable**: Halted workflows return a token; approve and resume without re-running everything.

## How it works

Clawdbot launches the local `lobster` CLI in **tool mode** and parses a JSON envelope from stdout.
If the pipeline pauses for approval, the tool returns a `resumeToken` so you can continue later.

## Install Lobster

Install the Lobster CLI on the **same host** that runs the Clawdbot Gateway (see the [Lobster repo](https://github.com/clawdbot/lobster)), and ensure `lobster` is on `PATH`.
If you want to use a custom binary location, pass an **absolute** `lobsterPath` in the tool call.

## Enable the tool

Lobster is an **optional** plugin tool (not enabled by default). Allow it per agent:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": ["lobster"]
        }
      }
    ]
  }
}
```

You can also allow it globally with `tools.allow` if every agent should see it.

## Example: Email triage

Without Lobster:
```
User: "Check my email and draft replies"
→ clawd calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ clawd calls gmail.send
(repeat daily, no memory of what was triaged)
```

With Lobster:
```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

Returns a JSON envelope (truncated):
```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

User approves → resume:
```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

One workflow. Deterministic. Safe.

## Tool parameters

### `run`

Run a pipeline in tool mode.

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

### `resume`

Continue a halted workflow after approval.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Optional inputs

- `lobsterPath`: Absolute path to the Lobster binary (omit to use `PATH`).
- `cwd`: Working directory for the pipeline (defaults to the current process working directory).
- `timeoutMs`: Kill the subprocess if it exceeds this duration (default: 20000).
- `maxStdoutBytes`: Kill the subprocess if stdout exceeds this size (default: 512000).

## Output envelope

Lobster returns a JSON envelope with one of three statuses:

- `ok` → finished successfully
- `needs_approval` → paused; `requiresApproval.resumeToken` is required to resume
- `cancelled` → explicitly denied or cancelled

The tool surfaces the envelope in both `content` (pretty JSON) and `details` (raw object).

## Approvals

If `requiresApproval` is present, inspect the prompt and decide:

- `approve: true` → resume and continue side effects
- `approve: false` → cancel and finalize the workflow

## Safety

- **Local subprocess only** — no network calls from the plugin itself.
- **No secrets** — Lobster doesn't manage OAuth; it calls clawd tools that do.
- **Sandbox-aware** — disabled when the tool context is sandboxed.
- **Hardened** — `lobsterPath` must be absolute if specified; timeouts and output caps enforced.

## Troubleshooting

- **`lobster subprocess timed out`** → increase `timeoutMs`, or split a long pipeline.
- **`lobster output exceeded maxStdoutBytes`** → raise `maxStdoutBytes` or reduce output size.
- **`lobster returned invalid JSON`** → ensure the pipeline runs in tool mode and prints only JSON.
- **`lobster failed (code …)`** → run the same pipeline in a terminal to inspect stderr.

## Learn more

- [Plugins](/plugin)
- [Plugin tool authoring](/plugins/agent-tools)
