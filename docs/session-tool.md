---
summary: "Agent session tools for listing sessions, fetching history, and sending cross-session messages"
read_when:
  - Adding or modifying session tools
---

# Session Tools

Goal: small, hard-to-misuse tool surface so agents can list sessions, fetch history, and send to another session.

## Tool Names
- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## Key Model
- Main direct chat bucket is always the literal key `"main"`.
- Group chats use `surface:group:<id>` or `surface:channel:<id>`.
- Cron jobs use `cron:<job.id>`.
- Hooks use `hook:<uuid>` unless explicitly set.
- Node bridge uses `node-<nodeId>` unless explicitly set.

`global` and `unknown` are internal-only and never listed. If `session.scope = "global"`, we alias it to `main` for all tools so callers never see `global`.

## sessions_list
List sessions as an array of rows.

Parameters:
- `kinds?: string[]` filter: any of `"main" | "group" | "cron" | "hook" | "node" | "other"`
- `limit?: number` max rows (default: server default, clamp e.g. 200)
- `activeMinutes?: number` only sessions updated within N minutes
- `messageLimit?: number` 0 = no messages (default 0); >0 = include last N messages

Behavior:
- `messageLimit > 0` fetches `chat.history` per session and includes the last N messages.
- Tool results are filtered out in list output; use `sessions_history` for tool messages.
- When running in a **sandboxed** agent session, session tools default to **spawned-only visibility** (see below).

Row shape (JSON):
- `key`: session key (string)
- `kind`: `main | group | cron | hook | node | other`
- `provider`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (group display label if available)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (session override if set)
- `lastChannel`, `lastTo`
- `transcriptPath` (best-effort path derived from store dir + sessionId)
- `messages?` (only when `messageLimit > 0`)

## sessions_history
Fetch transcript for one session.

Parameters:
- `sessionKey` (required)
- `limit?: number` max messages (server clamps)
- `includeTools?: boolean` (default false)

Behavior:
- `includeTools=false` filters `role: "toolResult"` messages.
- Returns messages array in the raw transcript format.

## sessions_send
Send a message into another session.

Parameters:
- `sessionKey` (required)
- `message` (required)
- `timeoutSeconds?: number` (default >0; 0 = fire-and-forget)

Behavior:
- `timeoutSeconds = 0`: enqueue and return `{ runId, status: "accepted" }`.
- `timeoutSeconds > 0`: wait up to N seconds for completion, then return `{ runId, status: "ok", reply }`.
- If wait times out: `{ runId, status: "timeout", error }`. Run continues; call `sessions_history` later.
- If the run fails: `{ runId, status: "error", error }`.
- Waits via gateway `agent.wait` (server-side) so reconnects don't drop the wait.
- Agent-to-agent message context is injected for the primary run.
- After the primary run completes, Clawdbot runs a **reply-back loop**:
  - Round 2+ alternates between requester and target agents.
  - Reply exactly `REPLY_SKIP` to stop the ping‑pong.
  - Max turns is `session.agentToAgent.maxPingPongTurns` (0–5, default 5).
- Once the loop ends, Clawdbot runs the **agent‑to‑agent announce step** (target agent only):
  - Reply exactly `ANNOUNCE_SKIP` to stay silent.
  - Any other reply is sent to the target channel.
  - Announce step includes the original request + round‑1 reply + latest ping‑pong reply.

## Provider Field
- For groups, `provider` is the `surface` recorded on the session entry.
- For direct chats, `provider` maps from `lastChannel`.
- For cron/hook/node, `provider` is `internal`.
- If missing, `provider` is `unknown`.

## Security / Send Policy
Policy-based blocking by surface/chat type (not per session id).

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "surface": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

Runtime override (per session entry):
- `sendPolicy: "allow" | "deny"` (unset = inherit config)
- Settable via `sessions.patch` or owner-only `/send on|off|inherit`.

Enforcement points:
- `chat.send` / `agent` (gateway)
- auto-reply delivery logic

## sessions_spawn
Spawn a sub-agent run in an isolated session and announce the result back to the requester chat surface.

Parameters:
- `task` (required)
- `label?` (optional; used for logs/UI)
- `timeoutSeconds?` (default 0; 0 = fire-and-forget)
- `cleanup?` (`delete|keep`, default `delete`)

Behavior:
- Starts a new `subagent:<uuid>` session with `deliver: false`.
- Sub-agents default to the full tool surface **minus session tools** (configurable via `agent.subagents.tools`).
- Sub-agents are not allowed to call `sessions_spawn` (no sub-agent → sub-agent spawning).
- After completion (or best-effort wait), Clawdbot runs a sub-agent **announce step** and posts the result to the requester chat surface.
- Reply exactly `ANNOUNCE_SKIP` during the announce step to stay silent.

## Sandbox Session Visibility

Sandboxed sessions can use session tools, but by default they only see sessions they spawned via `sessions_spawn`.

Config:

```json5
{
  agent: {
    sandbox: {
      // default: "spawned"
      sessionToolsVisibility: "spawned" // or "all"
    }
  }
}
```
