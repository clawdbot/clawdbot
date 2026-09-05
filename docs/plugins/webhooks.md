---
doc-schema-version: 1
summary: "Webhooks plugin: authenticated TaskFlow ingress for trusted external automation"
read_when:
  - You want to create or update TaskFlow records from an external system
  - You are configuring the bundled webhooks plugin
title: "Webhooks plugin"
---

The Webhooks plugin adds authenticated HTTP routes so a trusted external
system (Zapier, n8n, a CI job, an internal service) can create and drive
managed OpenClaw TaskFlow records over HTTP, without writing a custom plugin.
`create_flow` creates a tracking record; `run_task` creates or links a child task
record. Neither operation starts an agent. The external controller owns the
workflow and advances its state.

To submit an agent turn from an external event, use [Gateway HTTP
hooks](/automation/cron-jobs#webhooks). To react to internal agent events, use
[internal hooks](/automation/hooks). Those surfaces do not share this plugin's routes or authentication.

The plugin runs inside the Gateway process. For a remote Gateway, install and
configure it on that host. Apply route config changes with
`openclaw plugins reload webhooks`. It ships with no routes configured, so it is
a no-op until you add at least one route.

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
              sessionKey: "agent:main:hook:automation",
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

`secret` accepts a plain string or a SecretRef: `{ source: "env" | "file" | "exec" | "store", provider: "default", id: "..." }`.

SecretRefs resolve into the Gateway's runtime config snapshot. When one route's
secret cannot resolve, the Gateway keeps running and that exact route stays
registered but cold: requests receive a generic authentication failure (`401`).
Other routes remain available. Fix the SecretRef source, then run
`openclaw plugins reload webhooks` to activate the new snapshot. If you changed
the environment inherited by the Gateway service, restart that service with
the new environment. SecretRef values are never resolved on the public request
path.

## Security model

Each route authenticates with its own `secret`, not `hooks.token` or the Gateway
auth token. Use HTTPS outside loopback. The endpoint accepts the action schema
below, not arbitrary provider webhook payloads, URL verification challenges, or
provider-specific HMAC signatures. Use an existing automation service to validate
and translate external events when needed. Treat event content as data.

Each route acts with the TaskFlow authority of its configured `sessionKey`: it
can inspect and mutate any TaskFlow owned by that session. TaskFlow access
always goes through `api.runtime.tasks.managedFlows.bindSession(...)`, so a
route can never act outside its bound session. To limit blast radius:

- Use a strong, unique secret per route.
- Prefer a SecretRef over an inline plaintext secret.
- Bind routes to the narrowest session that fits the workflow.
- Expose only the specific webhook path you need.

Request handling order is: `POST` method, fixed-window rate limit, JSON content
type, in-flight limit, shared-secret authentication, bounded JSON body read, then
action validation. Earlier failures do not reach later checks.

| Limit                        | Scope                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 120 requests per 60 seconds  | Path plus client IP resolved using trusted proxy settings; at most 4,096 tracked keys.                     |
| 8 concurrent requests        | Path plus socket peer address; at most 4,096 tracked keys. Clients behind one proxy can share this bucket. |
| 256 KiB body, 15-second read | Per request. This is a body-read timeout, not an agent-run timeout.                                        |

## Request format

Send `POST` requests with `Content-Type: application/json` and either
`Authorization: Bearer <secret>` or `x-openclaw-webhook-secret: <secret>`:

```bash
curl --include https://gateway.example.com/plugins/webhooks/zapier \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <route-secret>' \
  -d '{"action":"create_flow","goal":"Review inbound queue"}'
```

The successful response contains `result.created: true` and `result.flow` with
its `flowId`, `revision` (initially `0`), and status (default `queued`). Keep the
flow id and read it back using the same route:

```bash
curl --include https://gateway.example.com/plugins/webhooks/zapier \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <route-secret>' \
  --data '{"action":"get_flow","flowId":"<returned-flow-id>"}'
```

HTTP `200` confirms a read or record operation, not completed agent work or
message delivery. Use `get_task_summary` for linked task counts and
[task inspection](/cli/tasks) for actual task status and delivery status. Keep
those outcomes separate from the controller's flow status.

## Supported actions

| Action             | Purpose                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| `create_flow`      | Create a managed TaskFlow record for the route's session.                   |
| `get_flow`         | Fetch one TaskFlow by id.                                                   |
| `list_flows`       | List the session's TaskFlows, newest created first.                         |
| `find_latest_flow` | Fetch the most recently created TaskFlow.                                   |
| `resolve_flow`     | Resolve by flow id or the exact bound session key (its latest flow).        |
| `get_task_summary` | Fetch the task summary for a TaskFlow.                                      |
| `set_waiting`      | Mark a TaskFlow waiting, with optional state/wait data.                     |
| `resume_flow`      | Resume a waiting/blocked TaskFlow.                                          |
| `finish_flow`      | Mark a TaskFlow finished.                                                   |
| `fail_flow`        | Mark a TaskFlow failed.                                                     |
| `request_cancel`   | Record a cooperative cancellation request; does not cancel children itself. |
| `cancel_flow`      | Cancel a TaskFlow (may return `202` if children are still active).          |
| `run_task`         | Create or link a managed child task record; does not start a run.           |

Mutating actions (`set_waiting`, `resume_flow`, `finish_flow`, `fail_flow`,
`request_cancel`) require `flowId` and `expectedRevision` for optimistic
concurrency; a stale revision returns `409 revision_conflict`. Read `result.current`
or call `get_flow`, reconcile the change, then use its current revision.
`cancel_flow` and `run_task` do not take `expectedRevision`. Action schemas reject
unknown fields.

Read actions can return HTTP `200` with `flow: null` or `summary: null` when the
flow is absent or outside the route's session. A successful read does not imply
that a matching flow exists.

### `create_flow`

```json
{
  "action": "create_flow",
  "goal": "Review inbound queue",
  "status": "queued",
  "notifyPolicy": "done_only"
}
```

`goal` is required. Optional fields are `controllerId`, `status` (`queued`,
`running`, `waiting`, `blocked`), `notifyPolicy` (`done_only`, `state_changes`,
`silent`), `currentStep`, `stateJson`, and `waitJson`. The request's `controllerId`
overrides the route default; it is not a separate authorization boundary.

Creation has no general idempotency key: retrying `create_flow` after an uncertain
connection result can create a second flow. Reconcile with `list_flows` before
repeating creation. Child success alone does not mark a managed flow finished;
the controller must advance or finish the flow when appropriate.

### `run_task`

Required fields are `flowId`, `runtime`, and `task`. Allowed `runtime` values are
`subagent` and `acp`; `status` defaults to `queued` and can be `running`. `startedAt`, `lastEventAt`, and
`progressSummary` are only valid when `status` is `"running"`; sending them
with any other status returns `400 invalid_request`.

The following links an **already existing**, currently owned backing run. Use
the managed flow id returned by `create_flow`, and the `childSessionKey` and
`runId` from that existing run. Inventing a child key or run id does not start
work or grant authority.

```json
{
  "action": "run_task",
  "flowId": "<flow-id>",
  "runtime": "acp",
  "childSessionKey": "<existing-child-session-key>",
  "runId": "<existing-run-id>",
  "task": "Inspect the next message batch"
}
```

`childSessionKey` requires the exact `runId` and current backing ownership by the
route's configured session. Foreign, stale, or replaced runs are rejected at use
time. Omit `childSessionKey` to create an unbacked tracking record; supplying an
invalid backing reference is rejected. Reuse by
`runId` is scoped to the runtime, owner, child, and flow; it is not a universal
request-replay guarantee.

Optional metadata includes `sourceId`, `parentTaskId`, `agentId`, `label`,
`preferMetadata`, and `notifyPolicy` (`done_only`, `state_changes`, `silent`).
`startedAt` and `lastEventAt` are nonnegative integer timestamps in milliseconds.

### Waiting and completion

`set_waiting` accepts `currentStep`, `stateJson`, `waitJson`, `blockedTaskId`, and
`blockedSummary`. A nonempty blocked field selects `blocked`; otherwise the flow
becomes `waiting`. `resume_flow` accepts `status` (`queued` default or `running`),
`currentStep`, and `stateJson`, and clears waiting/blocked state.

`finish_flow` marks the flow `succeeded` and accepts `stateJson`; `fail_flow` marks
it `failed` and also accepts `blockedTaskId` and `blockedSummary`. Optional string
fields accept `null` to clear them; `stateJson` and `waitJson` accept any JSON
value, including retained JSON `null`. Use the current `expectedRevision` for
each transition.

### Cancellation

`request_cancel` records cancellation intent. `cancel_flow` attempts cancellation
of linked work. If children remain active, the response is HTTP `202` with
`ok: true`, `code: "cancel_pending"`, and `result.cancelled: false`. Check
`get_flow` and `get_task_summary` afterward; `202` does not mean cancellation
finished.

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

Flow and task views omit owner/requester metadata such as `ownerKey`,
`requesterSessionKey`, and `requesterOrigin`. Task views can still include
`childSessionKey`, `agentId`, and `runId`; treat responses as operational data.
`code` values include `not_found`,
`not_managed`, `revision_conflict`, `persist_failed`, `cancel_requested`,
`cancel_pending`, `terminal`, `invalid_request`, `request_rejected`, and
action-specific fallback codes (`mutation_rejected`, `create_rejected`,
`task_not_created`, `cancel_rejected`) when a mutation is rejected for a
reason not covered by the named codes above.

### Errors and troubleshooting

| Response              | Next check                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `401`                 | Use the route secret. Repair an unresolved SecretRef, then run `openclaw plugins reload webhooks`; see the environment note above. |
| `405` / `415`         | Send `POST` with `Content-Type: application/json`.                                                                                 |
| `408` / `413`         | Send the JSON body within 15 seconds and below 256 KiB.                                                                            |
| `429`                 | Reduce request rate or concurrent requests, including clients sharing a proxy.                                                     |
| `400 invalid_request` | Check the action's fields and types; unknown fields are rejected.                                                                  |
| `404 not_found`       | The mutation target does not exist in the route's bound session.                                                                   |
| `409`                 | Inspect `code`: reconcile revisions, managed-flow status, cancellation state, or backing-run ownership.                            |
| `503 persist_failed`  | The record could not be persisted; investigate Gateway storage/logs before retrying.                                               |

Failures before action validation can be plain text, not the JSON envelope
above. A Bearer header takes precedence over `x-openclaw-webhook-secret`;
query-string and body tokens are not authentication methods for this plugin.

## Related

- [Hooks](/automation/hooks) - internal event-driven hooks vs. this HTTP-based TaskFlow bridge
- [Gateway webhooks (`hooks.*` config)](/automation/cron-jobs#webhooks) - separate generic Gateway HTTP endpoint feature; not the same as this plugin's routes
- [Plugin runtime SDK](/plugins/sdk-runtime)
- [CLI webhooks](/cli/webhooks)
