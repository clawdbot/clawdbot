---
summary: "Cooperative host suspension: fence new work, wait for the gateway to go idle, then snapshot, freeze, or restart the host without interrupting tracked work"
read_when:
  - You are building a hosting controller that snapshots, freezes, or rolls out a gateway host
  - You need to know when it is safe to stop or migrate a gateway process
  - You are debugging a suspension lease, a busy result, or a stuck readiness probe
title: "Cooperative host suspension"
---

Cooperative host suspension lets an external controller ask a gateway to stop
accepting new work and confirm that everything already admitted has finished.
Once the gateway confirms, the controller owns a short lease during which it can
snapshot the filesystem, freeze the VM, or replace the process without cutting
an agent turn in half.

This is a cooperative protocol, not a kill switch. The gateway never cancels
running work to satisfy a suspension request — it either reports what is still
busy, or confirms it is idle.

<Warning>
Suspension prevents the *interruption* of tracked work. It does not checkpoint
an in-flight LLM execution. Nothing captures the state of a model call that is
mid-flight, so a controller must reach a `ready` result before freezing or
stopping the process. Work that was already running when the process dies falls
back to ordinary [restart recovery](/gateway/restart-recovery).
</Warning>

## The four methods

| Method                      | Scope            | Purpose                                                       |
| --------------------------- | ---------------- | ------------------------------------------------------------- |
| `gateway.suspend.preflight` | `operator.read`  | Point-in-time busy inspection. Observes only.                 |
| `gateway.suspend.prepare`   | `operator.admin` | Fence new work, then report `busy` or `ready`. Authoritative. |
| `gateway.suspend.status`    | `operator.read`  | Inspect a lease you already own.                              |
| `gateway.suspend.resume`    | `operator.admin` | Release the lease and reopen admission.                       |

All four are available over WebSocket RPC and, when the bundled
[`admin-http-rpc`](/plugins/admin-http-rpc) plugin is enabled, over
`POST /api/v1/admin/rpc`. Prefer the WebSocket client when the controller can
hold a connection open; use the HTTP route for host tooling that cannot.

Do not add a separate management endpoint for this. The suspension methods stay
reachable on the existing authenticated control path while ordinary user-work
admission is closed.

## Authentication

Suspension uses ordinary gateway authentication and scope checks — there is no
unauthenticated management path.

- `prepare` and `resume` require the administrative operator scope
  (`operator.admin`).
- `preflight` and `status` require the read operator scope (`operator.read`).

Over the HTTP route these run behind gateway HTTP auth first, then the same
scope checks as WebSocket RPC. See the
[admin-http-rpc security model](/plugins/admin-http-rpc) before enabling it.

### Rate limiting

`prepare` is a control-plane write and is subject to control-plane write rate
limiting. `preflight`, `status`, and `resume` are not — `resume` is deliberately
exempt because it is the safety escape hatch that reopens a fenced gateway, and
must never be throttled away when a controller needs it.

## Preflight is advisory

`preflight` returns a structured, point-in-time observation of tracked work:

```json
{
  "status": "busy",
  "activeCount": 3,
  "counts": {
    "queueSize": 0,
    "pendingReplies": 1,
    "embeddedRuns": 0,
    "backgroundExecSessions": 0,
    "cronRuns": 1,
    "activeTasks": 0,
    "rootRequests": 0,
    "sessionAdmissions": 0,
    "sessionMutations": 0,
    "chatRuns": 1,
    "queuedTurns": 0,
    "terminalPersistence": 0,
    "terminalSessions": 0,
    "totalActive": 3
  },
  "blockers": [
    { "kind": "cron-run", "count": 1, "message": "1 active cron run(s)" },
    { "kind": "chat-run", "count": 1, "message": "1 active chat run(s)" },
    { "kind": "reply", "count": 1, "message": "1 pending reply delivery operation(s)" }
  ]
}
```

Counts can overlap by category, so read individual counts for diagnostics and
treat `totalActive` as an aggregate. `status` is `idle` when `totalActive` is
zero.

<Note>
Preflight never closes admission and never takes a lease. An `idle` preflight
is not permission to freeze the host: work can arrive in the same millisecond.
`prepare` remains authoritative and may return `busy` immediately after
preflight reported idle.
</Note>

Busy accounting covers active agent and chat runs, queued session-lane work,
active subagents and embedded runs, active cron runs, pending reply delivery and
terminal persistence, active root work, work already admitted but not completed,
and an in-progress gateway restart.

## Prepare is authoritative

`prepare` takes a `requestId` that identifies the controller's operation:

```json
{ "requestId": "snapshot-2026-08-24T10:00:00Z" }
```

The `requestId` is trimmed, must contain at least one non-whitespace character,
and is limited to 128 characters. Anything else is rejected as invalid params.

Prepare closes new work admission _before_ taking its authoritative snapshot,
pauses new cron ticks, and then inspects active and queued work.

**If work is active**, prepare rolls back — it reopens admission, resumes the
scheduler, and returns busy:

```json
{
  "status": "busy",
  "reason": "active-work",
  "retryAfterMs": 20000,
  "activeCount": 2,
  "blockers": [{ "kind": "chat-run", "count": 2, "message": "2 active chat run(s)" }]
}
```

**If nothing is active**, prepare holds the fence and returns ready:

```json
{
  "status": "ready",
  "suspensionId": "0f6c…",
  "expiresAtMs": 1756029600000,
  "activeCount": 0,
  "blockers": []
}
```

Prepare never waits for work to finish. It returns immediately, and the
controller polls and retries — honor `retryAfterMs` (20 seconds) between
attempts. After `ready`, no new tracked user work is admitted.

## The lease

A ready suspension holds a bounded **two-minute** lease.

- **Renewal:** calling `prepare` again with the _same_ `requestId` renews the
  existing lease and returns the same `suspensionId`. A long host operation
  should renew well before expiry.
- **Ownership:** a _different_ `requestId` cannot take over an active
  suspension. It gets a retryable `UNAVAILABLE` carrying
  `reason: "gateway-suspension-conflict"` and the current `expiresAtMs`.
- **Automatic resume:** when the lease expires, the gateway resumes the
  scheduler, reopens admission, and clears suspension state on its own. This
  happens on a timer and does **not** require the controller to poll. A
  controller that crashes mid-operation cannot wedge the gateway shut.

If the scheduler cannot be resumed during recovery, the gateway stays
fail-closed and returns a retryable `UNAVAILABLE` with
`reason: "scheduler-resume-failed"` rather than pretending it is running.

## Status and resume

`status({suspensionId})` returns `running` (no suspension held), `ready` with
`expiresAtMs`, or a retryable error while scheduler recovery is pending. A
missing or mismatched `suspensionId` never exposes or releases another
controller's suspension — it returns a conflict instead.

`resume({suspensionId})` validates ownership, resumes the scheduler, reopens
admission, and clears the suspension:

```json
{ "ok": true, "status": "running", "resumed": true }
```

Resume is idempotent — resuming an already-resumed or expired lease succeeds
with `resumed: false`. A stale `suspensionId` is rejected when a newer
suspension is active. The suspension ID is not discarded until recovery is
confirmed, so a failed resume can be retried safely.

## What is refused while prepared

While a suspension is held the gateway refuses new tracked work but stays
inspectable and controllable:

**Refused** — new WebSocket handshakes; new agent, chat, and session work; new
cron execution; ordinary user-work HTTP routes.

**Allowed** — health and liveness checks; the four suspension methods over the
authenticated control path; an exact targeted non-safe
`gateway.restart.request`.

Cron schedules are paused, not dropped. A job that becomes due while suspended
runs after resume rather than being lost.

## Readiness behavior

- `/healthz` stays healthy for as long as the process is alive. Suspension is
  not a liveness failure.
- `/readyz` returns `503` while a suspension is held, so a load balancer stops
  sending traffic.
- Authenticated or local readiness responses include a `gateway-draining`
  reason. Unauthenticated readiness does not expose sensitive runtime detail.
- On resume or lease expiry, readiness recovers automatically.

## Controller loop

A hosting controller should follow this shape:

1. _(Optional)_ Call `preflight` to decide whether it is even worth trying.
2. Call `prepare` with a stable `requestId` for the whole operation.
3. On `busy`, wait `retryAfterMs` and retry from step 2 with the **same**
   `requestId`, up to your own deadline.
4. On `ready`, record the `suspensionId` and `expiresAtMs`.
5. Perform the host operation — snapshot, freeze, or restart. Renew by calling
   `prepare` again with the same `requestId` if it will outlast the lease.
6. Call `resume` with the `suspensionId`. If the process was replaced, the new
   process starts unsuspended and needs no resume.
7. If anything fails, either call `resume` or simply stop — lease expiry
   reopens the gateway on its own.

An in-process gateway restart resets suspension state, so a restarted gateway
never comes back still fenced by a lease from its previous lifecycle.

### WebSocket RPC

```bash
openclaw gateway suspend --request-id snapshot-2026-08-24 --wait 30
# ... perform the host operation ...
openclaw gateway resume <suspensionId>
```

See [`gateway suspend`](/cli/gateway) for the full CLI surface.

### HTTP

```bash
curl -sS http://<gateway-host>:<port>/api/v1/admin/rpc \
  -H 'Authorization: Bearer <gateway-token>' \
  -H 'Content-Type: application/json' \
  -d '{"method":"gateway.suspend.prepare","params":{"requestId":"snapshot-2026-08-24"}}'

curl -sS http://<gateway-host>:<port>/api/v1/admin/rpc \
  -H 'Authorization: Bearer <gateway-token>' \
  -H 'Content-Type: application/json' \
  -d '{"method":"gateway.suspend.resume","params":{"suspensionId":"<suspensionId>"}}'
```

## Plugin-owned background work

Core accounting covers work the gateway tracks itself. A plugin that owns its
own background queue can register a suspension participant so its work is
fenced and counted alongside core work — see
[plugin suspension participants](/plugins/sdk-runtime).
