---
summary: "Sub-agents: spawning isolated agent runs that announce results back to the requester chat"
read_when:
  - You want background/parallel work via the agent
  - You are changing sessions_spawn or sub-agent tool policy
---

# Sub-agents

Sub-agents are background agent runs spawned from an existing agent run. They run in their own session (`subagent:<uuid>`) and, when finished, **announce** their result back to the requester chat surface.

Primary goals:
- Parallelize “research / long task / slow tool” work without blocking the main run.
- Keep sub-agents isolated by default (session separation + optional sandboxing).
- Keep the tool surface hard to misuse: sub-agents do **not** get session tools by default.
- Avoid nested fan-out: sub-agents cannot spawn sub-agents.

## Tool

Use `sessions_spawn`:
- Starts a sub-agent run (`deliver: false`, global lane: `subagent`)
- Then runs an announce step and posts the announce reply to the requester chat surface

Tool params:
- `task` (required)
- `label?` (optional)
- `timeoutSeconds?` (default `0`; `0` = fire-and-forget)
- `cleanup?` (`delete|keep`, default `delete`)

## Announce

Sub-agents report back via an announce step:
- The announce step runs inside the sub-agent session (not the requester session).
- If the sub-agent replies exactly `ANNOUNCE_SKIP`, nothing is posted.
- Otherwise the announce reply is posted to the requester chat surface via the gateway `send` method.

## Tool Policy (sub-agent tools)

By default, sub-agents get **all tools except session tools**:
- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

Override via config:

```json5
{
  agent: {
    subagents: {
      maxConcurrent: 1,
      tools: {
        // deny wins
        deny: ["gateway", "cron"],
        // if allow is set, it becomes allow-only (deny still wins)
        // allow: ["read", "bash", "process"]
      }
    }
  }
}
```

## Concurrency

Sub-agents use a dedicated in-process queue lane:
- Lane name: `subagent`
- Concurrency: `agent.subagents.maxConcurrent` (default `1`)

## Limitations

- Sub-agent announce is **best-effort**. If the gateway restarts, pending “announce back” work is lost.
- Sub-agents still share the same gateway process resources; treat `maxConcurrent` as a safety valve.
