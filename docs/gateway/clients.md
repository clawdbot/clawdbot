---
summary: "Build a third-party operator or WebChat client for the Gateway WebSocket protocol"
read_when:
  - Building an operator, dashboard, or WebChat client outside the OpenClaw repository
  - Implementing Gateway reconnect, history, approvals, or device pairing
  - Updating a third-party client for a new Gateway wire version
title: "Building a Gateway client"
doc-schema-version: 1
---

Use the published Gateway packages to build operator dashboards, WebChat clients,
and other third-party applications. This guide covers the client lifecycle around
the wire contract: authentication, capabilities, reconnect recovery, history,
subscriptions, and version upgrades.

For frame shapes, the handshake, errors, and the complete method surface, read the
[Gateway protocol specification](https://docs.openclaw.ai/gateway/protocol).

## Install the packages

Install the verified stable release, `2026.8.1`, with exact version pins:

```bash
npm install --save-exact @openclaw/gateway-client@2026.8.1 @openclaw/gateway-protocol@2026.8.1
```

If an existing lockfile still pins either package to the reserved `0.0.0`
artifact, rerun the command above to replace it. Those reserved artifacts have no
runnable entrypoint or TypeScript declarations.

Package versions follow the OpenClaw release train and are separate from the wire
protocol version. The `2026.8.1` packages export wire version `4`; that does not
guarantee compatibility with every Gateway release. The root `openclaw` CLI has
its own package versions and dist-tags. Pin and test the client and Gateway
versions together, and check the [wire-version rules](/gateway/clients#track-protocol-versions)
before upgrading. The `2026.8.1` client pins protocol package `2026.8.1` exactly.

- [`@openclaw/gateway-protocol`](https://www.npmjs.com/package/@openclaw/gateway-protocol)
  provides schemas, runtime validators, TypeScript types, client identity and
  capability registries, structured error readers, and protocol version constants.
  Its npm tarball also includes the generated
  [`protocol.schema.json`](https://unpkg.com/@openclaw/gateway-protocol@2026.8.1/protocol.schema.json)
  machine-readable contract. Download it as a file; it is not an exported package
  import subpath.
- [`@openclaw/gateway-client`](https://www.npmjs.com/package/@openclaw/gateway-client)
  is the reference connection implementation. Import the package root for the Node
  client and `@openclaw/gateway-client/browser` for the browser-safe protocol,
  device-auth, and reconnect helpers.

These package releases declare Node.js `>=22.19.0`. The Node entry includes the `ws`
transport; device identity, signing, and device-token storage remain host-owned
through `GatewayClientHostDeps`. A browser host supplies a WebSocket adapter plus
persistent storage and signing callbacks for the device identity and device token.

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
2. Wait for `connect.challenge`, use its `ts` as the device proof's `signedAt`,
   sign the challenge-bound device payload, and send `connect` with the requested
   operator role, scopes, and the shared Gateway token or password for bootstrap
   authentication. A received WebSocket challenge without a non-negative integer
   `ts` is invalid. Clients that explicitly support Gateways from before
   `connect.challenge` existed may use local time only on their no-challenge path.
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

The current registry contains `agent-kind`, `approvals`, `exec-approvals`,
`inline-widgets`, `plugin-approvals`, `run-tool-bindings`, `session-scoped-events`,
`task-suggestions`, `terminal-offset-seq`, `tool-events`, `ui-commands`, and
`usage-refreshing`.
Advertise only capabilities the client actually implements.

`usage-refreshing` allows a cold `usage.status` request to return immediately
with `refreshing: true` and an empty provider list. A client advertising it must
keep that payload cache-cold and refetch on a short bounded schedule. Other
clients retain the blocking cold read.

<Warning>
`tool-events` gates live tool-execution streaming. The Gateway registers only
connections that advertise this capability as recipients for a run's structured
tool events. Without it, the connection receives no live tool events and the
handshake does not report an error.
</Warning>

Capability-gated agent tools are a separate use of the same declaration. If an
agent tool requires a client capability, the Gateway omits that tool unless the
originating client advertised every required capability.

## Validate attachments before sending

Attachment limits are operator-tunable, so do not hardcode them. Read
`hello-ok.policy.attachments` and validate locally before uploading:

```ts
const attachments = hello.policy.attachments;
if (attachments) {
  const ceiling = isImage ? attachments.maxImageBytes : attachments.maxBytes;
  if (file.byteLength > ceiling) rejectLocally();
}
```

Both values are decoded per-attachment ceilings. Still check the serialized
request against `policy.maxPayload`: attachments travel as base64, so a file near
`maxBytes` can exceed the frame limit on its own. Older gateways omit
`policy.attachments`; when it is absent, send and handle the server outcome.
Accepted MIME types and per-message handling are not advertised because they
depend on the entrypoint and the resolved model. The gateway can return a typed
rejection, while text-only model runs can omit additional images after their
offload cap and still complete the request. The values are a connection-time
snapshot, so re-read them on every reconnect.

## Recover state after reconnect

Treat every successful reconnect as a new projection over durable history and
current in-memory run state:

1. Re-establish `sessions.subscribe` with your list parameters to receive the
   current roster in the same response, as described
   [below](/gateway/clients#subscribe-instead-of-polling-usage). Also re-establish
   the selected session's `sessions.messages.subscribe` subscription.
2. Call `chat.history` for the selected `sessionKey` and replace local persisted
   rows with the returned `messages` projection.
3. If `inFlightRun` is present, adopt its `runId`, buffered `text`, and optional
   `plan`. Adopt the run even when `text` is empty.
4. Treat `sessionInfo.hasActiveRun` as aggregate direct-session activity.
   `activeRunIds`, when present, is the complete exact active set; an empty array
   therefore proves the session is idle. When `hasActiveRun` is true and
   `activeRunIds` is omitted, another runtime owner is active but its exact run
   identities are unavailable. In incremental merge events, omission means no
   change, `null` is the event-only tombstone that clears cached exact IDs to
   unavailable, and an array replaces the cache (including `[]` for proven
   idle). Correlate only a run ID the client owns locally or received from a
   request, history response, or event, and never select the first list entry as
   an owner.
5. Show an observer headline or run-inspector link only when the observer digest's
   exact `runId` is present in `activeRunIds`. Aggregate activity alone does not
   make a retained digest current.
6. Reconcile subsequent `agent` events by `payload.runId` and `payload.seq`.
   Maintain the highest accepted sequence independently for each run, ignore an
   already-seen or lower sequence, and treat a forward gap as a reason to reload
   authoritative history.

### Active-run cache matrix

Classify the source before applying `activeRunIds`; the same omission has
different meaning in a full snapshot and an incremental delta.

| Client cache             | Read path                                                  | Class    | Required behavior                                                                                  |
| ------------------------ | ---------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| Web session roster       | `sessions.list`, reconnect hydration                       | Snapshot | Replace the row; omission clears cached exact IDs to unavailable.                                  |
| Web selected session     | `chat.history.sessionInfo`                                 | Snapshot | Replace the row projection; omission clears cached exact IDs.                                      |
| Web session events       | `sessions.changed`, `session.message`, lifecycle snapshots | Delta    | Omission is inert; `null` clears; an array replaces.                                               |
| Android session roster   | `sessions.list`, reconnect hydration                       | Snapshot | Replace the list rows; omission clears cached exact IDs.                                           |
| Android selected session | `chat.history.sessionInfo`, reconnect recovery             | Snapshot | Replace `activeRunIds` even while other partial history fields merge.                              |
| Android session events   | `sessions.changed`, `session.message`, lifecycle snapshots | Delta    | Field presence controls replacement; `null` clears and omission is inert.                          |
| Apple session roster     | `sessions.list`, reconnect hydration                       | Snapshot | Replace live rows; the offline cache strips transient active-run facts.                            |
| Apple selected session   | `chat.history.sessionInfo`, reconnect recovery             | Snapshot | Replace both the current row and its run-ID projection; omission clears both.                      |
| Apple session events     | `sessions.changed`, `session.message`, lifecycle snapshots | Delta    | Preserve field presence through decoding; omission is inert, `null` clears, and an array replaces. |

The outer event frame also has an optional `seq`, which orders events on the
current WebSocket connection. It resets with a new connection. The `seq` inside
an `agent` event payload is assigned per run and orders that run's lifecycle,
assistant, plan, tool, and other stream events.

## Render generated image artifacts

Assistant-generated images arrive as canonical `type: "image"` content blocks.
Managed blocks include a stable `artifactId`, a Gateway-relative `url`, MIME
type, dimensions, size, and accessible alt text. Keep that reference in the
transcript cache; do not persist downloaded bytes or temporary download URLs.

Resolve the image through the authenticated WebSocket connection:

1. Call `artifacts.download` with the current `sessionKey`, optional `agentId`,
   and the block's `artifactId`.
2. Use the returned short-lived `url` before `expiresAt`. The URL is scoped to
   that exact transcript-backed artifact and does not contain a reusable Gateway
   or device credential.
3. Fetch it from the Gateway origin using the same TLS pin and reverse-proxy
   headers as the active connection. Validate the response as an image and
   enforce a 12 MiB source limit plus a bounded decoded thumbnail.
4. If the URL expires, repeat `artifacts.download` once. Reconnect or route
   changes cancel the old load rather than retargeting it to another Gateway.

Older image blocks without `artifactId` remain displayable by existing Control
UI clients, but native clients should show a readable attachment fallback rather
than forward a shared owner credential.

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

  A session reset boundary uses `kind: "reset"`. It has no checkpoint token
  metrics.

Page backward with the response's `hasMore` and `nextOffset` values. Numeric
offsets describe the current transcript projection, so do not persist them as
long-lived bookmarks across reset or compaction. Persist `__openclaw.id` instead.
To restore around a known row, call `chat.history` with `messageId` and the
`sessionId` that returned it. The Gateway can resolve that anchor from reset
archive history; anchored responses intentionally omit numeric paging metadata.

## Subscribe instead of polling usage

Install the `sessions.changed` listener, then call `sessions.subscribe` once per
connection with your `sessions.list` parameters, such as
`{ limit: 60, ownerFirst: true }`. The response is `{ subscribed: true, list }`,
where `list` is the normal `SessionsListResult` snapshot. Passing `{}` activates
the subscription but returns only `{ subscribed: true }`, without a list.

The Gateway activates the subscription before reading the snapshot. Events can
therefore arrive before the response. Track changes received during bootstrap
and follow the response with a `sessions.list` refresh when needed; do not let
the snapshot silently overwrite a newer event. Re-establish this flow after
every reconnect.

`ownerFirst: true` prepends up to 60 matching sessions owned by the authenticated
viewer to the normal first page, removing duplicates within that response. It
applies only when `offset` is zero or omitted. The Gateway derives the viewer
identity from the authenticated connection, not a client-supplied identity.
The shared page's pagination metadata is unchanged, so use `nextOffset`, not the
number of returned rows, when loading another page, and merge rows by session
key. See [Session list bootstrap](/gateway/protocol/rpc-methods#session-list-bootstrap).

Merge subsequent `sessions.changed` events by `sessionKey`. Session change
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
