---
summary: "Connect frame, hello-ok payload, client capabilities, roles, and scopes"
read_when:
  - Writing the connect frame for a new client
  - Debugging a rejected or downgraded handshake
  - Choosing the role and scopes a client should request
title: "Gateway protocol handshake"
sidebarTitle: "Handshake and roles"
doc-schema-version: 1
---

The first frame and what comes back: the connect request, the `hello-ok` payload, the worker role, client capabilities, and the role and scope model.

## Handshake

Gateway sends a pre-connect challenge:

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

Device-auth clients use the challenge `ts` as `connect.params.device.signedAt`.
For WebSocket challenges, `ts` must be a non-negative integer. Clients that
explicitly support Gateways from before `connect.challenge` existed may use local
time only when no challenge arrives; a received challenge with an absent or
malformed `ts` is invalid.

Client replies with `connect`:

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 4,
    "maxProtocol": 4,
    "client": {
      "id": "cli",
      "version": "1.2.3",
      "platform": "macos",
      "mode": "operator"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-cli/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

Gateway responds with `hello-ok`:

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 4,
    "server": { "version": "…", "connId": "…" },
    "features": { "methods": ["…"], "events": ["…"] },
    "snapshot": { "…": "…" },
    "auth": {
      "role": "operator",
      "scopes": ["operator.read", "operator.write"]
    },
    "policy": {
      "maxPayload": 26214400,
      "maxBufferedBytes": 52428800,
      "tickIntervalMs": 15000,
      "attachments": { "maxBytes": 20971520, "maxImageBytes": 6291456 }
    }
  }
}
```

`server`, `features`, `snapshot`, `policy`, and `auth` are all required by
`HelloOkSchema` (`packages/gateway-protocol/src/schema/frames.ts`). `auth`
reports the negotiated role and the current socket's effective authorization
scopes even when no device token is issued (shape above). `deviceToken`, when
present, is the primary reusable credential for the same device and role.
`controlUiUrl` optionally advertises the Gateway's configured public Control UI
origin and base path for shareable links, independent of the client's tunnel or
development-server address. It is omitted when `gateway.publicOrigin` is unset
or the Control UI is disabled. It contains no credentials and grants no access.
`policy.attachments` is optional (older gateways omit it) and advertises
the decoded-size ceilings chat attachments face on `chat.send`, `sessions.send`,
and session-creation initial turns:

| Field           | Meaning                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `maxBytes`      | Largest decoded size accepted for a single attachment (`agents.defaults.mediaMaxMb`, default 20 MB) |
| `maxImageBytes` | Largest decoded size accepted for a single image: `min(maxBytes, 6 MB agent-hydration cap)`         |

Validating before send:

1. Check each file's decoded size against `maxImageBytes` for images and
   `maxBytes` for everything else.
2. Serialize the whole request and check its encoded size against
   `policy.maxPayload`. `policy.attachments` is a per-attachment ceiling, never a
   promise the frame fits: attachments travel as base64, so a 20 MB file is about
   26.7 MB on the wire and exceeds the default 25 MiB frame limit on its own.
3. Treat the server as authoritative for everything else. Accepted MIME types and
   per-message handling are deliberately not advertised because they depend on
   the entrypoint, the resolved model, and payload sniffing. The gateway can
   return a typed rejection, while text-only model runs can omit additional
   images after their offload cap and still complete the request.
4. Re-read the values on every reconnect. They are a connection-time snapshot, so
   a live `mediaMaxMb` edit reaches existing connections only after they reconnect.

`pluginSurfaceUrls` is optional and maps plugin surface names (e.g.
`canvas`) to scoped hosted URLs; it may expire, so nodes call
`node.pluginSurface.refresh` with `{ "surface": "canvas" }` for a fresh entry.
The deprecated `canvasHostUrl` / `canvasCapability` / `node.canvas.capability.refresh`
path is not supported; use plugin surfaces.
The `sessions.observer.ask` method was removed; use `sessions.companion.ask`.
The snapshot's optional `appliedConfigHash` is the resolved source-config revision
accepted by the active Gateway runtime. Clients can compare it with
`config.get.configRevisionHash` to determine whether a newer saved config still
needs a restart. `config.get.hash` remains the raw root-file revision used by
config write conflict guards.

The snapshot's optional `controlUiIdentityUrl` advertises the active Gateway's
HTTPS dashboard URL when it uses trusted-proxy or Tailscale Serve identity.
Operator clients can open this URL for personal browser sign-in instead of
forwarding shared device credentials. The URL includes the Control UI base path;
clients must use normal HTTPS trust instead of native TLS pins and must not send
native connection tokens or passwords to it. Re-read it from each authenticated
hello snapshot and discard it when that connection closes. If the managed Serve
route exits or is replaced, the Gateway closes connections that received its
identity URL with code `1012`; reconnect to discover the current route.

`openclaw.setup.verify` additionally checks the Gateway's current application and
restart state before and after its live inference probe. It returns
`{ ok: false, status: "unavailable", error }` while saved settings are not active,
restart work remains, or the verified runtime changes during the probe. Clients
should preserve the selected model and retry after application or restart finishes.
Standalone CLI verification still tests saved configuration without requiring a
running Gateway.

While the gateway is still finishing startup sidecars, `connect` can return a
retryable `UNAVAILABLE` error with `details.reason: "startup-sidecars"` and
`retryAfterMs`. Retry within your connection budget instead of treating it as
a terminal handshake failure.

When a device token is issued, `hello-ok.auth` adds it:

```json validate=false
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read"]
  }
}
```

Built-in QR/setup-code bootstrap is a mobile handoff path. A successful
baseline setup-code connect returns a primary node token plus one bounded
operator token:

```json validate=false
{
  "auth": {
    "deviceToken": "…",
    "role": "node",
    "scopes": [],
    "deviceTokens": [
      {
        "deviceToken": "…",
        "role": "operator",
        "scopes": ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"]
      }
    ]
  }
}
```

This operator handoff is bounded on purpose: enough to start the mobile
operator loop and native setup, with `operator.write` satisfying Talk sessions
and `operator.talk.secrets` covering Talk config reads, but no pairing-mutation scopes
and no `operator.admin`. Broader
pairing/admin access needs a separate approved pairing or token flow. Persist
`hello-ok.auth.deviceTokens` only when bootstrap auth ran over a trusted
transport (`wss://` or loopback/local pairing).

Trusted local backend clients (`client.id: "gateway-client"`,
`client.mode: "backend"`) may omit `device` on direct loopback connections when
authenticating with the shared gateway token/password. This path is reserved
for internal control-plane RPCs (e.g. subagent session updates) and avoids
stale CLI/device pairing baselines blocking local backend work. The exception
also applies when that backend supplies a signed device identity: it does not
create a pairing record, so an unpaired identity receives no device token.
Remote, browser-origin, node, and non-backend clients follow their normal pairing
and scope-upgrade policies. Device-token authentication still validates the
existing token's role and scopes before any local-backend pairing exception.

### Worker role and closed protocol

Workers use a closed protocol through either the public
`/__openclaw__/worker` WebSocket path on the main TLS endpoint or the dedicated
loopback ingress reached through the gateway-owned, host-key-pinned SSH tunnel.
The route selects worker mode before reading frames, so it never dispatches
general auth, node events, operator RPCs, or plugin methods. Public admission
shares the main per-client pre-auth budget and authentication rate limiter; its
wire errors collapse credential and environment details to
`admission-rejected`, while trusted gateway diagnostics retain the internal
reason. A strict `connect` verifies a hash-at-rest, short-lived credential bound
to the environment, bundle hash, owner epoch, RPC-set version, expiry, and one
nullable session; it separately checks the current version and feature set.
Success returns minimal `worker-hello-ok`; feature negotiation is independent of
the general protocol version. Frames stay under 64 KiB, except a negotiated
`worker.inference.start` frame may be up to 25 MiB. The closed allowlist contains
`worker.heartbeat`, `worker.transcript.commit`, `worker.live-event`,
`worker.inference.start`, and `worker.inference.cancel`.

For an identity-audited attached run, the live turn capability can record the
credential, build, owner-epoch, and placement checks as one enforced admission
receipt. The receipt contains none of the credential, build hashes, tokens,
environment id, or session id. Worker operation rows and placement state remain
their authoritative owners; successful connection is not an action-success
receipt.

Transcript commits use owner-epoch fencing, a gateway-owned session binding,
base-leaf compare-and-swap, and durable sequence replay; the gateway generates
transcript entry and parent IDs through the normal session writer. Ownership and
expiry are rechecked on each RPC.

### Client capabilities

Operator clients may advertise optional capabilities in `connect.params.caps`:

- `tool-events`: accepts structured tool lifecycle events.
- `inline-widgets`: can render hosted inline widget tool results.

Client capabilities describe the connected client, not authorization. Agent tools may declare required capabilities; the Gateway omits those tools unless every requirement appears in the originating client's `caps`. Channel-originated runs have no Gateway client capabilities, so capability-gated tools are unavailable even when tool policy explicitly allows them.

### Node connect example

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 4,
    "maxProtocol": 4,
    "client": {
      "id": "ios-node",
      "version": "1.2.3",
      "platform": "ios",
      "mode": "node"
    },
    "role": "node",
    "scopes": [],
    "caps": ["camera", "canvas", "screen", "location", "voice"],
    "commands": ["camera.snap", "canvas.navigate", "screen.record", "location.get"],
    "permissions": { "camera.capture": true, "screen.record": false },
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-ios/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

Nodes declare capability claims at connect time:

- `caps`: high-level categories such as `camera`, `canvas`, `screen`,
  `location`, `voice`, `talk`.
- `commands`: command allowlist for invoke.
- `permissions`: granular toggles (e.g. `screen.record`, `camera.capture`).

The gateway treats these as claims and enforces server-side allowlists.

## Roles and scopes

For the full operator scope model, approval-time checks, and shared-secret
semantics, see [Operator scopes](/gateway/operator-scopes).

Roles:

- `operator`: control-plane client (CLI/UI/automation).
- `node`: capability host (camera/screen/canvas/system.run).
- `worker`: cloud execution host on the dedicated, closed worker protocol.

Operator scopes (`src/gateway/operator-scopes.ts`), the full closed set:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.questions`
- `operator.pairing`
- `operator.talk`
- `operator.talk.secrets`

`operator.write` continues to satisfy `operator.talk` for compatibility with
existing clients. Voice-device setup can issue the narrower Talk grant without
general Gateway write access.

`talk.config` with `includeSecrets: true` requires `operator.talk.secrets` (or
`operator.admin`). When secrets are included, read the active Talk provider
credential from `talk.resolved.config.apiKey`; `talk.providers.<id>.apiKey`
stays source-shaped and may be a SecretRef object or a redacted string.

Plugin-registered gateway RPC methods may request their own operator scope,
but these reserved core prefixes always resolve to `operator.admin`
(`src/shared/gateway-method-policy.ts`): `config.*`, `exec.approvals.*`,
`wizard.*`, `update.*`.

Method scope is only the first gate. Some slash commands reached through
`chat.send` apply stricter command-level checks: persistent `/config set` and
`/config unset` writes require `operator.admin` even for gateway clients that
already hold a lower operator scope.

`node.pair.approve` has an extra approval-time scope check on top of the base
method scope (`operator.pairing`), based on the pending request's declared
`commands` (`src/infra/node-pairing-authz.ts`):

| Declared commands                                                                                                                                        | Required scopes                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| none                                                                                                                                                     | `operator.pairing`                    |
| ordinary commands                                                                                                                                        | `operator.pairing` + `operator.write` |
| includes `system.run`, `system.run.prepare`, `system.which`, `browser.proxy`, `browser.proxy.upload.v1`, `fs.listDir`, or `system.execApprovals.get/set` | `operator.pairing` + `operator.admin` |

In this table, `fs.listDir` is the node command relayed through `node.invoke`.
The top-level Gateway `fs.listDir` RPC needs `operator.write` for
workspace-contained host browsing and `operator.admin` when `nodeId` is present.
Pass directory paths exactly as returned by `fs.listDir`: whitespace in directory
names, including trailing spaces, is significant.

### Caps/commands/permissions (node)

Nodes declare capability claims at connect time:

- `caps`: high-level capability categories such as `camera`, `canvas`, `screen`,
  `location`, `voice`, and `talk`.
- `commands`: command allowlist for invoke.
- `permissions`: granular toggles (e.g. `screen.record`, `camera.capture`).

The Gateway treats these as **claims** and enforces server-side allowlists.
Connected nodes can publish optional agent-visible plugin or MCP tool
descriptors with `node.pluginTools.update` after a successful connect or
reconnect. Headless node hosts restart to apply declarative MCP inventory
changes. This update method is the only publication path; plugin tool descriptors are not accepted in
`connect` params. Each descriptor must use a provider-safe tool `name` and name
a `command` in the node's current command allowlist. The Gateway trusts descriptor
metadata from the paired node, filters descriptors outside the approved command
surface, removes them when the node disconnects, and rejects operator attempts
to mutate another node's catalog. Set `gateway.nodes.pluginTools.enabled: false`
to ignore node-published descriptors.

Connected node hosts publish their complete skill replacement catalog with
`node.skills.update`. This node-role method is the only node skill publication
path; skills are not accepted in `connect` params. Each descriptor contains a
safe name, description, and bounded `SKILL.md` content. The Gateway parses that
content with the normal skills loader, includes it in agent skill snapshots
while the node is connected, and removes it on disconnect. Set
`gateway.nodes.allowSkills: false` to ignore node-published skills.
