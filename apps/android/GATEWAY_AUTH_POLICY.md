# Fresh-bootstrap authentication policy

Android honors newly supplied bootstrap credentials before stored device tokens.
A durable handoff retires the consumed bootstrap only after both replacement role
tokens are saved. The shared Swift selector remains the precedence reference;
the platform differences listed below are retained.

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

## Android durable handoff

[`GatewaySession.kt`](app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt)
selects fresh bootstrap before a stored device token. The wire regression is
`connect_prefersFreshBootstrapTokenOverStoredDeviceToken` in
[`GatewaySessionInvokeTest.kt`](app/src/test/java/ai/openclaw/app/gateway/GatewaySessionInvokeTest.kt).

[`DeviceAuthStore.kt`](app/src/main/java/ai/openclaw/app/gateway/DeviceAuthStore.kt)
commits each role token and its metadata together and returns the actual durable
write result. The session records the final write result for each role in this
hello; receipt alone and preexisting tokens do not establish fresh handoff.
Both node and operator writes must succeed before bootstrap retirement.

`DeviceAuthStore` admits a write derived from a stored token only while the
slot still holds that token. Freshly issued grants write unconditionally.
A stale hello keeps its socket, but its persistence is refused; mismatch clears
and recovery recommits follow the same stored-token rule. The wire regression is
`bootstrapHandoff_staleStoredOperatorHelloCannotOverwriteFreshOperatorToken`.

[`SecurePrefs.kt`](app/src/main/java/ai/openclaw/app/SecurePrefs.kt) then commits
the existing credential bundle with only the consumed bootstrap removed. Token
and password fields are preserved. A failed commit restores the previous
in-memory values, because Android can publish a failed disk write in memory.
Missing roles or failed writes retain bootstrap in saved credentials and in the
session intent; the current socket can remain connected, but a later rejected
bootstrap requires setup repair.

[`GatewayBootstrapHandoff.kt`](app/src/main/java/ai/openclaw/app/gateway/GatewayBootstrapHandoff.kt)
owns retirement authority for one connection intent. Every new runtime intent
invalidates that authority before socket cleanup. A preference revision also
fences every setup save/reset, including replacement with identical token bytes.
Successful retirement clears the session's reconnect bootstrap and the active
[`NodeRuntime.kt`](app/src/main/java/ai/openclaw/app/NodeRuntime.kt) auth view.
Reconnect and relaunch then select the stored role tokens. Revision and handoff
state are in memory only; encrypted preference keys and serialized formats do
not change.

### Existing-install recovery

An implicitly loaded saved bootstrap is submitted first. After the Gateway
returns `AUTH_BOOTSTRAP_TOKEN_INVALID`, a trusted endpoint may get one recovery
attempt using stored device auth, provided both node and operator token slots
are nonempty for the same Gateway and device. A successful stored-node hello
and durable writes of both role entries permit retirement of the rejected saved
bootstrap. The existing operator connection authenticates its own stored token.
The Gateway does not distinguish spent, expired, and invalid bootstrap tokens,
so this recovery applies to that saved-credential rejection, not an inferred age.

Explicit setup input never receives this recovery permission, even if its bytes
match a saved token. It follows bootstrap auth and surfaces rejection instead of
falling back to old device access. The normal setup owner,
[`MainViewModel.kt`](app/src/main/java/ai/openclaw/app/MainViewModel.kt), drains and
resets old role credentials before saving replacement setup input; this also
preserves the distinction across process death during setup.

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
  while bootstrap is present. The store fence prevents a delayed old operator
  hello from replacing the handoff-issued token. iOS avoids the race by waiting
  for the bootstrap handoff before starting stored-only operator access.

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
