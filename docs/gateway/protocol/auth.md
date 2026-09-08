---
summary: "Handshake auth paths, device identity, pairing signatures, and TLS pinning"
read_when:
  - Choosing an auth path for a gateway client
  - Implementing device identity or signed pairing
  - Pinning a gateway TLS certificate
title: "Gateway protocol auth"
sidebarTitle: "Auth and device identity"
doc-schema-version: 1
---

How a client proves who it is: the handshake auth paths, device identity and pairing signatures, and TLS pinning.

## Auth

- Shared-secret gateway auth accepts the configured secret in either
  `connect.params.auth.token` or `connect.params.auth.password`.
  `gateway.auth.mode: "token"` selects `gateway.auth.token`; `"password"`
  selects `gateway.auth.password`. The mode selects the configured secret,
  not the required wire field.
- Identity-bearing modes such as Tailscale Serve (`gateway.auth.allowTailscale: true`)
  or non-loopback `gateway.auth.mode: "trusted-proxy"` satisfy the connect
  auth check from request headers instead of `connect.params.auth.*`.
- Private-ingress `gateway.auth.mode: "none"` skips shared-secret connect auth
  entirely; do not expose that mode on public/untrusted ingress.
- After pairing, the gateway issues a device token scoped to the connection
  role + approved grant, returned in `hello-ok.auth.deviceToken`. Clients should
  persist it with `hello-ok.auth.scopes` after a successful connect when the token
  is new or different from the stored token.
- `hello-ok.auth.scopes` is the current socket's live authority and matches the
  scopes enforced by RPC dispatch.
- When `hello-ok.auth.deviceToken` exactly matches the token already stored for
  the same gateway, device, client, and role, preserve that record's stored scopes
  instead of replacing them with a narrower live scope set. A newly issued or
  rotated token uses `hello-ok.auth.scopes`; its approved grant matches that
  connection when it is issued.
- Reconnecting with that stored device token should also reuse the stored
  approved scope set for that token. This preserves read/probe/status access
  already granted and avoids silently collapsing reconnects to a narrower
  implicit admin-only scope.
- Client-side connect auth assembly (`selectConnectAuth` in
  `packages/gateway-client/src/client.ts`):
  - `auth.password` is always forwarded when set. Either shared-secret field
    can carry the configured secret; when both are supplied, the Gateway
    uses the field matching its auth mode.
  - `auth.token` is populated in priority order: explicit shared token first,
    then an explicit `deviceToken`, then a stored per-device token (keyed by
    `deviceId` + `role`).
  - `auth.bootstrapToken` is sent only when none of the above resolved
    `auth.token`. A shared token or any resolved device token suppresses it.
  - Auto-promotion of a stored device token on the one-shot
    `AUTH_TOKEN_MISMATCH` retry is gated to trusted endpoints only: loopback,
    or `wss://` with a pinned `tlsFingerprint`. Public `wss://` without pinning
    does not qualify.
- Built-in setup-code bootstrap returns the primary node
  `hello-ok.auth.deviceToken` plus a bounded operator token in
  `hello-ok.auth.deviceTokens` for trusted mobile handoff. The operator token
  includes `operator.talk.secrets` for native Talk configuration reads, but
  excludes pairing-mutation scopes and `operator.admin`.
- `hello-ok.auth.deviceTokens` contains only additional bootstrap-handoff tokens.
  Do not use it as metadata for the primary `deviceToken` reconnect record.
- While a non-baseline setup-code bootstrap waits for approval,
  `PAIRING_REQUIRED` details include `recommendedNextStep: "wait_then_retry"`,
  `retryable: true`, and `pauseReconnect: false`. Keep reconnecting with the
  same bootstrap token until the request is approved or the token becomes
  invalid.
- Persist `hello-ok.auth.deviceTokens` only when the connect used bootstrap
  auth on a trusted transport such as `wss://` or loopback/local pairing.
- If a client supplies an explicit `deviceToken` or explicit `scopes`, that
  caller-requested scope set remains authoritative for the live connection and
  is reported in `hello-ok.auth.scopes`; cached token-grant scopes are only reused
  when the client is reusing the stored per-device token.
- Device tokens can be rotated/revoked via `device.token.rotate` and
  `device.token.revoke` (requires `operator.pairing`). Rotating or revoking a
  node or other non-operator role also requires `operator.admin`.
- `device.token.rotate` returns rotation metadata. It echoes the replacement
  bearer token only for same-device calls already authenticated with that
  device token, so token-only clients can persist their replacement before
  reconnecting. Shared/admin rotations do not echo the bearer token.
- Token issuance, rotation, and revocation stay bounded to the approved role
  set recorded in that device's pairing entry; token mutation cannot expand or
  target a device role that pairing approval never granted.
- For paired-device token sessions, device management is self-scoped unless
  the caller also has `operator.admin`: non-admin callers can manage only the
  operator token for their own device entry. Node and other non-operator token
  management is admin-only, even for the caller's own device.
- `device.token.rotate` and `device.token.revoke` also check the target
  operator token scope set against the caller's current session scopes.
  Non-admin callers cannot rotate or revoke a broader operator token than they
  already hold.
- Auth failures include `error.details.code` plus recovery hints:
  - `error.details.canRetryWithDeviceToken` (boolean)
  - `error.details.recommendedNextStep`: one of `retry_with_device_token`,
    `update_auth_configuration`, `update_auth_credentials`,
    `wait_then_retry`, `review_auth_configuration`
    (`packages/gateway-protocol/src/connect-error-details.ts`).
- Client behavior for `AUTH_TOKEN_MISMATCH`:
  - Trusted clients may attempt one bounded retry with a cached per-device
    token.
  - If that retry fails, stop automatic reconnect loops and surface operator
    action guidance.
- `AUTH_SCOPE_MISMATCH` means the device token was recognized but does not
  cover the requested role/scopes. Do not present this as a bad token; prompt
  the operator to re-pair or approve the narrower/broader scope contract.

## Device identity and pairing

- Nodes should include a stable device identity (`device.id`) derived from a
  keypair fingerprint.
- Gateways issue tokens per device + role.
- Pairing approvals are required for new device IDs unless local
  auto-approval is enabled.
- Pairing auto-approval is centered on direct local loopback connects.
- OpenClaw also has a narrow backend/container-local self-connect path for
  trusted shared-secret helper flows.
- Same-host tailnet or LAN connects are still treated as remote for pairing
  and require approval.
- WS clients normally include `device` identity during `connect` (operator +
  node). The only device-less operator exceptions are explicit trust paths:
  - successful `gateway.auth.mode: "trusted-proxy"` operator Control UI auth.
  - direct-loopback `gateway-client` backend RPCs on the reserved internal
    helper path.
- Omitting device identity has scope consequences. When a device-less
  operator connection is allowed through an explicit trust path, OpenClaw
  still clears self-declared scopes to an empty set unless that path has a
  named scope-preservation exception. Scope-gated methods then fail with
  `missing scope`.
- The reserved direct-loopback `gateway-client` backend helper path preserves
  scopes only for internal local control-plane RPCs; custom backend IDs do
  not receive this exception.
- All connections must sign the server-provided `connect.challenge` nonce.

### Device auth migration diagnostics

For legacy clients that still use pre-challenge signing behavior, `connect`
returns `DEVICE_AUTH_*` detail codes under `error.details.code` with a stable
`error.details.reason`.

Common migration failures:

| Message                     | details.code                     | details.reason           | Meaning                                            |
| --------------------------- | -------------------------------- | ------------------------ | -------------------------------------------------- |
| `device nonce required`     | `DEVICE_AUTH_NONCE_REQUIRED`     | `device-nonce-missing`   | Client omitted `device.nonce` (or sent blank).     |
| `device nonce mismatch`     | `DEVICE_AUTH_NONCE_MISMATCH`     | `device-nonce-mismatch`  | Client signed with a stale/wrong nonce.            |
| `device signature invalid`  | `DEVICE_AUTH_SIGNATURE_INVALID`  | `device-signature`       | Signature payload does not match v2 payload.       |
| `device signature expired`  | `DEVICE_AUTH_SIGNATURE_EXPIRED`  | `device-signature-stale` | Signed timestamp is outside allowed skew.          |
| `device identity mismatch`  | `DEVICE_AUTH_DEVICE_ID_MISMATCH` | `device-id-mismatch`     | `device.id` does not match public key fingerprint. |
| `device public key invalid` | `DEVICE_AUTH_PUBLIC_KEY_INVALID` | `device-public-key`      | Public key format/canonicalization failed.         |

Migration target:

- Always wait for `connect.challenge`.
- Use `connect.challenge.payload.ts` as `connect.params.device.signedAt`.
- Sign the v2 payload that includes the server nonce.
- Send the same nonce in `connect.params.device.nonce`.
- Preferred signature payload is `v3`
  (`buildDeviceAuthPayloadV3` in `packages/gateway-client/src/device-auth.ts`),
  which binds `platform` and `deviceFamily` in addition to
  device/client/role/scopes/token/nonce fields.
- Legacy `v2` signatures remain accepted for compatibility, but paired-device
  metadata pinning still controls command policy on reconnect.

## TLS and pinning

- TLS is supported for WS connections (`gateway.tls` config).
- Clients may optionally pin the gateway cert fingerprint via
  `gateway.remote.tlsFingerprint` or CLI `--tls-fingerprint`.
