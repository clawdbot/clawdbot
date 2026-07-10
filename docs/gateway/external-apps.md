---
summary: "Current integration path for external apps, scripts, dashboards, CI jobs, and IDE extensions"
title: "Gateway integrations for external apps"
sidebarTitle: "External apps"
read_when:
  - You are building an external app, script, dashboard, CI job, or IDE extension that talks to OpenClaw
  - You are choosing between Gateway RPC and the Plugin SDK
  - You are integrating with Gateway agent runs, sessions, events, approvals, models, or tools
---

External apps talk to OpenClaw through the Gateway protocol: WebSocket
transport plus RPC methods. Use it when a script, dashboard, CI job, IDE
extension, or another process wants to start agent runs, stream events, wait
for results, cancel work, or inspect Gateway resources.

<Warning>
  There is no public npm client package yet. Do not add OpenClaw client package
  names as application dependencies until release notes announce a published
  package and this page includes install instructions.
</Warning>

<Note>
  This page is for code outside the OpenClaw process. Plugin code that runs
  inside OpenClaw should use documented `openclaw/plugin-sdk/*` subpaths instead.
</Note>

## What is available today

| Surface                                 | Status | Use it for                                                                                    |
| --------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| [Gateway protocol](/gateway/protocol)   | Ready  | WebSocket transport, connect handshake, auth scopes, protocol versioning, and events.         |
| [Gateway RPC reference](/reference/rpc) | Ready  | Current Gateway methods for agents, sessions, tasks, models, tools, artifacts, and approvals. |
| [`openclaw agent`](/cli/agent)          | Ready  | One-shot script integration when shelling out to the CLI is enough.                           |
| [`openclaw message`](/cli/message)      | Ready  | Sending messages or channel actions from scripts.                                             |

A future client library package is in progress internally, but it is not a
public install surface yet. Treat it as preview implementation detail until a
release announces a published, versioned package.

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
3. If the response is `busy`, keep the process running and retry later.
4. If it is `ready`, save the returned `suspensionId`, then freeze or snapshot
   the process before `expiresAtMs`.
5. After thaw, or if suspension is abandoned, call `gateway.suspend.resume`
   with that `suspensionId` over the existing WebSocket or Admin HTTP control
   path.

A prepared Gateway rejects new WebSocket handshakes. A WebSocket controller
must keep its authenticated connection open across the host operation. If that
cannot be guaranteed, enable and use the
[Admin HTTP RPC plugin](/plugins/admin-http-rpc) before preparing. If the
control path is lost, wait for the two-minute lease to expire before
reconnecting; expiry reopens admission automatically.

The RPC contract is:

- `gateway.suspend.prepare` — `operator.admin`; params
  `{ "requestId": "stable-host-operation-id" }`
- `gateway.suspend.status` — `operator.read`; params
  `{ "suspensionId": "id-from-prepare" }`
- `gateway.suspend.resume` — `operator.admin`; params
  `{ "suspensionId": "id-from-prepare" }`

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

Status returns `{"status":"running"}` or a ready result with `expiresAtMs`.
Resume returns `{"ok":true,"status":"running","resumed":true}`; repeating it
after a successful resume returns `resumed: false`.

A competing request ID or transient scheduler-resume failure returns retryable
`UNAVAILABLE` with `retryAfterMs`. During scheduler recovery, prepare, status,
and resume all return that error, the Gateway remains not-ready and
fail-closed, and the host must not freeze or snapshot it. OpenClaw retries the
scheduler automatically and reopens admission only after recovery succeeds. A
mismatched resume ID returns `INVALID_REQUEST`. Prepare shares the Gateway's
control-plane write budget of three attempts per minute; honor the returned
retry delay. WebSocket clients are bucketed by device and IP. Admin HTTP
controllers are bucketed by resolved client IP, so controllers behind one
proxy can share a budget.

Preparation is refuse-only: OpenClaw closes new root/session/command admission,
pauses automatic cron ticks, and inspects work synchronously. If anything is
active, it resumes the scheduler and reopens admission before returning
`busy`; it does not interrupt or drain that work. A ready lease lasts two
minutes. Repeating `prepare` with the same `requestId` renews it; expiry resumes
the scheduler before reopening admission.
Restart emission that becomes due during a ready lease waits until the lease
resumes; an in-flight restart makes preparation return `busy`.

While ready, `/healthz` remains live and `/readyz` returns `503`. Local or
authenticated readiness responses include `gateway-draining`; unauthenticated
remote probes receive only `{ "ready": false }`. The HTTP health probe,
suspension methods on existing WebSocket connections, and an already-enabled
Admin HTTP RPC route remain available. Other RPCs return retryable
`UNAVAILABLE`. Built-in HTTP user-work routes, including OpenAI-compatible
APIs, tool/session operations, node watches, and configured hooks, return
`503` with `error.code: "gateway_unavailable"`.

This handshake does not persist incoming messages, stop third-party channel
transports, or control the hosting platform. The host must fence its ingress
before preparation and remains responsible for wake, snapshot/freeze, and
stop. `activeCount` is the aggregate tracked-work count, while `blockers`
contains the non-zero category counts and bounded task details. This is not a
general process-quiescence barrier. Channel health, maintenance, cache refresh,
plugin-owned HTTP routes, and plugin-owned background work can remain active.
The hosting platform must freeze or snapshot the full process tree and its
filesystem consistently; unregistered work cannot be proven idle by this first
contract.

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
