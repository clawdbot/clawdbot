---
summary: "iOS node app: connect to the Gateway, pairing, canvas, and troubleshooting"
read_when:
  - Pairing or reconnecting the iOS node
  - Running the iOS app from source
  - Debugging gateway discovery or canvas commands
---
# iOS App (Node)

Availability: internal preview. The iOS app is not publicly distributed yet.

## What it does

- Connects to a Gateway over WebSocket (LAN or tailnet).
- Exposes node capabilities: Canvas, Screen snapshot, Camera capture, Location, Talk mode, Voice wake.
- Receives `node.invoke` commands and reports node status events.

## Requirements

- Gateway running on another device (macOS, Linux, or Windows via WSL2).
- Network path:
  - Same LAN via Bonjour, **or**
  - Tailnet via unicast DNS-SD (`moltbot.internal.`), **or**
  - Manual host/port (fallback).

## Quick start (authenticate + pair + connect)

### 1. Start the Gateway

```bash
moltbot gateway --port 18789
```

### 2. Configure authentication in the iOS app

Open Settings in the Moltbot iOS app and configure **one** of the following:

- **Gateway Token**: Paste the token from `moltbot config get gateway.token` (recommended for secure setups)
- **Gateway Password**: Enter the password from `moltbot config get gateway.password` (simpler alternative)

If neither is set on the gateway, you can set one:

```bash
moltbot config set gateway.token "your-secret-token"
# or
moltbot config set gateway.password "your-password"
```

### 3. Select the gateway

In the iOS app Settings, pick a discovered gateway from the list, or enable **Manual Host** and enter the host/port manually.

### 4. Approve the pairing request

The iOS app requires device pairing for both operator and node roles. On the gateway host, list and approve pending devices:

```bash
moltbot devices list
moltbot devices approve <id>
```

You may need to approve twice (once for operator role, once for node role).

> **Note**: Use `moltbot devices` for WebSocket pairing, not `moltbot nodes pending/approve`.

### 5. Verify connection

```bash
moltbot nodes status
moltbot gateway call node.list --params "{}"
```

## Discovery paths

### Bonjour (LAN)

The Gateway advertises `_moltbot._tcp` on `local.`. The iOS app lists these automatically.

### Tailnet (cross-network)

If mDNS is blocked, use a unicast DNS-SD zone (recommended domain: `moltbot.internal.`) and Tailscale split DNS.
See [Bonjour](/gateway/bonjour) for the CoreDNS example.

### Manual host/port

In Settings, enable **Manual Host** and enter the gateway host + port (default `18789`).

## Canvas + A2UI

The iOS node renders a WKWebView canvas. Use `node.invoke` to drive it:

```bash
moltbot nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__moltbot__/canvas/"}'
```

Notes:
- The Gateway canvas host serves `/__moltbot__/canvas/` and `/__moltbot__/a2ui/`.
- The iOS node auto-navigates to A2UI on connect when a canvas host URL is advertised.
- Return to the built-in scaffold with `canvas.navigate` and `{"url":""}`.

### Canvas eval / snapshot

```bash
moltbot nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__moltbot; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
moltbot nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Voice wake + talk mode

- Voice wake and talk mode are available in Settings.
- iOS may suspend background audio; treat voice features as best-effort when the app is not active.

## Common errors

- `NODE_BACKGROUND_UNAVAILABLE`: bring the iOS app to the foreground (canvas/camera/screen commands require it).
- `A2UI_HOST_NOT_CONFIGURED`: the Gateway did not advertise a canvas host URL; check `canvasHost` in [Gateway configuration](/gateway/configuration).
- **Authentication failed**: Ensure the gateway token or password in iOS Settings matches what is configured on the gateway (`moltbot config get gateway.token` or `gateway.password`).
- **Pairing prompt never appears**: Run `moltbot devices list` to see pending requests and approve with `moltbot devices approve <id>`.
- **Reconnect fails after reinstall**: The Keychain pairing token was cleared; re-pair the device using `moltbot devices list` and `moltbot devices approve`.

## Related docs

- [Pairing](/gateway/pairing)
- [Discovery](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
