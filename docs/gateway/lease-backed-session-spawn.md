---
summary: "Lease-backed Gateway RPC contract for idempotent external subagent spawning"
title: "Lease-backed session spawning"
read_when:
  - You are building an external orchestrator that starts OpenClaw subagents
  - You need the exact allow-lease, metadata, replay, and recovery contract
  - You are integrating sessions_spawn with sessions_list, sessions_status, or sessions_history
---

External orchestrators can use the Agentic OS runtime contract to bind one
`sessions_spawn` request to one short-lived Gateway allow lease. The Gateway
persists the lease reservation before calling the real child-session runner,
then projects the accepted child identity through the session read methods.

Discover the methods with `tools.catalog`. They appear in `runtimeMethods` and
use the parameter names shown below.

## Authorization

Every connected client needs a stable authenticated identity. OpenClaw scopes
lease and spawn replay identities to that principal.

| Method                         | Required scope   |
| ------------------------------ | ---------------- |
| `subagents.allowLease.acquire` | `operator.admin` |
| `subagents.allowLease.status`  | `operator.read`  |
| `subagents.allowLease.release` | `operator.write` |
| `sessions_spawn`               | `operator.write` |
| `sessions_list`                | `operator.read`  |
| `sessions_status`              | `operator.read`  |
| `sessions_history`             | `operator.read`  |

For internal agent callers, `requester_agent_id` must match the authenticated
requester. A lease also binds `run_id`, `phase`, `transition_id`, `agent_id`,
and `client_lease_id`; `sessions_spawn` fails closed if any owner field differs.

## Workflow

1. Acquire an allow lease.
2. Call `sessions_spawn` once with the returned `gateway_lease_id` and exact v1
   metadata.
3. Persist the returned `session_key` and `runId`.
4. Read the accepted identity through `sessions_list`, `sessions_status`, and
   `sessions_history`.
5. Release the lease with a separate release idempotency key when cleanup is
   needed. A successfully spawned lease is already consumed.

## Acquire a lease

Call `subagents.allowLease.acquire` with:

```json
{
  "client_lease_id": "lease-01",
  "idempotency_key": "acquire-01",
  "run_id": "run-01",
  "phase": "B",
  "transition_id": "transition-01",
  "agent_id": "ai-engineer",
  "requester_agent_id": "main",
  "ttl_ms": 60000
}
```

All identity fields are required non-empty strings. `ttl_ms` is a positive
integer with a maximum of 86,400,000 milliseconds (24 hours).

The response includes `status`, `gateway_lease_id`, `external_id`, `lease`, and
`metadata`. Active lease status is `active`; terminal states are `consumed` and
`released`. `metadata` has this envelope:

```json
{
  "metadata_contract_version": "v1",
  "normalized": {},
  "raw_json": "{}"
}
```

`normalized` contains the validated request identity. `raw_json` is its
deterministic canonical JSON projection.

Repeating the same acquisition idempotency key and exact fields returns the
same lease. Reusing either `idempotency_key` or `client_lease_id` with
conflicting fields is rejected.

## Spawn the child session

Call `sessions_spawn` with the acquired lease:

```json
{
  "task": "Run the bounded implementation phase",
  "taskName": "implementation",
  "runtime": "subagent",
  "mode": "run",
  "cleanup": "keep",
  "context": "isolated",
  "lightContext": false,
  "agentId": "ai-engineer",
  "client_request_id": "spawn-01",
  "idempotency_key": "spawn-idem-01",
  "gateway_lease_id": "gateway-lease:...",
  "metadata": {
    "run_id": "run-01",
    "transition_id": "transition-01",
    "client_request_id": "spawn-01",
    "idempotency_key": "spawn-idem-01",
    "phase": "B",
    "agent_id": "ai-engineer",
    "task_digest": "lowercase-sha256-hex"
  }
}
```

`metadata` must contain exactly the seven fields shown. `task_digest` is the
lowercase hexadecimal SHA-256 digest of the UTF-8 bytes of the exact `task`
string.

Supported launch values are:

- `runtime`: `subagent`
- `mode`: `run` when supplied
- `cleanup`: `delete` or `keep`
- `context`: `isolated` or `fork`
- `lightContext`: boolean

`taskName`, `cleanup`, `context`, and `lightContext` are optional. `taskName`
is trimmed and validated before it becomes part of the replay identity.
`agentId` defaults to `metadata.agent_id` and must equal it when supplied.

An accepted response has `status: "accepted"` and includes the canonical
`session_key`, `childSessionKey`, `runId`, `gateway_lease_id`, request
identities, `metadata`, and a nested `session` projection. Exact retries return
the same accepted projection without launching another child. Conflicting
reuse of `idempotency_key` or `client_request_id` is rejected.

## Read session state

- `sessions_list` takes no parameters and returns only sessions owned by the
  authenticated principal.
- `sessions_status` takes `{ "session_key": "..." }`. Its `runtime_session`
  uses `runtime_status: "running"` while active, `"unavailable"` when no run
  state is known, or a canonical terminal reason: `completed`,
  `hard_timeout`, `timed_out`, `cancelled`, `aborted`, `blocked`, `abandoned`,
  or `failed`.
- `sessions_history` takes `{ "sessionKey": "...", "limit": 50,
"includeTools": false }`. `limit` must be a positive integer.
  `includeTools` defaults to false so tool and tool-result messages are omitted.

The status and history methods verify the stored contract projection and then
read the canonical OpenClaw session. They do not expose raw provider failure
text through the runtime projection.

## Release, replay, and recovery

Release takes the lease owner fields plus `gateway_lease_id` and a distinct
`release_idempotency_key`:

```json
{
  "client_lease_id": "lease-01",
  "release_idempotency_key": "release-01",
  "run_id": "run-01",
  "phase": "B",
  "transition_id": "transition-01",
  "agent_id": "ai-engineer",
  "requester_agent_id": "main",
  "gateway_lease_id": "gateway-lease:..."
}
```

An exact release retry returns the same `status: "released"` response.

The Gateway persists acquisition, reservation, accepted-session, and release
replay state in its canonical SQLite state database:

- lease and release replay identities are retained for five minutes after
  becoming terminal;
- accepted session projections are retained for 24 hours and remain retained
  while their child run is active;
- a lease is rechecked for expiry immediately before its spawn reservation is
  persisted;
- an in-process concurrent exact spawn waits for the first result, while a
  conflicting spawn fails closed;
- before launch, the Gateway durably reserves a child session key and run ID;
- after restart, an orphaned reservation is promoted into the normal 24-hour
  session replay index. An exact spawn retry returns those same reserved
  identities without invoking the child runner again. Until canonical runtime
  evidence appears, `sessions_status` reports `runtime_status: "unavailable"`;
- if the accepted session was persisted, an exact retry returns that session
  identity without invoking the child runner again.

Invalid fields, owner mismatches, expired or released leases, and conflicting
replay identities return `INVALID_REQUEST` and fail closed. Unexpected
operational failures return `UNAVAILABLE` so callers can retry the same
identity. Do not switch to a different lease or idempotency identity until the
prior request outcome and the recovery window have been evaluated.

## Related

- [Gateway integrations for external apps](/gateway/external-apps)
- [Gateway protocol](/gateway/protocol)
- [Gateway RPC reference](/reference/rpc)
- [Operator scopes](/gateway/operator-scopes)
- [Session tools](/concepts/session-tool)
