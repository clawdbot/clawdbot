---
summary: "Current integration path for external apps, scripts, dashboards, CI jobs, and IDE extensions"
title: "Gateway integrations for external apps"
sidebarTitle: "External apps"
doc-schema-version: 1
read_when:
  - You are building an external app, script, dashboard, CI job, or IDE extension that talks to OpenClaw
  - You are choosing between Gateway RPC and the Plugin SDK
  - You are integrating with Gateway agent runs, sessions, events, approvals, models, or tools
  - You are pairing a hosting controller with an external wake scheduler
---

External apps talk to OpenClaw through the Gateway protocol: WebSocket
transport plus RPC methods. Use it when a script, dashboard, CI job, IDE
extension, or another process wants to start agent runs, stream events, wait
for results, cancel work, or inspect Gateway resources.

<Note>
  For npm packages, device pairing, reconnect recovery, history, subscriptions,
  and approvals, start with
  [Building a Gateway client](/gateway/clients#install-the-packages). The install
  guide pins the verified stable `2026.8.1` packages and explains how package and
  wire versions affect compatibility. If your
  app supervises the Gateway as a child process, also read
  [Embedding OpenClaw](https://docs.openclaw.ai/gateway/embedding).
</Note>

<Note>
  This page is for code outside the OpenClaw process. Plugin code that runs
  inside OpenClaw should use documented `openclaw/plugin-sdk/*` subpaths instead.
</Note>

## What is available today

| Surface                                                       | Status          | Use it for                                                                                    |
| ------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| [Gateway client guide](/gateway/clients#install-the-packages) | Stable packages | npm packages, auth, reconnect, history, events, approvals, and version policy.                |
| [Embedding guide](https://docs.openclaw.ai/gateway/embedding) | Release train   | Child-process environment, readiness, lifecycle, recovery, RPC ownership, and packaging.      |
| [Gateway protocol](/gateway/protocol)                         | Ready           | WebSocket transport, connect handshake, auth scopes, protocol versioning, and events.         |
| [Gateway RPC reference](/reference/rpc)                       | Ready           | Current Gateway methods for agents, sessions, tasks, models, tools, artifacts, and approvals. |
| [`openclaw agent`](/cli/agent)                                | Ready           | One-shot script integration when shelling out to the CLI is enough.                           |
| [`openclaw message`](/cli/message)                            | Ready           | Sending messages or channel actions from scripts.                                             |

## Recommended path

1. Run or discover a Gateway.
2. Connect over the [Gateway protocol](/gateway/protocol).
3. Call documented RPC methods from [Gateway RPC reference](/reference/rpc).
4. Pin the OpenClaw version you test against.
5. Recheck the RPC reference when upgrading OpenClaw.

For agent runs, start with the `agent` RPC and pair it with `agent.wait` for a
terminal result. For durable conversation state, use the `sessions.*` methods.
For UI integrations, subscribe to Gateway events and render only the event
families your app understands.

## Cooperative host suspension

Hosting controllers that freeze or snapshot a running process can use the
host-neutral suspension handshake:

1. Stop admitting external ingress controlled by the host.
2. Call `gateway.suspend.prepare` with a stable, unique `requestId`.
3. If the response is `busy`, keep the process running and retry later. To hold
   admission closed while already-admitted work finishes, request the optional
   drain mode and poll `gateway.suspend.status` instead.
4. If the response is `ready`, save the returned `suspensionId`, then freeze or
   snapshot the process before `expiresAtMs`.
5. After thaw, or if suspension is abandoned, call `gateway.suspend.resume`
   with that `suspensionId` over the existing or a newly authenticated
   WebSocket. The CLI equivalents are `openclaw gateway suspend` and
   `openclaw gateway resume <suspensionId>`.

A draining or prepared Gateway accepts authenticated operator WebSocket
connections, allowing a controller to reconnect and check, renew, or release
its own lease. New node and worker connections remain fenced. A prepared
Gateway fences every method except `gateway.suspend.*` and one exact
predecessor-bound restart. That exception requires a non-safe
`gateway.restart.request` whose `target` matches the live Gateway lock; safe and
untargeted restart requests remain fenced. No restart exception is available
while the Gateway is still draining. Controllers may reconnect after thaw and
call resume. The
[Admin HTTP RPC plugin](/plugins/admin-http-rpc) remains available for hosts
that cannot speak WebSocket at all. If every control path is lost, the
two-minute lease expiry reopens admission automatically.

The RPC contract is:

- `gateway.suspend.prepare` — `operator.admin`; params
  `{ "requestId": "stable-host-operation-id", "terminalPolicy": "preserve", "drain": true }`
- `gateway.suspend.status` — `operator.read`; params
  `{ "suspensionId": "id-from-prepare" }`
- `gateway.suspend.resume` — `operator.admin`; params
  `{ "suspensionId": "id-from-prepare" }`

`terminalPolicy` and `drain` are optional. `terminalPolicy` accepts only
`"preserve"` or `"terminate"` and defaults to `"preserve"`; `drain` defaults
to `false`. The terminal policy applies to both immediate preparation and drain
mode:

- `"preserve"`: open terminal sessions block suspension. Use this for host
  freeze/snapshot operations that must preserve the running process.
- `"terminate"`: open process-local terminal sessions do not block suspension.
  Use this for release updates that will restart the Gateway. Preparation does
  not close terminals; the actual Gateway restart ends their PTYs and commands.

Pending final chat-state writes (`terminal-persistence`) and all other tracked
work still block preparation under either policy.

IDs are trimmed, must contain a non-whitespace character, and are limited to
128 characters. A busy prepare result has `status: "busy"`, `reason`,
`retryAfterMs`, `activeCount`, and `blockers`. A ready result has this shape:

```json
{
  "status": "ready",
  "suspensionId": "2c3f...",
  "expiresAtMs": 1770000000000,
  "activeCount": 0,
  "blockers": []
}
```

If `drain: true` finds active work, preparation acquires a renewable lease,
pauses new automatic cron scheduling, closes admission to unrelated new work,
and returns:

```json
{
  "status": "draining",
  "suspensionId": "2c3f...",
  "expiresAtMs": 1770000000000,
  "retryAfterMs": 20000,
  "activeCount": 2,
  "blockers": [
    { "kind": "root-request", "count": 1, "message": "1 active request" },
    { "kind": "terminal-session", "count": 1, "message": "1 open terminal session" }
  ]
}
```

Already-admitted work and its owned completions continue naturally; unrelated
new runs, sessions, scheduled jobs, and independent work stay rejected. With
`terminalPolicy: "preserve"`, an open terminal can keep the lease draining until
it closes, the controller resumes the Gateway, or the lease expires. With
`terminalPolicy: "terminate"`, that same terminal remains open but does not
block readiness. Neither policy terminates or detaches terminals during
preparation, polling, renewal, resume, or lease expiry.

Poll `gateway.suspend.status` with the returned `suspensionId`, honoring
`retryAfterMs`. While blockers remain, status returns `status: "draining"`
together with `expiresAtMs`, `retryAfterMs`, `activeCount`, and `blockers`.
Each status call refreshes the active-work snapshot. Once every blocker has
finished, the same lease transitions to `{"status":"ready","expiresAtMs":...}`.
Status returns `{"status":"running"}` when no suspension is held; querying a
different active lease returns a conflict without exposing its identifiers.
Resume returns `{"ok":true,"status":"running","resumed":true}`; repeating it
after a successful resume returns `resumed: false`.

The dedicated `openclaw gateway suspend` command retains its existing
refuse-only behavior. Controllers can request drain mode through any Gateway
client or the generic CLI RPC command:

```bash
openclaw gateway call gateway.suspend.prepare \
  --params '{"requestId":"host-operation-1","terminalPolicy":"preserve","drain":true}' \
  --json
openclaw gateway call gateway.suspend.status \
  --params '{"suspensionId":"<suspension-id>"}' \
  --json
openclaw gateway resume '<suspension-id>'
```

For a release update, use the same handshake with `terminalPolicy: "terminate"`
so an open terminal cannot hold the drain indefinitely:

```bash
openclaw gateway call gateway.suspend.prepare \
  --params '{"requestId":"release-update-1","terminalPolicy":"terminate","drain":true}' \
  --json
```

Wait for the lease to become `ready` before performing the checked restart.
Terminal commands and scrollback are not recovered after restart; see
[Restart recovery](/gateway/restart-recovery#what-is-not-resumed).

A competing request ID or transient scheduler-resume failure returns retryable
`UNAVAILABLE` with `retryAfterMs`. During scheduler recovery, prepare, status,
and resume all return that error, the Gateway remains not-ready and
fail-closed, and the host must not freeze or snapshot it. OpenClaw retries the
scheduler automatically and reopens admission only after recovery succeeds. A
mismatched resume ID returns `INVALID_REQUEST`. Prepare is subject to the
Gateway's control-plane write limit of 30 attempts per minute; honor the
returned retry delay. WebSocket clients are bucketed by device and IP. Admin HTTP
controllers are bucketed by resolved client IP, so controllers behind one
proxy can share a budget.

Without `drain: true`, preparation remains refuse-only: OpenClaw closes new
root/session/command admission, pauses automatic cron ticks, and inspects work
synchronously. If anything is active, it resumes the scheduler and reopens
admission before returning `busy`; it does not interrupt or drain that work.
With `drain: true`, the same suspension owner instead keeps admission closed
and cron scheduling paused until existing work settles. Already-owned cron
completion and reconciliation continue.

Both draining and ready leases last two minutes. Repeat `prepare` before
`expiresAtMs` with the same `requestId`, terminal policy, and drain mode to renew
the same `suspensionId`; changing any of those values conflicts with the
existing lease. Use `status` for routine polling and reserve `prepare` for
renewal to avoid consuming the write budget. Explicit resume and lease expiry
restore scheduling before reopening admission. Leases remain in memory and
disappear if the Gateway process exits.
Restart emission that becomes due during a ready lease waits until the lease
resumes; an in-flight restart makes preparation return `busy`.

While draining or ready, `/healthz` remains live and `/readyz` returns `503`.
Local or authenticated readiness responses include `gateway-draining`;
unauthenticated remote probes receive only `{ "ready": false }`. The HTTP health
probe, suspension methods on authenticated operator WebSocket connections, and
an already-enabled Admin HTTP RPC route remain available. Other unrelated RPCs
return retryable `UNAVAILABLE`. Built-in HTTP user-work routes and ordinary
plugin HTTP routes,
including OpenAI-compatible APIs, tool/session operations, node watches, and
configured hooks, return `503` with `error.code: "gateway_unavailable"`. New
plugin-owned WebSocket upgrades also return `503`; this covers upgrade
ownership, not work performed later over an established plugin socket.

This handshake does not persist incoming messages, stop third-party channel
transports, or control the hosting platform. The host must fence its ingress
before preparation and remains responsible for wake, snapshot/freeze, and
stop. `activeCount` is the aggregate tracked-work count, while `blockers`
contains the non-zero category counts and bounded task details. This is not a
general process-quiescence barrier. A `background-exec` blocker is aggregate
only: command text, process IDs, output, and session or scope identifiers never
cross the protocol. Channel health, maintenance, cache refresh, established
plugin WebSocket sessions, and unregistered plugin-owned background work can
remain active.
The hosting platform must freeze or snapshot the full process tree and its
filesystem consistently; unregistered work cannot be proven idle by this first
contract.

<Tip>
  For host wake scheduling, keep the OpenClaw-facing part in an in-process
  plugin and project idempotent full snapshots to the external host adapter.
  The hosting controller should not import the Plugin SDK or reconstruct cron
  state from event deltas. See [Safe external cron
  projection](/plugins/hooks#safe-external-cron-projection).
</Tip>

## App code vs plugin code

Use Gateway RPC when code lives outside OpenClaw:

- Node scripts that start or observe agent runs
- CI jobs that call a Gateway
- dashboards and admin panels
- IDE extensions
- external bridges that do not need to become channel plugins
- integration tests with fake or real Gateway transports

Use the Plugin SDK when code runs inside OpenClaw:

- provider plugins
- channel plugins
- tool or lifecycle hooks
- agent harness plugins
- trusted runtime helpers

External apps should not import `openclaw/plugin-sdk/*`; those subpaths are for
plugins loaded by OpenClaw.

## Related

- [Building a Gateway client](https://docs.openclaw.ai/gateway/clients)
- [Embedding OpenClaw](https://docs.openclaw.ai/gateway/embedding)
- [Gateway protocol](/gateway/protocol)
- [Gateway RPC reference](/reference/rpc)
- [CLI agent command](/cli/agent)
- [CLI message command](/cli/message)
- [Agent loop](/concepts/agent-loop)
- [Agent runtimes](/concepts/agent-runtimes)
- [Sessions](/concepts/session)
- [Background tasks](/automation/tasks)
- [ACP agents](/tools/acp-agents)
- [Plugin SDK overview](/plugins/sdk-overview)
