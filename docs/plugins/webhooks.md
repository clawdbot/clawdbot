---
summary: "Webhooks plugin: authenticated TaskFlow ingress for trusted external automation"
read_when:
  - You want to trigger or drive TaskFlows from an external system
  - You are configuring the bundled webhooks plugin
title: "Webhooks plugin"
---

The Webhooks plugin adds authenticated HTTP routes so a trusted external
system (Zapier, n8n, a CI job, an internal service) can create and drive
managed OpenClaw TaskFlows over HTTP, without writing a custom plugin.

The plugin runs inside the Gateway process. For a remote Gateway, install and
configure it on that host, then restart the Gateway. It ships with no routes
configured, so it is a no-op until you add at least one route.

## Configure routes

Set config under `plugins.entries.webhooks.config`:

```json5
{
  plugins: {
    entries: {
      webhooks: {
        enabled: true,
        config: {
          routes: {
            zapier: {
              path: "/plugins/webhooks/zapier",
              sessionKey: "agent:main:main",
              secret: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_WEBHOOK_SECRET",
              },
              controllerId: "webhooks/zapier",
              description: "Zapier TaskFlow bridge",
            },
          },
        },
      },
    },
  },
}
```

Route fields:

| Field          | Required | Default                       | Notes                                         |
| -------------- | -------- | ----------------------------- | --------------------------------------------- |
| `enabled`      | no       | `true`                        |                                               |
| `path`         | no       | `/plugins/webhooks/<routeId>` | Must be unique across routes.                 |
| `sessionKey`   | yes      | -                             | Session that owns the bound TaskFlows.        |
| `secret`       | yes      | -                             | Plain string or a SecretRef (below).          |
| `controllerId` | no       | `webhooks/<routeId>`          | Used as the default `create_flow` controller. |
| `description`  | no       | -                             | Operator note only.                           |

`secret` accepts a plain string or a SecretRef: `{ source: "env" | "file" | "exec", provider: "default", id: "..." }`.

SecretRefs resolve into the Gateway's startup config snapshot. When one route's
secret cannot resolve, the Gateway keeps running and that exact route stays
registered but cold: requests receive a generic authentication failure (`401`).
Other routes remain available. Fix the SecretRef source, then reload or restart
the Gateway to activate the new snapshot. SecretRef values are never resolved
on the public request path.

## Security model

Each route acts with the TaskFlow authority of its configured `sessionKey`: it
can inspect and mutate any TaskFlow owned by that session. TaskFlow access
always goes through `api.runtime.tasks.managedFlows.bindSession(...)`, so a
route can never act outside its bound session. To limit blast radius:

- Use a strong, unique secret per route.
- Prefer a SecretRef over an inline plaintext secret.
- Bind routes to the narrowest session that fits the workflow.
- Expose only the specific webhook path you need.

Request handling order for each path: HTTP method (`POST` only) and
`Content-Type: application/json` checks, then fixed-window rate limiting (120
requests per 60-second window per path+client-IP key, up to 4,096 tracked
keys), then in-flight request limiting (8 concurrent requests per key, up to
4,096 tracked keys), then shared-secret authentication, then a 256 KB /
15-second JSON body read. Requests that fail an earlier check never reach
later ones.

## Request format

Send `POST` requests with `Content-Type: application/json` and either
`Authorization: Bearer <secret>` or `x-openclaw-webhook-secret: <secret>`:

```bash
curl -X POST https://gateway.example.com/plugins/webhooks/zapier \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_SHARED_SECRET' \
  -d '{"action":"create_flow","goal":"Review inbound queue"}'
```

## Supported actions

| Action             | Purpose                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `create_flow`      | Create a managed TaskFlow for the route's session.                 |
| `get_flow`         | Fetch one TaskFlow by id.                                          |
| `list_flows`       | List TaskFlows for the route's session.                            |
| `find_latest_flow` | Fetch the most recently updated TaskFlow.                          |
| `resolve_flow`     | Resolve a TaskFlow by opaque token.                                |
| `get_task_summary` | Fetch the task summary for a TaskFlow.                             |
| `set_waiting`      | Mark a TaskFlow waiting, with optional state/wait data.            |
| `resume_flow`      | Resume a waiting/blocked TaskFlow.                                 |
| `finish_flow`      | Mark a TaskFlow finished.                                          |
| `fail_flow`        | Mark a TaskFlow failed.                                            |
| `request_cancel`   | Request cooperative cancellation.                                  |
| `cancel_flow`      | Cancel a TaskFlow (may return `202` if children are still active). |
| `run_task`         | Create a managed child task inside an existing TaskFlow.           |

Mutating actions (`set_waiting`, `resume_flow`, `finish_flow`, `fail_flow`,
`request_cancel`) require `flowId` and `expectedRevision` for optimistic
concurrency; a stale revision returns `409 revision_conflict`.

### `create_flow`

```json
{
  "action": "create_flow",
  "goal": "Review inbound queue",
  "status": "queued",
  "notifyPolicy": "done_only"
}
```

### `run_task`

Allowed `runtime` values: `subagent`, `acp`. `startedAt`, `lastEventAt`, and
`progressSummary` are only valid when `status` is `"running"`; sending them
with any other status returns `400 invalid_request`.

```json
{
  "action": "run_task",
  "flowId": "flow_123",
  "runtime": "acp",
  "childSessionKey": "agent:main:acp:worker",
  "task": "Inspect the next message batch"
}
```

## Response shape

```json
{
  "ok": true,
  "routeId": "zapier",
  "result": {}
}
```

```json
{
  "ok": false,
  "routeId": "zapier",
  "code": "not_found",
  "error": "TaskFlow not found.",
  "result": {}
}
```

Flow and task views never include owner/session metadata, so responses cannot
leak the route's bound `sessionKey`. `code` values include `not_found`,
`not_managed`, `revision_conflict`, `persist_failed`, `cancel_requested`,
`cancel_pending`, `terminal`, `invalid_request`, `request_rejected`, and
action-specific fallback codes (`mutation_rejected`, `create_rejected`,
`task_not_created`, `cancel_rejected`) when a mutation is rejected for a
reason not covered by the named codes above.

## Related

- [Hooks](/automation/hooks) - internal event-driven hooks vs. this HTTP-based TaskFlow bridge
- [Gateway webhooks (`hooks.*` config)](/automation/cron-jobs#webhooks) - separate generic Gateway HTTP endpoint feature; not the same as this plugin's routes
- [Plugin runtime SDK](/plugins/sdk-runtime)
- [CLI webhooks](/cli/webhooks)
