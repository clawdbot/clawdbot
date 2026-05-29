---
title: Claw Supervisor
description: Fleet supervision plan for Codex app-server sessions controlled by OpenClaw.
readWhen:
  - Designing Codex fleet supervision
  - Building OpenClaw tools that read, steer, or spawn Codex sessions
  - Choosing between local, Cloudflare, and VPS deployment for supervised Codex
---

# Claw Supervisor

## Goal

Claw Supervisor lets one always-on OpenClaw instance monitor and drive a fleet of Codex sessions without changing the normal Codex user experience. A user can SSH into a host, start Codex, work in the TUI, and still have the supervisor read the session, steer it, interrupt it, spawn related sessions, and accept handoffs. Codex sessions can also call back into OpenClaw through MCP.

## Product Model

Codex remains the primary work surface. OpenClaw supervises Codex rather than hiding Codex inside an opaque OpenClaw subagent.

The OpenClaw plugin is named `codex-supervisor`. `crabfleet` remains the deployment
and host-fleet profile for CRAB machines rather than the reusable plugin name.

The model has three roles:

- Human-attached Codex: a normal interactive Codex TUI launched through a shared app-server.
- Autonomous Codex: a Codex app-server thread spawned by the supervisor that a human can later attach to.
- Supervisor Claw: an always-on OpenClaw agent with tools for fleet state, transcript reads, steering, interruption, spawning, and handoff.

OpenClaw may use its existing subagent machinery internally, but the external contract is an attachable Codex session with a Codex thread id.

## Architecture

```text
user SSH session
  -> codex --remote unix://... or ws://...
      -> local codex app-server daemon
          <-> host sidecar / supervisor connector
              <-> OpenClaw fleet supervisor
                  <-> supervisor MCP exposed back to Codex
```

Each Codex-capable host runs:

- Codex app-server daemon.
- A launcher that always starts interactive Codex with `--remote`.
- A connector that registers app-server endpoints and live threads with the supervisor.

The supervisor runs:

- Endpoint registry.
- Session registry.
- Codex app-server JSON-RPC client pool.
- MCP server for Codex-to-Claw calls.
- OpenClaw tools for Claw-to-Codex control.
- Policy engine for autonomous actions, approvals, and loop prevention.

## Codex App-Server Contract

Use Codex app-server APIs as the canonical control plane:

- `initialize`, `initialized`
- `thread/loaded/list`
- `thread/list`
- `thread/read`
- `thread/resume`
- `thread/start`
- `turn/start`
- `turn/steer`
- `turn/interrupt`
- `model/list`

Interactive Codex must be launched with `codex --remote <endpoint>` so the TUI and supervisor connect to the same app-server. Standalone `codex exec` is not a live-shared session today; use app-server APIs for autonomous work until Codex supports `exec --remote`.

## Session Registry

Supervisor stores one record per observed Codex thread:

```json
{
  "sessionId": "codex-thread-id",
  "endpointId": "host-a",
  "host": "host-a.example",
  "workspace": "/workspace/repo",
  "repo": "owner/repo",
  "branch": "feature/example",
  "source": "vscode",
  "status": "idle",
  "humanAttached": true,
  "lastSeenAt": "2026-05-28T10:00:00.000Z",
  "summary": "Short working-state summary"
}
```

The local implementation can derive most fields from Codex thread metadata. Fleet deployment should enrich records with host identity, user attachment state, git state, and sidecar health.

## MCP Surface For Codex

Every supervised Codex gets an MCP server named `openclaw-codex-supervisor`.

Tools:

- `codex_sessions_list`: list visible Codex sessions.
- `codex_session_read`: read one transcript.
- `codex_session_send`: send a message to an idle thread or steer an active thread.
- `codex_session_interrupt`: interrupt the active turn.
- `codex_endpoint_probe`: verify endpoint connectivity.
- `claw_report_progress`: publish current task state to the supervisor.
- `claw_ask`: ask the supervisor for help or delegation.
- `codex_spawn`: create a new autonomous Codex session.
- `codex_handoff`: request human or peer takeover.

Resources:

- `codex://sessions`
- `codex://sessions/{sessionId}`
- `codex://sessions/{sessionId}/transcript`

## Claw Control Surface

The always-on Claw gets the same primitives as internal tools:

- list sessions and endpoints
- read transcripts
- send/steer text
- interrupt active work
- spawn new sessions
- summarize and assign sessions
- broadcast instructions to a filtered group
- mark sessions blocked, done, or abandoned

Tool behavior:

- If a target thread is idle, `codex_session_send` maps to `turn/start`.
- If a target thread is active and an in-progress turn id is visible, it maps to `turn/steer`.
- If the active turn cannot be identified, the tool fails closed instead of creating an unrelated turn.
- Codex-exposed MCP write controls stay disabled unless a trusted supervisor-only policy enables them.
- Raw transcript reads stay disabled unless a trusted supervisor-only policy enables them.
- Autonomous approval defaults deny tool/file approvals unless an explicit policy says otherwise.

## Launch Flow

Interactive host login:

1. User SSHes into a CRAB host.
2. SSH service starts or verifies `codex app-server daemon start`.
3. Login wrapper launches `codex --remote unix:// --cd <workspace>`.
4. Host connector registers endpoint and loaded thread.
5. Supervisor emits a high-priority fleet event: new Codex session, workspace, human-attached state, current task preview.
6. Supervisor Claw can read and steer immediately.

Autonomous spawn:

1. Supervisor selects host and workspace.
2. Host connector opens or resumes a Codex app-server thread.
3. Supervisor starts the first turn with task text and MCP config.
4. Session registry marks it autonomous and attachable.
5. Human can later attach with `codex --remote <endpoint> resume <threadId>` once Codex supports that exact UX, or via current resume flow on the same app-server.

## Deployment

Preferred control plane:

- Host connectors keep outbound WebSocket connections to the supervisor.
- Supervisor state lives in OpenClaw Gateway storage.
- Codex app-server remains local to each host; never expose a raw unauthenticated app-server to the public internet.

Cloudflare viability:

- Good for registry, durable objects, WebSocket fan-in, lightweight event routing, and public MCP/gateway endpoints.
- Not enough by itself for direct private host control because Workers cannot dial arbitrary private Unix sockets or local loopback app-servers.
- Use Cloudflare when every host connector phones home over outbound WebSocket.

VPS fallback:

- Use a Hetzner service when long-lived process control, SSH tunnels, private network routing, or local filesystem access is needed.
- Keep the same protocol: host connectors outbound, supervisor registry central, Codex app-server local.

## Security

- Default bind is local Unix socket.
- Remote app-server uses token or signed bearer auth.
- Host connector authenticates to supervisor with a scoped host token.
- Supervisor tools enforce per-session policy: read, steer, interrupt, spawn, approval.
- Cross-agent messages include `originSessionId`; self-echo is dropped.
- Broadcast requires an explicit filter and bounded target count.
- Transcript reads redact secrets at OpenClaw boundary.
- Approval requests default to deny for supervisor-originated turns unless policy allows them.

## Implementation Plan

Phase 1: Local supervisor MVP

- Add Codex app-server JSON-RPC client for stdio proxy and WebSocket endpoints.
- Add supervisor endpoint/session registry.
- Add MCP tools: list, read, send, interrupt, probe.
- Add local env config for endpoints.
- Add fake app-server tests and one live local app-server smoke.

Phase 2: OpenClaw integration

- Register supervisor tools in the `codex-supervisor` plugin.
- Inject supervisor MCP into Codex thread config.
- Add session summaries to agent context.
- Add event notifications when new Codex threads appear.
- Add policy config for autonomous send/interrupt/spawn.

Phase 3: Fleet connector

- Host sidecar registers app-server endpoint, host metadata, git/workspace metadata, and human attachment state.
- Add outbound WebSocket connector for Cloudflare or VPS control plane.
- Add reconnect, heartbeat, and stale-session cleanup.
- Add CRAB SSH launcher wrapper.

Phase 4: Autonomous operation

- Add spawn/resume/takeover flows.
- Add broadcast and delegation.
- Add progress reports and task-state summaries.
- Add loop prevention and rate limits.
- Add dashboard views.

Phase 5: Multi-Claw

- Shard sessions by group.
- Add leadership/lease for each session.
- Add audit log and replay.
- Add escalation between Claw groups.

## Acceptance Tests

- A human launches Codex TUI through a shared app-server.
- Supervisor lists the live thread via `thread/loaded/list`.
- Supervisor reads transcript via `thread/read`.
- Supervisor sends text to an idle thread via `turn/start`.
- Supervisor steers an active thread via `turn/steer`.
- Supervisor interrupt stops an active turn via `turn/interrupt`.
- Codex calls supervisor MCP and lists peer sessions.
- An autonomous Codex is spawned and later human-attached.
- Lost host connector marks sessions stale without deleting history.

## Open Questions

- Exact Codex TUI attach UX for an app-server thread spawned without a TUI.
- Whether Codex should add `exec --remote` for headless live-shared runs.
- Durable state owner: OpenClaw Gateway DB, Cloudflare Durable Object, or VPS database.
- Approval policy granularity for supervisor-originated turns.
- How much transcript summary should be injected into the always-on Claw context versus kept as a tool/resource.
