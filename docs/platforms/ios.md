---
summary: "iOS node app: connect to the Gateway, pairing, device capabilities, and troubleshooting"
read_when:
  - Pairing or reconnecting the iOS node
  - Using voice input and spoken replies on Apple Watch
  - Enabling or troubleshooting the direct Apple Watch node
  - Running the iOS app from source
  - Debugging gateway discovery or iOS node commands
  - Choosing colors for native chat sessions
title: "iOS app"
---

Availability: iPhone app builds are distributed through Apple channels when enabled for a release. Local development builds can also run from source.

## What it does

- Connects to a Gateway over WebSocket (LAN or tailnet).
- Exposes node capabilities: Screen snapshot, Camera capture, Location, Talk mode, Voice wake, and opt-in Health summaries.
- Receives `node.invoke` commands and reports node status events.
- Browses the selected agent's workspace read-only from the Agents surface (Files): directory drill-down, syntax-highlighted text previews, image previews, and share-sheet export. No write operations; previews are size-capped by the gateway.
- Keeps a small read-only offline cache of recent chat sessions and transcripts per paired gateway: cold opens paint the last known transcript immediately and refresh once the gateway responds, recent chats stay browsable while disconnected, and reset/forget purges the protected local cache.
- Queues text messages sent while disconnected in a durable per-gateway outbox (up to 50): queued bubbles show in the transcript, flush in order on reconnect with idempotent retries, remain durable until canonical history confirms the send, retry with backoff before surfacing a retry/delete action, and expire instead of sending after 48 hours offline; reset/forget clears the queue with the cache.
- Chat is the single text-and-voice surface. Chat actions can open the full Sessions screen without leaving Chat and can show or hide assistant reasoning and tool activity. Tap the microphone for draft dictation, open its menu to record a voice note, or use the inline Talk control for realtime voice; the Talk control animates from live microphone or playback level while listening or speaking.
- Chat accepts images from the photo picker, camera, Files, paste, and the iOS share sheet. Assistant-generated images render inline from short-lived Gateway artifact URLs, open in a full-screen preview, and remain available after reconnect or history reload without storing image bytes in the transcript cache.
- Renders completed Mermaid code fences as inline diagrams, with source/copy controls and a full-screen zoomable preview. Diagram rendering uses bundled assets and works offline.
- **Settings -> OpenClaw** opens a dedicated Gateway settings assistant when the operator connection has `operator.admin` and the Gateway supports `openclaw.chat`. Its setup conversation stays separate from ordinary Chat, redacts secret replies locally, and moves to Chat only after you tap **Open Chat**.
- Speaks assistant messages on demand: long-press a message in Chat and choose **Listen**. The app plays supported gateway `tts.speak` clips with the configured TTS provider and falls back to on-device speech when gateway audio is unavailable or unplayable. Playback stops on session switch or backgrounding.

## Session colors

Long-press a session in the sidebar or Sessions screen to open its session actions, then choose **Color**. Select red, blue, green, yellow, purple, orange, pink, or cyan. **Default** clears the color.

A colored session has a narrow leading stripe in session lists and a small dot beside its title in Chat. Unset colors show neither marker. The Gateway stores color names, not hex values; the app adjusts their hues for light and dark appearances.

## Diagrams in chat

Use a fenced `mermaid` block to display a diagram. A diagram renders when its
closing fence arrives or the response finishes; an incomplete streaming fence
stays readable as code. Ordinary code fences keep their usual presentation.

Tap the diagram to open a full-screen preview with pinch-to-zoom. The corner menu
lets you switch between the diagram and its source, and the copy button copies
the complete source. If rendering fails, the source remains available; temporary
failures offer **Retry diagram**.

Local source builds generate the bundled renderer during `pnpm ios:gen`. Run
`pnpm install` from the repository root before generating the Xcode project so
the pinned renderer dependencies are available.

## Requirements

- Gateway running on another device (macOS, Linux, or Windows via WSL2).
- Network path:
  - Same LAN via Bonjour, **or**
  - Tailnet via unicast DNS-SD (example domain: `openclaw.internal.`), **or**
  - Manual host/port (fallback).

## Quick start (pair + connect)

On first launch the app walks through a short pairing explainer, then Gateway
setup. It does not present an aggregate permissions page. Optional access is
requested when you use the related feature, or after you tap **Continue** for
that permission under **Settings** -> **Permissions** -> **Privacy & Access**.
**Continue** immediately presents the native iOS authorization prompt. You can
change granted access later in the iOS Settings app.

1. Start an authenticated Gateway with a route your phone can reach. Tailscale
   Serve is the recommended remote path:

```bash
openclaw gateway --port 18789 --tailscale serve
```

For a trusted same-LAN setup, use an authenticated `gateway.bind: "lan"`
instead. The default loopback bind is not reachable from a phone. If the
Gateway has not been configured yet, run `openclaw onboard` first so setup-code
creation has a token or password auth path.

2. Open the [Control UI](/web/control-ui), select **Nodes**, and click
   **Pair device** on the **Devices** page. Full access is recommended
   and selected by default; choose Limited access only when you want to omit
   administrative Gateway controls, then click **Create setup code**.

3. In the iOS app, open **Settings** -> **Gateway**, scan the QR code (or paste
   the setup code), and connect.

   Paired gateways remain in the **Gateways** list. The checkmark identifies
   the focused gateway; use the bolt control on another row to keep its
   operator session connected at the same time. Switching focus does not
   disconnect other enabled gateways. Only the focused gateway receives the
   iPhone's capability-bearing node session, so camera, screen, location, and
   other device commands always have one unambiguous owner. iOS may suspend
   these foreground connections after the app enters the background.

4. The official app connects automatically. If **Pending approval** shows a
   request, review its role and scopes before approving it.

   **Settings → Gateway** shows whether the saved operator connection has
   **Full** or **Limited** access. Plaintext LAN `ws://` setup is automatically
   limited for bearer-token safety. If it is limited, configure `wss://` or
   Tailscale Serve, scan a new full-access code from Control UI or `openclaw qr`,
   then reconnect to enable settings and upgrades.

The Control UI button requires an already paired session with `operator.admin`.
As a terminal fallback, pick a discovered gateway in the iOS app (or enable
Manual Host and enter host/port), then approve the request on the Gateway host:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

If the app retries pairing with changed auth details (role/scopes/public key), the previous pending request is superseded and a new `requestId` is created. Run `openclaw devices list` again before approval.

Optional: if the iOS node always connects from a tightly controlled subnet, you can opt in to first-time node auto-approval with explicit CIDRs or exact IPs:

```json5
{
  gateway: {
    nodes: {
      pairing: {
        autoApproveCidrs: ["192.168.1.0/24"],
      },
    },
  },
}
```

This is disabled by default. It applies only to fresh `role: node` pairing with no requested scopes. Operator/browser pairing and any role, scope, metadata, or public-key change still require manual approval.

5. Verify connection:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## Health summaries

The iOS node can return an opt-in, read-only HealthKit aggregate for the current
calendar day. iOS device consent and explicit Gateway command authorization are
independent gates. See [HealthKit summaries](/platforms/ios-healthkit) for
setup, invocation, payload fields, privacy behavior, and troubleshooting.

## Apple Watch voice and chat

The Watch companion supports one voice turn at a time: watchOS dictation
produces text, the paired iPhone sends that text to Gateway chat, and the Watch
reads the matching reply aloud with the system voice. It does not stream
microphone audio, run a realtime Talk session, or run an agent on the Watch.
The Watch Talk controls operate Talk on the paired iPhone.

Pair the Watch with the iPhone in Apple's Watch app, install OpenClaw from
**Watch app -> My Watch -> Available Apps**, then open OpenClaw once on both
devices. The companion uses the iPhone relay and does not need separate
Gateway pairing.

1. Connect the iPhone to your Gateway and select the chat you want to use.
2. On the Watch, open **Talk to Claw**, then tap the voice button beside
   **Message OpenClaw**.
3. Use the native input sheet to dictate and submit your message. Keep Chat
   open on the Watch to hear the reply. The message pill also opens native
   input, but does not request a spoken reply.

The iPhone must remain available to relay messages. If its Gateway connection
is asleep, Watch messages use the same bounded background reconnect as Watch
quick replies, respecting the iPhone's auto-connect setting. A queued message
is not confirmation that the Gateway has processed it; open OpenClaw on the
iPhone if delivery stalls.

Only the reply belonging to the submitted turn is read aloud. Switching the
Gateway or chat on iPhone retires the pending spoken reply and clears the old
Watch preview. Leaving Watch Chat or backgrounding the app stops playback;
a reply received while away can be read on return if its wait has not expired.

The spoken-reply wait expires after 90 seconds and shows **Spoken reply timed
out. Check Chat on iPhone.**, including after reopening the Watch app. Cancelling
that wait or stopping speech does **not** cancel the Gateway chat run or remove a queued message.
If no reply is spoken, refresh Chat or check the conversation on iPhone before
resending. Long runs and interrupted return delivery can still require this
manual readback. Keep the Gateway updated for reliable reply attribution when
messages are collected into a later run.

On multi-agent Gateways, use an agent-qualified session. The Watch relays the
session key but not the iPhone's separate agent selection, so a shared `main`
or `global` session can resolve to another owner or be rejected. Use iPhone
Chat for those shared-session cases.

[Direct Watch node mode](/platforms/ios#optional-direct-apple-watch-node) does not remove the
iPhone requirement for chat or voice. It only exposes the device and
notification commands listed below. For continuous voice on a supported
client, see [Talk mode](/nodes/talk).

## Review command approvals

An operator connection with `operator.admin`, or a paired
`operator.approvals` connection explicitly targeted by the Gateway, can review
pending exec requests on iPhone. The approval card shows the Gateway's
sanitized command preview, warning, host context, expiry, and only the
decisions offered by that request. The paired Apple Watch receives the same
reviewer-safe prompt through the existing iPhone relay and offers the compact
allow-once/deny decision subset. Direct Watch Gateway mode does not carry
approval prompts.

Approval state is shared with the Control UI and supported chat surfaces. The
first committed answer wins. iPhone and Watch fetch the Gateway's canonical
terminal record after another surface resolves the request, after a remote
resolved notification, and whenever a resolve acknowledgement may have been
lost. Actions stay unavailable until that readback confirms whether the
request remains pending.

Approval ownership is bound to the selected Gateway. Switching gateways cannot
apply an old prompt to the replacement connection. Gateways that predate the
unified approval methods fall back to the shipped exec-specific methods;
retained terminal state and richer cross-surface results require an updated
Gateway.

## Answer agent questions

Chat shows pending Gateway questions as native cards for operator connections
with `operator.questions` (or `operator.admin`). Cards support single- and
multi-select options, option descriptions, free-text **Other** answers, and an
expiry countdown. Reconnects reload pending questions from the Gateway. A card
locks when this device answers it, another surface answers it first, or the
question expires or is cancelled.

## Optional direct Apple Watch node

Direct mode gives the watch its own signed node identity and Gateway connection.
Supported node commands continue to work over watch Wi-Fi or cellular while
OpenClaw is active, even when the paired iPhone is unavailable.

Requirements:

- The iPhone is connected to the Gateway with `operator.admin` scope.
- The setup code advertises a `wss://` Gateway endpoint with a certificate trusted
  by watchOS; the watch polls the corresponding `https://` origin. Plain HTTP and
  self-signed or fingerprint-only trust are unsupported. See [Gateway-owned
  pairing](/gateway/pairing) for endpoint configuration. Loopback, iPhone-only,
  and tailnet-only routes are not independently reachable by the watch.
- Cellular use requires a cellular-capable Apple Watch with active service.
- OpenClaw is active on the watch. Apple does not allow ordinary watchOS apps to
  keep generic WebSocket/TCP connections, so the direct node uses short HTTPS
  polls and reconnects when the app returns to the foreground. See Apple's
  [watchOS low-level networking guidance](https://developer.apple.com/documentation/technotes/tn3135-low-level-networking-on-watchOS).

Setup:

1. On iPhone, open **Settings -> Apple Watch**.
2. Tap **Enable Direct Gateway Connection**.
3. Open OpenClaw on the watch before the short-lived setup code expires.
4. Verify the separate Apple Watch row with `openclaw nodes status`.

The setup code contains a short-lived, node-only bootstrap credential; treat it
like a password until it expires. It never contains the iPhone's saved Gateway
password or token. After pairing, the watch stores its own device token and
deletes the bootstrap credential. Direct mode covers only the commands below.
Chat, Talk, approvals, and the existing `watch.*` notification flow remain
iPhone-relay features and still require the paired iPhone.

A `watch.notify` receipt reports Watch transport delivery or queuing, not
completion of the best-effort iPhone notification mirror. Cancellation is
checked before starting a new Watch transfer or phone mirror; it cannot recall
work already handed to WatchConnectivity. Once the phone mirror is handed off,
it proceeds independently of the invoke.

Direct watchOS node commands:

| Surface       | Commands                       | Notes                                                   |
| ------------- | ------------------------------ | ------------------------------------------------------- |
| Device        | `device.info`, `device.status` | Watch identity, battery, thermal, storage, and network. |
| Notifications | `system.notify`                | While the app is active; requires watch permission.     |

## Relay-backed push for official builds

Official distributed iOS builds use an external push relay instead of publishing the raw APNs token to the gateway. Official App Store builds from the public release lane use the hosted relay at `https://ios-push-relay.openclaw.ai`; this base URL is hardcoded for App Store distribution and does not read any override.

Custom relay deployments require a deliberately separate iOS build/deployment path whose relay URL matches the gateway relay URL. The App Store release lane never accepts a custom relay URL. If you're using a custom relay build, set the matching gateway relay URL:

```json5
{
  gateway: {
    push: {
      apns: {
        relay: {
          baseUrl: "https://relay.example.com",
        },
      },
    },
  },
}
```

How the flow works:

- The iOS app registers with the relay using App Attest and a StoreKit app transaction JWS.
- The relay returns an opaque relay handle plus a registration-scoped send grant.
- The iOS app fetches the paired gateway identity (`gateway.identity.get`) and includes it in relay registration, so the relay-backed registration is delegated to that specific gateway.
- The app forwards that relay-backed registration to the paired gateway with `push.apns.register`.
- The gateway uses that stored relay handle for `push.test`, background wakes, and wake nudges.
- If the app later connects to a different gateway or a build with a different relay base URL, it refreshes the relay registration instead of reusing the old binding.

What the gateway does **not** need for this path: no deployment-wide relay token, no direct APNs key for official App Store relay-backed sends.

Expected operator flow:

1. Install the official iOS app.
2. Optional: set `gateway.push.apns.relay.baseUrl` on the gateway only when using a deliberately separate custom relay build.
3. Pair the app to the gateway and let it finish connecting.
4. The app publishes `push.apns.register` once it has an APNs token, the operator session is connected, and relay registration succeeds.
5. After that, `push.test`, reconnect wakes, and wake nudges can use the stored relay-backed registration.

## Background alive beacons

When iOS wakes the app for a silent push, background refresh, or significant-location event, the app attempts a short node reconnect and then calls `node.event` with `event: "node.presence.alive"`. The gateway records this as `lastSeenAtMs`/`lastSeenReason` on the paired node/device metadata only after the authenticated node device identity is known.

The app treats a background wake as successfully recorded only when the gateway response includes `handled: true`. Older gateways may acknowledge `node.event` with `{ "ok": true }`; that response is compatible but does not count as a durable last-seen update.

Compatibility note:

- `OPENCLAW_APNS_RELAY_BASE_URL` still works as a temporary env override for the gateway (`gateway.push.apns.relay.baseUrl` is the config-first path).
- The App Store release build's push mode hardcodes the hosted relay host and never reads a relay-URL override — the `OPENCLAW_PUSH_RELAY_BASE_URL` build-time env var only affects local/sandbox iOS build modes.

## Authentication and trust flow

The relay exists to enforce two constraints direct APNs-on-gateway cannot provide for official iOS builds:

- Only genuine OpenClaw iOS builds distributed through Apple can use the hosted relay.
- A gateway can send relay-backed pushes only for iOS devices that paired with that specific gateway.

Hop by hop:

1. `iOS app -> gateway`: the app pairs with the gateway through the normal Gateway auth flow, giving it an authenticated node session plus an authenticated operator session. The operator session calls `gateway.identity.get`.
2. `iOS app -> relay`: the app calls the relay registration endpoints over HTTPS with App Attest proof plus a StoreKit app transaction JWS. The relay validates the bundle ID, App Attest proof, and Apple distribution proof, and requires the official/production distribution path — this is what blocks local Xcode/dev builds from using the hosted relay, since a local build cannot satisfy the official Apple distribution proof.
3. `gateway identity delegation`: before relay registration, the app fetches the paired gateway identity from `gateway.identity.get` and includes it in the relay registration payload. The relay returns a relay handle and a registration-scoped send grant delegated to that gateway identity.
4. `gateway -> relay`: the gateway stores the relay handle and send grant from `push.apns.register`. On `push.test`, reconnect wakes, and wake nudges, the gateway signs the send request with its own device identity; the relay verifies both the stored send grant and the gateway signature against the delegated gateway identity from registration. Another gateway cannot reuse that stored registration, even if it somehow obtains the handle.
5. `relay -> APNs`: the relay owns the production APNs credentials and the raw APNs token for the official build. The gateway never stores the raw APNs token for relay-backed official builds; the relay sends the final push to APNs on behalf of the paired gateway.

Why this design was created: to keep production APNs credentials out of user gateways, avoid storing raw official-build APNs tokens on the gateway, allow hosted relay usage only for official OpenClaw iOS builds, and prevent one gateway from sending wake pushes to iOS devices owned by a different gateway.

Local/manual builds remain on direct APNs. If you are testing those builds without the relay, the gateway still needs direct APNs credentials:

```bash
export OPENCLAW_APNS_TEAM_ID="TEAMID"
export OPENCLAW_APNS_KEY_ID="KEYID"
export OPENCLAW_APNS_PRIVATE_KEY_P8="$(cat /path/to/AuthKey_KEYID.p8)"
```

These are gateway-host runtime env vars, not Fastlane settings. `apps/ios/fastlane/.env` only stores App Store Connect auth such as `APP_STORE_CONNECT_KEY_ID` and `APP_STORE_CONNECT_ISSUER_ID`; it does not configure direct APNs delivery for local iOS builds.

Recommended gateway-host storage, consistent with other provider credentials under `~/.openclaw/credentials/`:

```bash
mkdir -p ~/.openclaw/credentials/apns
chmod 700 ~/.openclaw/credentials/apns
mv /path/to/AuthKey_KEYID.p8 ~/.openclaw/credentials/apns/AuthKey_KEYID.p8
chmod 600 ~/.openclaw/credentials/apns/AuthKey_KEYID.p8
export OPENCLAW_APNS_PRIVATE_KEY_PATH="$HOME/.openclaw/credentials/apns/AuthKey_KEYID.p8"
```

Do not commit the `.p8` file or place it under the repo checkout.

## Discovery paths

### Bonjour (LAN)

The iOS app browses `_openclaw-gw._tcp` on `local.` and, when configured, the same wide-area DNS-SD discovery domain. Same-LAN gateways appear automatically from `local.`; cross-network discovery can use the configured wide-area domain without changing the beacon type.

### Tailnet (cross-network)

If mDNS is blocked, use a unicast DNS-SD zone (choose a domain; example: `openclaw.internal.`) and Tailscale split DNS. See [Bonjour](/gateway/bonjour) for the CoreDNS example.

### Manual host/port

In Settings, enable **Manual Host** and enter the gateway host + port (default `18789`).

## Multiple gateways

The app keeps a registry of every gateway it has paired with, so you can switch between them without pairing again:

- **Settings -> Gateway** shows a **Paired Gateways** list with the active gateway marked. Tap an entry to switch; the app tears down the current sessions and reconnects to the selected gateway. A quick-switch menu appears next to the connection row when more than one gateway is paired.
- Credentials, TLS trust decisions, per-gateway preferences, and cached chat history are stored per gateway. Switching never mixes state between gateways, and push registration follows the active gateway.
- Swipe a paired gateway (or use its context menu) to **Forget** it, which removes its credentials, device tokens, TLS pin, and cached chats.
- Discovered gateways must be visible on the network to switch to them; manual gateways reconnect by saved host and port.

## Computer Use relationship

The iOS app is a mobile node surface, not a Codex Computer Use backend. Codex Computer Use and `cua-driver mcp` control a local macOS desktop through MCP tools; the iOS app exposes iPhone capabilities through OpenClaw node commands such as `camera.*`, `screen.*`, `location.*`, and `talk.*`.

Agents can still operate the iOS app through OpenClaw by invoking node commands, but those calls go through the gateway node protocol and follow iOS foreground/background limits. Use [Codex Computer Use](/plugins/codex-computer-use) for local desktop control and this page for iOS node capabilities.

## Voice wake + talk mode

- Voice wake and talk mode are available in Settings.
- Voice wake sends recognized commands to the active session and shows Gateway delivery failures in Settings; use talk mode for spoken assistant replies.
- OpenAI realtime Talk uses client-owned WebRTC when `talk.realtime.transport` is `webrtc`; an explicit `gateway-relay` configuration remains Gateway-owned. See [Talk mode](/nodes/talk).
- Talk-capable iOS nodes advertise the `talk` capability and can declare `talk.ptt.start`, `talk.ptt.stop`, `talk.ptt.cancel`, and `talk.ptt.once`; the Gateway allows those push-to-talk commands by default for trusted Talk-capable nodes.
- iOS may suspend background audio; treat voice features as best-effort when the app is not active.

## Common errors

- `NODE_BACKGROUND_UNAVAILABLE`: bring the iOS app to the foreground (camera/screen commands require it).
- Pairing prompt never appears: run `openclaw devices list` and approve manually.
- `Gateway setup incomplete`: the Gateway did not provide both node and operator credentials. Generate a new iPhone setup code from **Devices -> Pair device** in the Control UI or `openclaw qr`, then scan it in **Settings -> Gateway**. Automatic reconnect stays paused until you retry setup; this is not a device-storage error.
- Watch shows no iPhone state: confirm the iPhone reports `watchPaired: true`
  and `watchAppInstalled: true` in `watch.status`. If pairing is false, pair the
  Watch in Apple's Watch app. If installation is false, install the companion
  from **My Watch -> Available Apps**. After either change, open OpenClaw on the
  Watch once; immediate reachability still requires both apps to be running,
  while queued updates can arrive later in the background.
- Reconnect fails after reinstall: the Keychain pairing token was cleared; re-pair the node.

## Related docs

- [Pairing](/channels/pairing)
- [Discovery](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
