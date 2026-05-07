---
summary: "iOS node app: connect to the Gateway, pairing, canvas, and troubleshooting"
read_when:
  - Pairing or reconnecting the iOS node
  - Running the iOS app from source
  - Debugging gateway discovery or canvas commands
title: "iOS app"
---

Availability: internal preview. The iOS app is not publicly distributed yet.

## What it does

- Connects to a Gateway over WebSocket (LAN or tailnet).
- Exposes node capabilities: Canvas, Screen snapshot, Camera capture, Location, Talk mode, Voice wake.
- Receives `node.invoke` commands and reports node status events.

## Requirements

- Gateway running on another device (macOS, Linux, or Windows via WSL2).
- Network path:
  - Same LAN via Bonjour, **or**
  - Tailnet via unicast DNS-SD (example domain: `openclaw.internal.`), **or**
  - Manual host/port (fallback).

## Quick start (pair + connect)

1. Start the Gateway:

```bash
openclaw gateway --port 18789
```

2. In the iOS app, open Settings and pick a discovered gateway (or enable Manual Host and enter host/port).

3. Approve the pairing request on the gateway host:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

If the app retries pairing with changed auth details (role/scopes/public key),
the previous pending request is superseded and a new `requestId` is created.
Run `openclaw devices list` again before approval.

Optional: if the iOS node always connects from a tightly controlled subnet, you
can opt in to first-time node auto-approval with explicit CIDRs or exact IPs:

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

This is disabled by default. It applies only to fresh `role: node` pairing with
no requested scopes. Operator/browser pairing and any role, scope, metadata, or
public-key change still require manual approval.

4. Verify connection:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## Relay-backed push for official builds

Official distributed iOS builds use the external push relay instead of publishing the raw APNs
token to the gateway.

Gateway-side requirement:

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
- The iOS app fetches the paired gateway identity and includes it in relay registration, so the relay-backed registration is delegated to that specific gateway.
- The app forwards that relay-backed registration to the paired gateway with `push.apns.register`.
- The gateway uses that stored relay handle for `push.test`, background wakes, and wake nudges.
- The gateway relay base URL must match the relay URL baked into the official/TestFlight iOS build.
- If the app later connects to a different gateway or a build with a different relay base URL, it refreshes the relay registration instead of reusing the old binding.

What the gateway does **not** need for this path:

- No deployment-wide relay token.
- No direct APNs key for official/TestFlight relay-backed sends.

Expected operator flow:

1. Install the official/TestFlight iOS build.
2. Set `gateway.push.apns.relay.baseUrl` on the gateway.
3. Pair the app to the gateway and let it finish connecting.
4. The app publishes `push.apns.register` automatically after it has an APNs token, the operator session is connected, and relay registration succeeds.
5. After that, `push.test`, reconnect wakes, and wake nudges can use the stored relay-backed registration.

## Background alive beacons

When iOS wakes the app for a silent push, background refresh, or significant-location event, the app
attempts a short node reconnect and then calls `node.event` with `event: "node.presence.alive"`.
The gateway records this as `lastSeenAtMs`/`lastSeenReason` on the paired node/device metadata only
after the authenticated node device identity is known.

The app treats a background wake as successfully recorded only when the gateway response includes
`handled: true`. Older gateways may acknowledge `node.event` with `{ "ok": true }`; that response is
compatible but does not count as a durable last-seen update.

Compatibility note:

- `OPENCLAW_APNS_RELAY_BASE_URL` still works as a temporary env override for the gateway.

## Authentication and trust flow

The relay exists to enforce two constraints that direct APNs-on-gateway cannot provide for
official iOS builds:

- Only genuine OpenClaw iOS builds distributed through Apple can use the hosted relay.
- A gateway can send relay-backed pushes only for iOS devices that paired with that specific
  gateway.

Hop by hop:

1. `iOS app -> gateway`
   - The app first pairs with the gateway through the normal Gateway auth flow.
   - That gives the app an authenticated node session plus an authenticated operator session.
   - The operator session is used to call `gateway.identity.get`.

2. `iOS app -> relay`
   - The app calls the relay registration endpoints over HTTPS.
   - Registration includes App Attest proof plus a StoreKit app transaction JWS.
   - The relay validates the bundle ID, App Attest proof, and Apple distribution proof, and requires the
     official/production distribution path.
   - This is what blocks local Xcode/dev builds from using the hosted relay. A local build may be
     signed, but it does not satisfy the official Apple distribution proof the relay expects.

3. `gateway identity delegation`
   - Before relay registration, the app fetches the paired gateway identity from
     `gateway.identity.get`.
   - The app includes that gateway identity in the relay registration payload.
   - The relay returns a relay handle and a registration-scoped send grant that are delegated to
     that gateway identity.

4. `gateway -> relay`
   - The gateway stores the relay handle and send grant from `push.apns.register`.
   - On `push.test`, reconnect wakes, and wake nudges, the gateway signs the send request with its
     own device identity.
   - The relay verifies both the stored send grant and the gateway signature against the delegated
     gateway identity from registration.
   - Another gateway cannot reuse that stored registration, even if it somehow obtains the handle.

5. `relay -> APNs`
   - The relay owns the production APNs credentials and the raw APNs token for the official build.
   - The gateway never stores the raw APNs token for relay-backed official builds.
   - The relay sends the final push to APNs on behalf of the paired gateway.

Why this design was created:

- To keep production APNs credentials out of user gateways.
- To avoid storing raw official-build APNs tokens on the gateway.
- To allow hosted relay usage only for official/TestFlight OpenClaw builds.
- To prevent one gateway from sending wake pushes to iOS devices owned by a different gateway.

Local/manual builds remain on direct APNs. If you are testing those builds without the relay, the
gateway still needs direct APNs credentials:

```bash
export OPENCLAW_APNS_TEAM_ID="TEAMID"
export OPENCLAW_APNS_KEY_ID="KEYID"
export OPENCLAW_APNS_PRIVATE_KEY_P8="$(cat /path/to/AuthKey_KEYID.p8)"
```

These are gateway-host runtime env vars, not Fastlane settings. `apps/ios/fastlane/.env` only stores
App Store Connect / TestFlight auth such as `ASC_KEY_ID` and `ASC_ISSUER_ID`; it does not configure
direct APNs delivery for local iOS builds.

Recommended gateway-host storage:

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

The iOS app browses `_openclaw-gw._tcp` on `local.` and, when configured, the same
wide-area DNS-SD discovery domain. Same-LAN gateways appear automatically from `local.`;
cross-network discovery can use the configured wide-area domain without changing the beacon type.

### Tailnet (cross-network)

If mDNS is blocked, use a unicast DNS-SD zone (choose a domain; example:
`openclaw.internal.`) and Tailscale split DNS.
See [Bonjour](/gateway/bonjour) for the CoreDNS example.

### Manual host/port

In Settings, enable **Manual Host** and enter the gateway host + port (default `18789`).

## Canvas + A2UI

The iOS node renders a WKWebView canvas. Use `node.invoke` to drive it:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18789/__openclaw__/canvas/"}'
```

Notes:

- The Gateway canvas host serves `/__openclaw__/canvas/` and `/__openclaw__/a2ui/`.
- It is served from the Gateway HTTP server (same port as `gateway.port`, default `18789`).
- The iOS node auto-navigates to A2UI on connect when a canvas host URL is advertised.
- Return to the built-in scaffold with `canvas.navigate` and `{"url":""}`.

## Computer Use relationship

The iOS app is a mobile node surface, not a Codex Computer Use backend. Codex
Computer Use and `cua-driver mcp` control a local macOS desktop through MCP
tools; the iOS app exposes iPhone capabilities through OpenClaw node commands
such as `canvas.*`, `camera.*`, `screen.*`, `location.*`, and `talk.*`.

Agents can still operate the iOS app through OpenClaw by invoking node
commands, but those calls go through the gateway node protocol and follow iOS
foreground/background limits. Use [Codex Computer Use](/plugins/codex-computer-use)
for local desktop control and this page for iOS node capabilities.

### Canvas eval / snapshot

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Voice wake + talk mode

- Voice wake and talk mode are available in Settings.
- Talk-capable iOS nodes advertise the `talk` capability and can declare
  `talk.ptt.start`, `talk.ptt.stop`, `talk.ptt.cancel`, and `talk.ptt.once`;
  the Gateway allows those push-to-talk commands by default for trusted
  Talk-capable nodes.
- iOS may suspend background audio; treat voice features as best-effort when the app is not active.

## Common errors

- `NODE_BACKGROUND_UNAVAILABLE`: bring the iOS app to the foreground (canvas/camera/screen commands require it).
- `A2UI_HOST_NOT_CONFIGURED`: the Gateway did not advertise the Canvas plugin surface URL; check `plugins.entries.canvas.config.host` in [Gateway configuration](/gateway/configuration).
- Pairing prompt never appears: run `openclaw devices list` and approve manually.
- Reconnect fails after reinstall: the Keychain pairing token was cleared; re-pair the node.

## Related docs

- [Pairing](/channels/pairing)
- [Discovery](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
