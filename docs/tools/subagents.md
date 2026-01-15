---
summary: "Sub-agents: spawning isolated agent runs that announce results back to the requester chat"
read_when:
  - You want background/parallel work via the agent
  - You are changing sessions_spawn or sub-agent tool policy
---

# Sub-agents

Sub-agents are background agent runs spawned from an existing agent run. They run in their own session (`agent:<agentId>:subagent:<uuid>`) and, when finished, **announce** their result back to the requester chat channel.

Primary goals:
- Parallelize “research / long task / slow tool” work without blocking the main run.
- Keep sub-agents isolated by default (session separation + optional sandboxing).
- Keep the tool surface hard to misuse: sub-agents do **not** get session tools by default.
- Avoid nested fan-out: sub-agents cannot spawn sub-agents.

## Tool

Use `sessions_spawn`:
- Starts a sub-agent run (`deliver: false`, global lane: `subagent`)
- Then runs an announce step and posts the announce reply to the requester chat channel
- Default model: inherits the caller unless you set `agents.defaults.subagents.model` (or per-agent `agents.list[].subagents.model`); an explicit `sessions_spawn.model` still wins.

Tool params:
- `task` (required)
- `label?` (optional)
- `agentId?` (optional; spawn under another agent id if allowed)
- `model?` (optional; overrides the sub-agent model; invalid values are skipped and the sub-agent runs on the default model with a warning in the tool result)
- `runTimeoutSeconds?` (default `0`; when set, the sub-agent run is aborted after N seconds)
- `cleanup?` (`delete|keep`, default `keep`)

Allowlist:
- `agents.list[].subagents.allowAgents`: list of agent ids that can be targeted via `agentId` (`["*"]` to allow any). Default: only the requester agent.

Discovery:
- Use `agents_list` to see which agent ids are currently allowed for `sessions_spawn`.

Auto-archive:
- Sub-agent sessions are automatically archived after `agents.defaults.subagents.archiveAfterMinutes` (default: 60).
- Archive uses `sessions.delete` and renames the transcript to `*.deleted.<timestamp>` (same folder).
- `cleanup: "delete"` archives immediately after announce (still keeps the transcript via rename).
- Auto-archive is best-effort; pending timers are lost if the gateway restarts.
- `runTimeoutSeconds` does **not** auto-archive; it only stops the run. The session remains until auto-archive.

## Announce

Sub-agents report back via an announce step:
- The announce step runs inside the sub-agent session (not the requester session).
- If the sub-agent replies exactly `ANNOUNCE_SKIP`, nothing is posted.
- Otherwise the announce reply is posted to the requester chat channel via the gateway `send` method.
- Announce messages are normalized to a stable template:
  - `Status:` derived from the run outcome (`success`, `error`, `timeout`, or `unknown`).
  - `Result:` the summary content from the announce step (or `(not available)` if missing).
  - `Notes:` error details and other useful context.
- `Status` is not inferred from model output; it comes from runtime outcome signals.

Announce payloads include a stats line at the end (even when wrapped):
- Runtime (e.g., `runtime 5m12s`)
- Token usage (input/output/total)
- Estimated cost when model pricing is configured (`models.providers.*.models[].cost`)
- `sessionKey`, `sessionId`, and transcript path (so the main agent can fetch history via `sessions_history` or inspect the file on disk)

## Tool Policy (sub-agent tools)

By default, sub-agents get **all tools except session tools**:
- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

Override via config:

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1
      }
    }
  },
  tools: {
    subagents: {
      tools: {
        // deny wins
        deny: ["gateway", "cron"],
        // if allow is set, it becomes allow-only (deny still wins)
        // allow: ["read", "exec", "process"]
      }
    }
  }
}
```

## Concurrency

Sub-agents use a dedicated in-process queue lane:
- Lane name: `subagent`
- Concurrency: `agents.defaults.subagents.maxConcurrent` (default `1`)

## Limitations

- Sub-agent announce is **best-effort**. If the gateway restarts, pending “announce back” work is lost.
- Sub-agents still share the same gateway process resources; treat `maxConcurrent` as a safety valve.
- `sessions_spawn` is always non-blocking: it returns `{ status: "accepted", runId, childSessionKey }` immediately.
- Sub-agent context only injects `AGENTS.md` + `TOOLS.md` (no `SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, or `BOOTSTRAP.md`).
