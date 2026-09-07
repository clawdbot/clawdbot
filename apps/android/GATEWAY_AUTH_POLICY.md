# Fresh-bootstrap authentication policy

Draft implementation reference for adopting the shared Swift policy on Android.
The precedence change requires a durable bootstrap handoff before it can ship.
This document describes the existing implementations and the remaining decision;
it does not claim Android already implements the Swift policy.

## Swift decision table

The canonical selector is `selectConnectAuth` in
[`GatewayChannel.swift`](../shared/OpenClawKit/Sources/OpenClawKit/GatewayChannel.swift).
Explicit credentials are trimmed; empty values count as absent. Evaluate these
rows in order:

| Credentials available | Authentication sent |
| --- | --- |
| Explicit Gateway token | `auth.token` with the explicit token |
| No Gateway token; explicit password | `auth.password` |
| Neither above; bootstrap token | `auth.bootstrapToken`, even when a stored device token exists |
| No explicit credential; eligible stored device token | `auth.token` with the stored device token |
| None of the above | No `auth` field |

Stored lookup requires device identity, permission to use stored device auth,
and a matching device, role, Gateway owner, and identity profile. Suppressing
lookup or reuse does not delete the old token. Signature binding uses the
selected token or bootstrap token; password auth has no signature token.

The retry overlay applies only to explicit Gateway-token authentication. After
one eligible rejection, a trusted endpoint may receive both `auth.token` and
`auth.deviceToken`. When stored scope metadata is nonempty, Swift requires that
grant to cover the requested scopes before attaching the retry token. Empty
scope metadata does not suppress an otherwise eligible retry. It schedules at most one retry for
`canRetryWithDeviceToken` or `AUTH_TOKEN_MISMATCH`; a retry rejected with
`AUTH_DEVICE_TOKEN_MISMATCH` clears only the matching stored role token. Success
resets the retry budget.

### Freshness, expiry, and pairing

“Fresh” in the selector means a supplied nonempty bootstrap token. The selector
does not compare timestamps or infer pairing completion from a stored token.
Neither platform's device-token entry has an expiry field: `updatedAtMs` records
a write time, and neither loader treats age as expiration. The Gateway owns
bootstrap validity and consumption. The iOS manual-connect owner also rejects a
setup override whose `expiresAtMs` is at or before the current time.

| State | Swift behavior |
| --- | --- |
| Fresh setup token, with or without an old device token | Submit bootstrap auth unless explicit Gateway token or password wins |
| Bootstrap rejected as invalid or pairing required | Surface the rejection; the channel pauses automatic reconnect rather than silently using the old token |
| Successful bootstrap hello | Record received roles separately from successfully persisted roles |
| Node and operator replacement tokens durably persisted | iOS completes the handoff, removes bootstrap from saved credentials and active reconnect configuration, and enables stored auth |
| Subsequent reconnect or relaunch after that handoff | Use the stored role token when no explicit Gateway token or password exists |
| Explicit Gateway token rotated while a stored token remains | Try explicit auth first; only the bounded trusted retry can attach the stored token |

Bootstrap handoff persistence permits WSS and local-network WS. It accepts node
tokens with empty scopes and operator tokens filtered to `operator.admin`,
`operator.approvals`, `operator.questions`, `operator.read`,
`operator.talk.secrets`, and `operator.write`. A missing issued role or failed
durable write must not be mistaken for completed handoff.

The lifecycle owners are `completeSuccessfulGatewayAuthHandoff` in
[`NodeAppModel.swift`](../ios/Sources/Model/NodeAppModel.swift) and
`completeGatewayCredentialHandoff` in
[`GatewaySettingsStore.swift`](../ios/Sources/Gateway/GatewaySettingsStore.swift).

## Android handoff decision

Android's [`GatewaySession.kt`](app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt)
currently reuses a stored device token even when a bootstrap token is supplied.
The existing `connect_prefersStoredDeviceTokenOverBootstrapToken` test in
[`GatewaySessionInvokeTest.kt`](app/src/test/java/ai/openclaw/app/gateway/GatewaySessionInvokeTest.kt)
explicitly protects that behavior.

That precedence also compensates for a lifecycle difference:
[`MainViewModel.kt`](app/src/main/java/ai/openclaw/app/MainViewModel.kt) saves the
bootstrap credential, [`NodeRuntime.kt`](app/src/main/java/ai/openclaw/app/NodeRuntime.kt)
reloads it for later connection intents, and the session retains it in
`DesiredConnection`. Successful hello handling saves issued device tokens but
does not retire bootstrap auth. Replacing the selector condition alone would
therefore make later connections submit the spent bootstrap token.

The proposed repair needs an explicit decision to change persisted credential
handoff and recovery: retire only the consumed bootstrap credential after both
replacement role tokens are durably stored, update the current connection
intent, and fence completion against a newer setup/reset intent. Android's
[`DeviceAuthStore.kt`](app/src/main/java/ai/openclaw/app/gateway/DeviceAuthStore.kt)
currently exposes `saveToken` without a durable-success result. A successful
hello or a preexisting token is insufficient proof of that handoff.

Existing installations can already contain a spent bootstrap alongside usable
device tokens. The repair must define their upgrade behavior without treating
an unrelated old device token as evidence that a freshly supplied setup token
has been consumed. The fresh-bootstrap preference is decided; this durable
handoff and upgrade behavior remains the implementation decision.

## Other differences retained

These are separate from fresh-bootstrap stored-token precedence. Unifying them
would change other Android authentication paths, outside this fix's scope:

- Android's session chooses bootstrap over password when both are supplied;
  Swift chooses password. Android's operator-auth helper already prefers the
  explicit password.
- Android substitutes stored scopes whenever it selects device-token auth.
  Swift preserves explicitly requested scopes and suppresses stored-token retry
  for scope upgrades beyond a nonempty stored grant.
- Android's retry trust includes local cleartext hosts and existing TLS pins,
  and accepts the legacy `retry_with_device_token` advice. Swift uses strict
  loopback or a trusted WSS session, plus the boolean hint or mismatch code.
- Android keeps retrying a bootstrap node request with no scopes when the
  Gateway reports `not-paired` and explicitly advises waiting. Swift's channel
  classifies pairing-required as nonrecoverable.
- Android may start an operator session using an old stored operator token
  while bootstrap is present. iOS waits for the bootstrap handoff before
  starting stored-only operator access.

## Required implementation proof

Extend the existing wire-level auth tests without adding a selector-only test
seam. Demonstrate fresh bootstrap winning over an old device token, continued
bootstrap use while pairing is pending, durable role-token handoff, reconnect
and process relaunch, and unchanged explicit-token/password/retry behavior.
The regression must fail on the old implementation for the credential actually
sent. Include interruption and failed-persistence cases before marking handoff
complete.

Run the Android gateway unit tests and `pnpm android:i18n:check`. Then use a
Blacksmith Testbox with an Android emulator and an isolated Gateway state
directory and free port. Record an explicit `adb -s <serial>` sequence covering
fresh install, pairing, kill/relaunch, and Gateway-token rotation. Unit tests or
source inspection alone do not satisfy that live proof.
