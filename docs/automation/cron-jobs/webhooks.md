---
doc-schema-version: 1
summary: "Gateway HTTP hooks that let an external service wake an agent or submit a turn"
read_when:
  - Letting an external service call OpenClaw over HTTP
  - Enabling, authenticating, and smoke-testing hook endpoints
  - Debugging a hook request status code
title: "Inbound webhooks"
sidebarTitle: "Inbound webhooks"
---

Gateway HTTP hooks: how an external service calls OpenClaw to wake an agent or submit an agent turn. Part of the [Automations](/automation/cron-jobs) guide.

## Webhooks

Gateway HTTP hooks let an external service wake an agent or submit an agent turn.
They are disabled by default. These endpoints are separate from [internal event
hooks](/automation/hooks) (`HOOK.md` handlers) and the [Webhooks
plugin](/plugins/webhooks), which manages TaskFlow records. They also differ from
outbound automation webhook delivery: here, the external service calls OpenClaw.

### Enable and test an agent hook

Start with a running Gateway and an agent that can complete a normal turn. Merge
this into your config, replacing the token with a long random value and `main`
with the intended configured agent:

```json5
{
  hooks: {
    enabled: true,
    token: "<long-random-hook-token>",
    path: "/hooks",
    allowedAgentIds: ["main"],
    allowRequestSessionKey: false,
  },
}
```

Use a token dedicated to hooks, not the Gateway auth token or password. Run these
commands on the Gateway host with its profile/config. Validate the configuration,
restart the installed service to load it, and watch the logs:

```bash
openclaw config validate
```

```bash
openclaw gateway restart
```

```bash
openclaw logs --follow
```

If you run the Gateway in the foreground rather than as an installed service,
stop and start that process instead.

In another terminal, send a harmless test to the local Gateway. Replace the token,
agent id, and port to match your configuration:

```bash
curl --include http://127.0.0.1:18789/hooks/agent \
  -H 'Authorization: Bearer <long-random-hook-token>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: webhook-smoke-001' \
  --data '{"message":"Summarize this test event: the sample import completed.","name":"Webhook smoke test","agentId":"main","deliver":false}'
```

The expected admission response is HTTP `200`:

```json
{ "ok": true, "runId": "<hook-request-run-id>" }
```

This means the run acquired session/global placement admission. It does **not**
mean the model finished, a tool succeeded, or a message was delivered. A single
agent request can wait up to 15 seconds for admission; the model runtime may still
be preparing when the response arrives.

For callers that need the terminal execution and delivery facts in the same
request, add `"waitForCompletion": true` to the direct `/hooks/agent` payload.
The response stays open after admission and returns HTTP `200` when the admitted
run settles:

```json
{
  "ok": true,
  "runId": "<hook-request-run-id>",
  "completion": {
    "status": "ok",
    "replyDisposition": "silent",
    "delivered": false,
    "deliveryAttempted": true,
    "deliverySuppressionReason": "silent"
  }
}
```

`replyDisposition` records whether the model's terminal reply was `visible`,
`silent`, or `empty`, without exposing its text. Post-admission execution or
delivery failures are terminal data in `completion`, not retryable HTTP
failures. `deliveryError`, when present, is the fixed categorical value
`"delivery-failed"`; provider, runtime, model, target, session, and diagnostic
details remain private. The response never includes model output or summaries.
Use an idempotency key so a lost response can replay the same admitted run and
completion result without dispatching again.

In `openclaw logs --follow`, search for `hook agent run completed` and the exact HTTP
`runId`. Runs with `status=ok` and no explicit delivery error log at info level;
all non-ok statuses (including skipped runs), thrown errors, and explicit delivery
errors log at warn level. For this `deliver: false` test, expect `status=ok` with
no successful announcement. A warning with
`status=ok` and `deliveryError` means execution succeeded but delivery failed.
It does not trigger another announcement attempt.

Structured terminal records include the accepted `agentId`, `jobId`, hook name
and source path, and `logicalSessionKey`. When the runner returns them,
`sessionId` correlates the run transcript and `sessionKey` identifies the runtime
session key. Exact-run continuation aliases can be retired after completion;
the key does not guarantee a separate durable session row. Missing session facts
remain unknown. Diagnostics are redacted, single-line, and bounded to
500 characters per string. Successful output is not logged: inspect the agent's
run session for it. The HTTP `runId` correlates hook logs; it is not a TaskFlow id
or a task id to pass to `openclaw tasks show`.

`sessionMode` defaults to `isolated`, so this test gets a fresh run session and
a generated logical `hook:<uuid>` key. The stored session can use a
`cron:...:run:...` key; the logical hook key is not a promise about the transcript's
storage key. A fixed `defaultSessionKey` serializes requests sharing that key,
even in isolated mode; use it only when that ordering is intended.

### Authentication

Every request must include the hook token via one of these headers:

- `Authorization: Bearer <token>` (recommended).
- `x-openclaw-token: <token>`.

Query-string `?token=...` authentication is rejected. Send JSON with
`Content-Type: application/json`. All hook endpoints accept `POST` only. The
[Hooks reference](/gateway/config-hooks#hooks) lists payload fields,
limits, routing policy, and error responses.

<AccordionGroup>
  <Accordion title="POST /hooks/wake">
    Enqueue a trusted notification for the selected agent's main session and optionally request an immediate heartbeat:

    ```bash
    curl --include http://127.0.0.1:18789/hooks/wake \
      -H 'Authorization: Bearer <long-random-hook-token>' \
      -H 'Content-Type: application/json' \
      --data '{"text":"The sample import completed","mode":"now","agentId":"main"}'
    ```

    HTTP `200` includes `eventOutcome: "queued"` when the queue accepts the wake or `eventOutcome: "coalesced"` when the same wake is already the queue's most recent pending event. With `mode: "now"`, a wake is requested in either case; the response does not mean a heartbeat completed. Use `mode: "next-heartbeat"` to avoid requesting an immediate wake.

    A supplied `agentId` must name a configured agent. Supply it explicitly when the fleet has no implicit or retained legacy owner. A caller-selected `sessionKey` requires `mode: "now"`, `hooks.allowRequestSessionKey: true`, and the configured prefix policy; deferred wakes use the main session.

    Wake text is a system event, not an isolated, safety-wrapped email reader turn. Send only a short notification you control. Route raw email, documents, or other untrusted content through an `agent` action with a restricted reader.

  </Accordion>
  <Accordion title="POST /hooks/agent">
    Submit an agent turn with a required `message`. Optional routing, model, thinking, timeout, and idempotency fields are documented in the [payload reference](/gateway/config-hooks#hook-agent-payload).

    Keep `sessionMode: "isolated"` for fresh context. Set `"persistent"` only when repeated events should reuse prior context: direct requests then require an explicit `sessionKey`, `hooks.allowRequestSessionKey: true`, and nonempty `hooks.allowedSessionKeyPrefixes`.

    For direct channel delivery, supply both a concrete `channel` and `to`; add `accountId` to select an enabled channel account. Supplying only part of a destination, using `channel: "last"`, or selecting an invalid account returns `400` before dispatch. Direct hooks do not inherit the main session's last recipient.

    With no destination, the default `deliver: true` allows a completion system event on the target agent's main session. Set `deliver: false` to suppress successful announcements and ignore destination fields; completion is logged instead. Non-ok outcomes still produce a failure event. Disabling announcement is not a tool restriction: restrict the agent's tools separately if it must not send messages.

  </Accordion>
  <Accordion title="Mapped hooks (POST /hooks/<name>)">
    Custom paths resolve through `hooks.mappings`. The first matching mapping wins, ahead of presets. Templates or trusted local JS/TS transforms turn the payload into `wake` or `agent` actions; a transform returning `null` produces HTTP `204` without a run. See [Mapping details](/gateway/config-hooks#mapping-details).

    Persistent mapped hooks require a stable mapping `sessionKey` or `hooks.defaultSessionKey`. Template-derived keys require the same caller-key opt-in and prefix policy as request keys.

    `forEach: "<key>"` fans out over a top-level payload array. Each item sees a one-element array, so the Gmail preset's `messages[0]` means the current email. Agent fan-out admission answers after at most about 8 seconds of dispatch waiting; pending items continue in the background and a partial batch returns non-2xx. Retrying the same batch reuses pending or admitted agent items while the bounded in-memory replay cache retains them. It is not durable exactly-once delivery; mapped wake actions have no replay identity, and the queue may coalesce repeated wakes. The reference covers batch caps and response shapes.

  </Accordion>
</AccordionGroup>

### Verify and troubleshoot hook requests

| Observation                | Check or next action                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401`                      | Check the hook token, not Gateway auth; ensure the proxy forwards the auth header.                                                                                                      |
| `404`                      | Check `hooks.enabled`, `hooks.path`, and whether the custom path matches a mapping.                                                                                                     |
| `400`                      | Read the response error: JSON, agent selection, session policy, or delivery coordinates may be invalid. Correct the request before retrying.                                            |
| `405`, `408`, or `413`     | Use `POST`; send the body promptly; stay within the documented body limit.                                                                                                              |
| `429`                      | Repeated authentication failures were throttled. Correct the token and honor `Retry-After`.                                                                                             |
| `409`                      | Resolve the target session conflict before retrying.                                                                                                                                    |
| `502` or `503`             | Check Gateway logs for preparation, capacity, or restart/suspension failures. Single-run admission timeout cancels queued work; fan-out pending work can still start.                   |
| `200`, but no chat message | Check completion logs first. `deliver: false` intentionally suppresses successful announcements; direct delivery needs both `channel` and `to`. HTTP admission does not prove delivery. |
| `204`                      | The mapping intentionally produced no actions, such as a `null` transform or an empty fan-out array.                                                                                    |

For delivery-enabled requests, also verify receipt at the intended channel,
account, and recipient. Check terminal warnings for `deliveryError`, including
when `status=ok`. `delivered: false` alone does not prove failure, and
`deliveryAttempted: true` does not prove receipt. Explicit suppression and
message-tool delivery can already satisfy the runner's delivery handling;
missing delivery flags remain unknown.

For retried agent requests, reuse an `Idempotency-Key` and the same payload. The
[reference](/gateway/config-hooks#hook-retries-and-fan-out) explains its
scope and lifetime. Use a new key for a new test; a replayed `200` does not run the
agent again.

<Warning>
Keep endpoints behind loopback, a tailnet, or a trusted reverse proxy. Use HTTPS
for remote calls and expose only the required path.

- Use a dedicated hook token and a dedicated subpath; `/` is rejected.
- Restrict `hooks.allowedAgentIds`, including the effective default-agent path.
- Keep `hooks.allowRequestSessionKey: false` unless required; when enabled, constrain `hooks.allowedSessionKeyPrefixes`.
- Treat external event content as data. Agent hook content is safety-wrapped by default, but wrapping does not remove tools or workspace access. Use a restricted agent for untrusted inputs and keep unsafe-content overrides disabled.

</Warning>
