---
summary: "Build a third-party operator or WebChat client for the Gateway WebSocket protocol"
read_when:
  - Building an operator, dashboard, or WebChat client outside the OpenClaw repository
  - Implementing Gateway reconnect, history, approvals, or device pairing
  - Updating a third-party client for a new Gateway wire version
title: "Building a Gateway client"
---

Use the published Gateway packages to build operator dashboards, WebChat clients,
and other third-party applications. This guide covers the client lifecycle around
the wire contract: authentication, capabilities, reconnect recovery, history,
subscriptions, and version upgrades.

For frame shapes, the handshake, errors, and the complete method surface, read the
[Gateway protocol specification](https://docs.openclaw.ai/gateway/protocol).

## Install the packages

```bash
npm install @openclaw/gateway-client @openclaw/gateway-protocol
```

<Note>
These packages ship with OpenClaw release trains. During the initial rollout, npm
may return `E404` until the first package-bearing OpenClaw release is published;
install them only after the registry pages below resolve.
</Note>

- [`@openclaw/gateway-protocol`](https://www.npmjs.com/package/@openclaw/gateway-protocol)
  provides schemas, runtime validators, TypeScript types, client identity and
  capability registries, structured error readers, and protocol version constants.
  Its npm tarball also includes the generated
  [`protocol.schema.json`](https://unpkg.com/@openclaw/gateway-protocol/protocol.schema.json)
  machine-readable contract.
- [`@openclaw/gateway-client`](https://www.npmjs.com/package/@openclaw/gateway-client)
  is the reference connection implementation. Import the package root for the Node
  client and `@openclaw/gateway-client/browser` for the browser-safe protocol,
  device-auth, and reconnect helpers.

The Node entry owns its WebSocket transport. A browser host supplies a WebSocket
adapter plus persistent storage and signing callbacks for the device identity and
device token.

## Choose scopes and pair the device

A full interactive chat client that also renders approval prompts should request
`role: "operator"` with these scopes:

| Scope                | Use it for                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `operator.read`      | `chat.history`, `sessions.list`, `sessions.subscribe`, model status, and read-only events |
| `operator.write`     | `chat.send` and ordinary session mutations                                                |
| `operator.approvals` | Listing, displaying, and resolving exec or plugin approvals                               |

Add `operator.questions` only if the client handles interactive questions,
`operator.pairing` only if it manages paired devices or nodes, and
`operator.admin` only for administrative operations such as `config.patch`.
The [operator scopes reference](https://docs.openclaw.ai/gateway/operator-scopes)
defines the complete method and approval-time rules.

Do not create a per-client bearer token by hand-editing `openclaw.json`. Configure
the Gateway's shared bootstrap authentication with `openclaw configure --section
gateway` or the `openclaw onboard --gateway-auth ...` options, then let device
pairing mint the client token:

1. Persist an Ed25519 device identity in the client.
2. Wait for `connect.challenge`, sign the challenge-bound device payload, and send
   `connect` with the requested operator role, scopes, and the shared Gateway token
   or password for bootstrap authentication.
3. If the Gateway returns structured `PAIRING_REQUIRED` details, show the request
   ID and pause or retry according to `error.details.recommendedNextStep`.
4. On the Gateway host, review the request with `openclaw devices list`, then
   approve that exact current request with `openclaw devices approve <requestId>`.
5. Reconnect and persist `hello-ok.auth.deviceToken` with the negotiated role and
   scopes. Use that device token for later connections.

Scope or role upgrades create a new pending pairing request. Token rotation cannot
expand the approved pairing contract. See the
[Devices CLI](https://docs.openclaw.ai/cli/devices) for approval, rotation, and
revocation commands.

## Advertise client capabilities

`connect.params.caps` describes optional behavior the client can consume. It does
not grant authorization. Import names from `GATEWAY_CLIENT_CAPS` instead of
duplicating string literals:

```ts
import { GATEWAY_CLIENT_CAPS } from "@openclaw/gateway-protocol/client-info";

const caps = [GATEWAY_CLIENT_CAPS.TOOL_EVENTS];
```

The current registry contains `approvals`, `exec-approvals`, `inline-widgets`,
`run-tool-bindings`, `session-scoped-events`, `plugin-approvals`,
`task-suggestions`, `terminal-offset-seq`, `tool-events`, and `ui-commands`.
Advertise only capabilities the client actually implements.

<Warning>
`tool-events` gates live tool-execution streaming. The Gateway registers only
connections that advertise this capability as recipients for a run's structured
tool events. Without it, the connection receives no live tool events and the
handshake does not report an error.
</Warning>

Capability-gated agent tools are a separate use of the same declaration. If an
agent tool requires a client capability, the Gateway omits that tool unless the
originating client advertised every required capability.

## Recover state after reconnect

Treat every successful reconnect as a new projection over durable history and
current in-memory run state:

1. Re-establish `sessions.subscribe` and the selected session's
   `sessions.messages.subscribe` subscription.
2. Call `chat.history` for the selected `sessionKey` and replace local persisted
   rows with the returned `messages` projection.
3. If `inFlightRun` is present, adopt its `runId`, buffered `text`, and optional
   `plan`. Adopt the run even when `text` is empty.
4. Read `sessionInfo.hasActiveRun` and `sessionInfo.activeRunIds`. Prefer exact
   membership in `activeRunIds` when deciding whether a retained run still owns
   the streaming UI. A true `hasActiveRun` with no listed ID can represent another
   active runtime projection.
5. Reconcile subsequent `agent` events by `payload.runId` and `payload.seq`.
   Maintain the highest accepted sequence independently for each run, ignore an
   already-seen or lower sequence, and treat a forward gap as a reason to reload
   authoritative history.

The outer event frame also has an optional `seq`, which orders events on the
current WebSocket connection. It resets with a new connection. The `seq` inside
an `agent` event payload is assigned per run and orders that run's lifecycle,
assistant, plan, tool, and other stream events.

## Use history metadata and stable anchors

Rows returned by `chat.history` can carry an `__openclaw` metadata envelope:

- `id` is the transcript entry identity. Use it for anchored history requests,
  but not as a unique display-row key.
- `seq` is the positive transcript-record sequence. One stored record can project
  into more than one display row, so keep siblings with the same `id` and sequence
  together.
- `kind` identifies synthetic rows. A compaction boundary uses
  `kind: "compaction"` and may include `tokensBefore` and `tokensAfter` when a
  matching checkpoint recorded those metrics.

Page backward with the response's `hasMore` and `nextOffset` values. Numeric
offsets describe the current transcript projection, so do not persist them as
long-lived bookmarks across reset or compaction. Persist `__openclaw.id` instead.
To restore around a known row, call `chat.history` with `messageId` and the
`sessionId` that returned it. The Gateway can resolve that anchor from reset
archive history; anchored responses intentionally omit numeric paging metadata.

## Subscribe instead of polling usage

Load the initial catalog with `sessions.list`, then call `sessions.subscribe` once
per connection. Merge `sessions.changed` events by `sessionKey`. Session change
payloads can carry live `inputTokens`, `outputTokens`, `totalTokens`,
`totalTokensFresh`, `contextTokens`, `estimatedCostUsd`, response-usage settings,
and active-run state.

Some change notifications are only invalidation signals. If an event omits the
row fields your view needs, refresh `sessions.list`. Do not poll `usage.cost` or
`sessions.usage` to keep a live session list current; reserve those methods for
on-demand aggregate or detailed reports.

## Backfill exec approvals

A client with `operator.approvals` should install its event listener as soon as
`hello-ok` completes, then call `exec.approval.list` to backfill requests that
predate the connection. Reconcile the list and live
`exec.approval.requested` / `exec.approval.resolved` events by approval ID so a
transition racing the list request is neither lost nor resurrected.

## Track protocol versions

The current wire version is `4`. General operator and WebChat clients must
negotiate the exact current version with `minProtocol: 4` and `maxProtocol: 4`.
Only authenticated node clients and lightweight probes have the N-1 acceptance
window, currently protocol `3` through `4`.

Protocol changes are additive first. `protocol.schema.json` includes `since`
release-vintage metadata and required scope metadata for core methods, but a wire
version bump is still an explicit breaking event for third-party clients. Pin the
package versions you test, upgrade the client and Gateway together when the wire
version changes, and review the
[OpenClaw changelog](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)
before each upgrade.

## Related

- [Gateway protocol](https://docs.openclaw.ai/gateway/protocol)
- [Embedding OpenClaw](https://docs.openclaw.ai/gateway/embedding)
- [Gateway RPC reference](https://docs.openclaw.ai/reference/rpc)
- [Gateway integrations for external apps](https://docs.openclaw.ai/gateway/external-apps)
