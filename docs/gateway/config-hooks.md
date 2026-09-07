---
summary: "Hook config: HTTP contract, agent payload, session policy, mapping, retries, and Gmail"
read_when:
  - Wiring an inbound hook endpoint
  - Mapping hook payloads to agents or sessions
  - Tuning hook retries, fan-out, or the Gmail integration
title: "Configuration — hooks"
---

Inbound hook keys under `hooks.*`.

For the full key index and the other top-level config domains, see [Configuration reference](/gateway/configuration-reference).

## Hooks

`hooks.*` configures generic Gateway HTTP ingress. For setup and a verified first
request, see [Webhooks](/automation/cron-jobs#webhooks). This is separate from
[internal hooks](/automation/hooks) (`hooks.internal`, `HOOK.md`) and the
[TaskFlow Webhooks plugin](/plugins/webhooks) (`plugins.entries.webhooks`).

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

Replace `main` with the intended configured agent. Hook tokens grant ingress
access, not an authenticated sender identity; treat payload content as untrusted
data and restrict the target agent's tools and workspace separately.

| Field                       | Default                         | Contract                                                                                                                                                                                                          |
| --------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                   | `false`                         | Enable the HTTP endpoints. Requires a nonempty `token`.                                                                                                                                                           |
| `token`                     | unset                           | Shared hook secret string. Use a dedicated long random value; SecretRef objects are not supported here.                                                                                                           |
| `path`                      | `/hooks`                        | Dedicated base path; a leading slash is added and trailing slashes removed. `/` is rejected.                                                                                                                      |
| `allowedAgentIds`           | unrestricted                    | Effective agent allowlist, including the default-agent path. Omitted or containing `"*"` allows all; `[]` denies all.                                                                                             |
| `defaultSessionKey`         | unset                           | Logical agent-run key when no request/mapping key is supplied; otherwise a fresh `hook:<uuid>` is generated. Does not itself enable persistent sessions.                                                          |
| `allowRequestSessionKey`    | `false`                         | Allow keys from `/agent`, `/wake`, and payload-derived mapping/transform values.                                                                                                                                  |
| `allowedSessionKeyPrefixes` | unrestricted                    | Case-insensitive prefixes for explicit request/mapping keys and the default/generated key. An empty list or all-blank list imposes no restriction; blank entries are otherwise ignored. See session policy below. |
| `presets`                   | `[]`                            | Built-in mappings appended after custom mappings. Available preset: `"gmail"`; unknown names add no mappings.                                                                                                     |
| `mappings`                  | `[]`                            | Ordered mapping list; first match wins. See [Mapping details](/gateway/config-hooks#mapping-details).                                                                                                             |
| `transformsDir`             | `<config-dir>/hooks/transforms` | Transform directory, constrained to that root, including symlink containment. Normally `~/.openclaw/hooks/transforms`.                                                                                            |
| `gmail`                     | unset                           | Gmail transport and processing defaults; see [Gmail integration](/gateway/config-hooks#gmail-integration).                                                                                                        |
| `internal`                  | separate subsystem              | Internal event-hook configuration; see [Hooks](/automation/hooks). It does not enable HTTP ingress.                                                                                                               |

`hooks.token` should be distinct from active Gateway shared-secret auth
(`gateway.auth.token` / `OPENCLAW_GATEWAY_TOKEN` or `gateway.auth.password` /
`OPENCLAW_GATEWAY_PASSWORD`). Startup logs a non-fatal warning on reuse;
`openclaw security audit` reports a critical finding, including password auth
supplied at audit time (`--auth password --password <password>`). Use
`openclaw doctor --fix` to rotate a persisted reused hook token, then update all
external senders.

### Hook HTTP contract

Paths below assume `hooks.path: "/hooks"`; replace that prefix if configured
differently. Send `POST` with a JSON body and
`Content-Type: application/json`.

Authentication accepts `Authorization: Bearer <token>` or `x-openclaw-token`.
A nonempty Bearer token takes precedence. A `token` query parameter is rejected
with `400`, even if a valid header is also present. Missing or wrong credentials
return `401`. After 20 failed attempts in a 60-second window, further invalid
authentication attempts from that client are throttled with `429` and
`Retry-After`; valid authentication resets the counter. Loopback is not exempt.
Configure trusted proxy attribution correctly before exposing a proxy route.

The normal body limit is **256 KiB**, with a **30-second** body-read timeout.
Gmail-path mappings receive a larger derived allowance described below. Generic
hooks parse JSON but do not require the JSON content-type header; the TaskFlow
plugin does enforce it.

| Endpoint             | Payload and result                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /hooks/wake`   | Required nonempty `text`; optional `mode` (`"now"` default or `"next-heartbeat"`), `agentId`, `sessionKey`. Returns `200 { ok: true, mode, eventOutcome }`; `eventOutcome` is `"queued"` when the queue accepts the wake or `"coalesced"` when the same wake is already the queue's most recent pending event. `now` requests a heartbeat in either case; the result does not prove the heartbeat ran. |
| `POST /hooks/agent`  | [Agent payload](/gateway/config-hooks#hook-agent-payload). By default returns `200 { ok: true, runId }` after session/global placement admission. With `waitForCompletion: true`, waits for the admitted run and adds bounded terminal execution/delivery facts in `completion`.                                                                                                                       |
| `POST /hooks/<name>` | First matching mapping produces wake/agent actions. No matching mapping returns `404`; no actions returns `204`. Agent fan-out has the [batch response contract](/gateway/config-hooks#hook-retries-and-fan-out).                                                                                                                                                                                      |

The direct `/wake` and `/agent` endpoints take precedence over mappings with
those names. `/hooks` itself has no action.

| Status | Meaning                                                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | Invalid JSON, payload, routing/session policy, or delivery/account selection. Read the `error` before retrying.                                                                                                              |
| `401`  | Hook authentication failed.                                                                                                                                                                                                  |
| `404`  | No hook action or mapping at that path. Disabled hooks fall through to the rest of Gateway routing.                                                                                                                          |
| `405`  | Wrong method; `Allow: POST` is returned.                                                                                                                                                                                     |
| `408`  | Request body timeout.                                                                                                                                                                                                        |
| `413`  | Body exceeds the path's byte limit.                                                                                                                                                                                          |
| `429`  | Failed-authentication throttling; honor `Retry-After`.                                                                                                                                                                       |
| `409`  | Agent admission rejected because the target session changed or cannot accept work.                                                                                                                                           |
| `500`  | Mapping/transform exception (`hook mapping failed`); inspect Gateway logs.                                                                                                                                                   |
| `502`  | Agent preparation failed before admission.                                                                                                                                                                                   |
| `503`  | Single-run admission did not occur within 15 seconds; that queued work is canceled. Fan-out pending work is different: it continues in the background. Gateway suspension/restart can also return `503 gateway_unavailable`. |

Agent admission failures use `{ ok: false, error, runId? }`. Early method/auth/path
failures can be plain text; do not assume every error response is JSON. The
15-second admission deadline is separate from the body-read timeout and
`timeoutSeconds` for the agent turn. HTTP success does not prove a model result
or channel delivery. See [hook verification](/automation/cron-jobs#verify-and-troubleshoot-hook-requests).

### Hook agent payload

| Field               | Default                  | Contract                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `message`           | required                 | Nonempty agent input text; external content is safety-wrapped.                                                                                                                                                                                               |
| `name`              | `"Hook"`                 | Hook label used in logs/completion events.                                                                                                                                                                                                                   |
| `agentId`           | resolved owner           | Must name a configured agent when supplied directly. Required when no implicit/retained owner can be resolved.                                                                                                                                               |
| `sessionKey`        | default/generated key    | Subject to caller-key opt-in and prefix policy.                                                                                                                                                                                                              |
| `sessionMode`       | `"isolated"`             | `"isolated"` creates a fresh run session; `"persistent"` reuses the resolved session.                                                                                                                                                                        |
| `idempotencyKey`    | unset                    | Optional replay key; headers take precedence. See retries below.                                                                                                                                                                                             |
| `waitForCompletion` | `false`                  | Direct `/agent` only. When `true`, keep the HTTP response open after admission and return `completion` with `status` plus available delivery facts. Mappings and fan-out remain admission-only.                                                              |
| `wakeMode`          | `"now"`                  | `"now"` or `"next-heartbeat"`; controls waking for completion events, not whether the agent is dispatched immediately.                                                                                                                                       |
| `deliver`           | `true`                   | Only `false` opts out. With no direct destination, successful output can become a main-session completion event. `false` logs successful completion without an announcement and ignores destination fields. Non-ok execution results produce a status event. |
| `channel`           | none for direct delivery | Registered concrete channel id; must be paired with `to`. Direct `/agent` cannot use `"last"`.                                                                                                                                                               |
| `to`                | unset                    | Nonempty recipient for direct announce delivery, paired with `channel`.                                                                                                                                                                                      |
| `accountId`         | channel default          | Selects a configured, enabled account; requires `channel` and `to`. Unknown, disabled, or invalid selections return `400` before dispatch.                                                                                                                   |
| `model`             | agent/model defaults     | Model id or alias override, subject to model availability and allowlist policy.                                                                                                                                                                              |
| `thinking`          | agent/model defaults     | Thinking override for the run.                                                                                                                                                                                                                               |
| `timeoutSeconds`    | agent timeout            | Positive numeric turn-timeout override; direct payload values are floored to whole seconds. Invalid/nonpositive values are ignored.                                                                                                                          |

Omitting all destination fields runs without a direct announce destination.
Supplying only part of a destination fails with `400` while delivery is enabled.
`deliver: false` disables announcement, not the agent's ability to use messaging
tools; constrain those tools in the agent policy when needed.

### Hook session and agent policy

Direct request agent ids must exist. Mapping agent ids resolve to a configured
agent, with the legacy default-agent fallback for unknown mapping ids. If no
owner can be resolved, admission fails rather than inventing an agent. The
effective agent must pass `allowedAgentIds`; global session-store ownership is
also enforced. Agent-prefixed keys are re-scoped to the selected agent and
prefix-checked again.

Keys resolve from the request/mapping, then `hooks.defaultSessionKey`, then a
generated `hook:<uuid>`. A configured default must match the prefix allowlist.
Without a default, the allowlist must admit generated `hook:` keys.

- Direct `/agent` persistent mode requires an explicit request `sessionKey`, `allowRequestSessionKey: true`, and a nonempty prefix allowlist.
- Persistent mappings require a stable mapping `sessionKey` or `defaultSessionKey`. Static mapping keys do not require caller-key opt-in, but still obey configured prefixes.
- Templated mapping keys require a nonempty prefix allowlist at configuration resolution and `allowRequestSessionKey: true` at dispatch. This includes the built-in Gmail preset unless an earlier mapping overrides it.
- `/wake` accepts an explicit key only with `mode: "now"` and the same caller-key/prefix policy. Without one, it uses the selected agent's main session; `defaultSessionKey` is for agent runs, not wakes.

A logical hook key is not always the stored session key. Isolated runs use fresh
automation run sessions even when the hook key is stable. Persistence controls
conversation reuse, not tool permissions or sandboxing. Requests sharing a
canonical logical key are serialized through completion, even in isolated mode.
A fixed `defaultSessionKey` therefore orders those requests but can make a later
single request hit the admission timeout while an earlier run is still active.

### Mapping details

Custom `mappings` run in array order before `presets`. The first match owns the
request, including a transform that returns `null`; later mappings are not tried.
Both match predicates must pass when supplied. Omitting them matches any custom
hook path.

| Mapping field                | Default                     | Contract                                                                                                                                          |
| ---------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                         | `mapping-<index>`           | Bounded ingress-source attribution for admitted agent actions, not an authenticated principal or invoker.                                         |
| `match.path`                 | any custom path             | Subpath after `hooks.path`, with leading/trailing slashes removed (`gmail` matches `/hooks/gmail`).                                               |
| `match.source`               | any source                  | Exact match against the payload's string `source` field.                                                                                          |
| `action`                     | `"agent"`                   | `"agent"` or `"wake"`.                                                                                                                            |
| `wakeMode`                   | `"now"`                     | `"now"` or `"next-heartbeat"`; becomes `mode` for wake actions.                                                                                   |
| `name`                       | `"Hook"` at dispatch        | Templated agent-run label.                                                                                                                        |
| `agentId`                    | resolved owner              | Static target agent id; subject to effective-agent allowlist.                                                                                     |
| `sessionKey`                 | default/generated key       | Static or templated logical key; see session policy.                                                                                              |
| `sessionMode`                | `"isolated"`                | `"isolated"` or `"persistent"` for agent actions.                                                                                                 |
| `messageTemplate`            | empty                       | Agent input template; the final action must have a nonempty message.                                                                              |
| `textTemplate`               | empty                       | Wake text template; the final action must have nonempty text. Use trusted notification text, not raw untrusted content.                           |
| `forEach`                    | unset                       | Top-level payload array key; one action per item, with a 200-item cap. Nested/prototype paths are rejected.                                       |
| `deliver`                    | `true`                      | Agent announcement policy. Unlike direct `/agent`, mapped delivery may use `"last"` or defer partial targets to the automation delivery resolver. |
| `channel`                    | `"last"`                    | Registered channel id or `"last"`. Mappings do not expose `accountId`.                                                                            |
| `to`                         | unset                       | Templated delivery target. Prefer explicit `channel` and `to`.                                                                                    |
| `model`                      | agent/model defaults        | Templated model override.                                                                                                                         |
| `thinking`                   | agent/model defaults        | Templated thinking override.                                                                                                                      |
| `timeoutSeconds`             | agent timeout               | Positive integer turn timeout.                                                                                                                    |
| `allowUnsafeExternalContent` | `false`                     | Dangerous: disables agent external-content wrapping for this mapping. Gmail's global unsafe flag can also disable wrapping.                       |
| `transform.module`           | unset                       | Safe relative JS/TS module under `transformsDir`; absolute, traversal, URL/drive forms, and symlink escapes are rejected.                         |
| `transform.export`           | `default`, then `transform` | Named function export; an explicitly named export must exist.                                                                                     |

Templates support `{{payload.field}}` or `{{field}}`, array indexing such as
`{{messages[0].subject}}`, `{{headers.x-event-type}}`, `{{query.kind}}`, `{{path}}`,
and `{{now}}` (ISO timestamp). Missing/null values become empty strings; objects
serialize as JSON. An empty rendered session-key template is rejected.

Transforms receive `{ payload, headers, url, path }` and may return a partial
action override, asynchronously if needed. Action output uses `kind: "agent"` or
`"wake"`, with `message` or `text` respectively. Returning `null` skips the action;
when no actions remain the response is `204`, before any run, task, execution
identity, or audit receipt is created. Transform exceptions return `500`.

A transform-provided `sessionKey` is externally derived by default. Only trusted
code producing a fixed key should mark `sessionKeySource: "static"`; never use
that marker to bypass policy for a payload-derived key. Transforms execute as
trusted Gateway code, not in the reader agent's sandbox. They are cached until
hook configuration reload. Keep modules under the hooks transforms root, not
workspace skill directories; move invalid modules there or remove an invalid
`transformsDir` if doctor reports it.

### Hook retries and fan-out

Agent replay keys resolve in this order: `Idempotency-Key`,
`X-OpenClaw-Idempotency-Key`, then payload `idempotencyKey`. Only trimmed nonempty
strings of at most 256 characters are used. The same key replays only for the
same token, path, and resolved dispatch fields; changing the message or routing
can create a new run. Pending admissions and admitted runs with unresolved
completion are retained without TTL or size eviction. After terminal completion
settles, its replay entry expires after 5 minutes and counts toward the 1,000
terminal-entry memory bound. Restart clears all replay state. Failed admissions
remain retryable. Direct retries may change `waitForCompletion` without changing
dispatch identity: admission-only callers replay the `runId`, while waiting
callers share the same completion promise and replay its terminal result.

When requested, `completion.status` is `ok`, `error`, or `skipped`, and
`replyDisposition` is `visible`, `silent`, or `empty`. This disposition exposes
only whether a terminal model reply existed, never its text. The optional
delivery fields are `delivered`, `deliveryAttempted`, `deliveryError`, and
`deliverySuppressionReason` (`empty`, `silent`, `heartbeat`, or
`channel_transform`). Missing delivery fields remain unknown. Post-admission
failures still return HTTP `200`; only admission failures use the non-2xx
statuses above. `deliveryError`, when present, is the fixed categorical value
`"delivery-failed"`. Provider, runtime, model, target, session, diagnostic,
output, and summary details are never returned.

For `forEach`, templates/transforms see the original payload with the chosen
array replaced by `[currentItem]`. Missing, empty, or non-array values produce no
actions (`204`). Only the first **200** items are processed; excess items are
dropped with a warning, not an HTTP failure. Split larger batches at the sender.

Fan-out agent dispatch waits up to **8 seconds after mapping/transform work**.
Pending admissions continue in the background without the single-run 15-second
cancellation deadline. A fully admitted multi-agent batch returns:

```json
{
  "ok": true,
  "runId": "<first-hook-request-run-id>",
  "runIds": ["<hook-request-run-id-1>", "<hook-request-run-id-2>"],
  "dispatched": 2
}
```

A settled single-item batch retains `{ ok: true, runId }`. Partial failures or
pending items return non-2xx with `ok: false`, an incomplete-batch `error`, admitted
`runIds`, and up to five failure messages in `errors`. A pending-only batch uses
`503`. An error can therefore coexist with admitted or still-pending work.

Agent fan-out derives replay identity from each rendered action even without an
explicit idempotency key. Identical retries reconcile pending/admitted items
within the cache lifetime; keep transforms deterministic for retries. Wake
actions dispatch immediately and have no replay identity, including mixed
wake/agent batches. Their response includes `eventOutcome: "queued"` if any wake
was accepted by its queue, or `"coalesced"` if every wake was coalesced by its queue.
This is not durable exactly-once processing.

### Gmail integration

The Gmail preset routes `/hooks/gmail` through `forEach: "messages"` and
`sessionKey: "hook:gmail:{{messages[0].id}}"`, with isolated mode by default. A
custom matching mapping runs before the preset. Without a mapping `agentId`, the
preset uses the resolved default agent; conversation isolation does not restrict
that agent's tools or workspace.

Apply the [restricted Gmail reader
configuration](/automation/cron-jobs#configure-a-restricted-gmail-reader-recommended)
before connecting untrusted mail. The setup command configures transport, not the
reader or session-key policy. For the templated key, set
`allowRequestSessionKey: true` and `allowedSessionKeyPrefixes: ["hook:gmail:"]`
with a matching `defaultSessionKey`, or allow the broader `"hook:"` namespace.
To keep caller-key overrides disabled, replace the preset with an earlier mapping
using a static `sessionKey`. Keep isolated mode unless context reuse is intended.

```json5
{
  hooks: {
    gmail: {
      account: "reader@example.com",
      topic: "projects/<project-id>/topics/gog-gmail-watch",
      subscription: "gog-gmail-watch-push",
      pushToken: "<separate-random-push-token>",
      hookUrl: "http://127.0.0.1:18789/hooks/gmail",
      includeBody: true,
      maxBytes: 20000,
      renewEveryMinutes: 720,
      serve: { bind: "127.0.0.1", port: 8788, path: "/" },
      tailscale: { mode: "funnel", path: "/gmail-pubsub" },
      model: "openai/gpt-5.6-sol",
      thinking: "high",
    },
  },
}
```

This is the transport block, not the complete reader setup. The model is an
example and must be available to the reader. Gmail fields:

| `hooks.gmail` field          | Runtime default              | Contract                                                                                                                                                      |
| ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account`                    | required                     | Gmail account already authorized in `gog`.                                                                                                                    |
| `label`                      | `"INBOX"`                    | Gmail label to watch. OpenClaw excludes `SPAM`, `TRASH`, `DRAFT`, and `SENT` when launching the watcher.                                                      |
| `topic`                      | required                     | Full Pub/Sub topic path. Setup can provision the `gog-gmail-watch` topic.                                                                                     |
| `subscription`               | `"gog-gmail-watch-push"`     | Pub/Sub subscription used by setup.                                                                                                                           |
| `pushToken`                  | required                     | Authenticates incoming pushes to the watcher. Separate from `hooks.token`, which authenticates forwarding to OpenClaw. Setup generates one if absent.         |
| `hookUrl`                    | local Gateway `/hooks/gmail` | Forwarding URL built from `hooks.path` and Gateway port unless configured.                                                                                    |
| `includeBody`                | `true`                       | Include email body snippets. Set `false` in config to omit them.                                                                                              |
| `maxBytes`                   | `20000`                      | Positive integer per-message body limit passed to the watcher. Also used to derive the Gmail HTTP body allowance.                                             |
| `renewEveryMinutes`          | `720`                        | Positive integer watch-renewal interval.                                                                                                                      |
| `serve.bind`                 | `"127.0.0.1"`                | Watcher bind host.                                                                                                                                            |
| `serve.port`                 | `8788`                       | Positive integer watcher port.                                                                                                                                |
| `serve.path`                 | `"/gmail-pubsub"`            | Watcher path. With Tailscale enabled and no explicit target, it becomes `/` because the exposed prefix is stripped.                                           |
| `tailscale.mode`             | `"off"`                      | `"off"`, `"serve"`, or `"funnel"`. Setup defaults to `"funnel"`; runtime without saved config defaults to `"off"`.                                            |
| `tailscale.path`             | resolved serve path          | Exposed Tailscale path, normally `/gmail-pubsub` in setup.                                                                                                    |
| `tailscale.target`           | local watcher                | Optional port, `host:port`, or URL target. An explicit target preserves the configured serve path.                                                            |
| `model`                      | agent/model defaults         | Gmail model default; an explicit mapping model overrides it. A disallowed Gmail default is ignored, while an invalid explicit run override fails preparation. |
| `thinking`                   | agent/model defaults         | `"off"`, `"minimal"`, `"low"`, `"medium"`, or `"high"`; explicit mapping thinking takes precedence.                                                           |
| `allowUnsafeExternalContent` | `false`                      | Dangerous: disable email safety wrapping for Gmail agent turns. Leave off for untrusted inboxes.                                                              |

Gmail-path mappings use a request-body allowance of
`max(256 KiB, min(32 MiB, 100 × (3 × maxBytes + 8192)))`. The multiplier reserves
space for escaped content and message metadata; it is not a guarantee that every
upstream backlog fits. The upstream history page size counts history records,
which can contain multiple messages. Fan-out still processes only the first 200
items and logs dropped excess. See [batch limits and
retries](/gateway/config-hooks#hook-retries-and-fan-out).

When `hooks.enabled: true` and `hooks.gmail.account` is set, the Gateway starts
`gog gmail watch serve` if its executable and required transport configuration
are available, and renews the watch. Set `OPENCLAW_SKIP_GMAIL_WATCHER=1` to opt out.
Do not start a second foreground watcher on the same listener. Setup output can
contain tokens; see the [CLI reference](/cli/webhooks).

A successful push or hook response is transport/admission evidence, not proof of
completed email processing or delivery. Verify the restricted reader through
[logs and its run output](/automation/cron-jobs#verify-the-reader-boundary). For a
reader-to-agent handoff, expose only the required tool and constrain the
default-on [`tools.agentToAgent`](/gateway/config-tools#tools-agenttoagent)
policy with `allow`, or set `enabled: false` when no handoff is needed; see also
[Prompt injection](/gateway/security/prompt-injection) and
[per-agent sandbox and tools](/tools/multi-agent-sandbox-tools).

---
