---
summary: "iOS node app: connect to the Gateway, pairing, canvas, and troubleshooting"
read_when:
  - Pairing or reconnecting the iOS node
  - Running the iOS app from source
  - Debugging bridge discovery or canvas commands
---
# iOS App (Node)

Availability: internal preview. The iOS app is not publicly distributed yet.

## What it does

- Connects to a Gateway over the bridge (LAN or tailnet).
- Exposes node capabilities: Canvas, Screen snapshot, Camera capture, Location, Talk mode, Voice wake.
- Receives `node.invoke` commands and reports node status events.

## Requirements

- Gateway running on another device (macOS, Linux, or Windows via WSL2).
- Bridge enabled (default).
- Network path:
  - Same LAN via Bonjour, **or**
  - Tailnet via unicast DNS-SD (`clawdbot.internal.`), **or**
  - Manual host/port (fallback).

## Quick start (pair + connect)

1) Start the Gateway (bridge enabled by default):

```bash
clawdbot gateway --port 18789
```

2) In the iOS app, open Settings and pick a discovered gateway (or enable Manual Bridge and enter host/port).

3) Approve the pairing request on the gateway host:

```bash
clawdbot nodes pending
clawdbot nodes approve <requestId>
```

4) Verify connection:

```bash
clawdbot nodes status
clawdbot gateway call node.list --params "{}"
```

## Discovery paths

### Bonjour (LAN)

The Gateway advertises `_clawdbot-bridge._tcp` on `local.`. The iOS app lists these automatically.

### Tailnet (cross-network)

If mDNS is blocked, use a unicast DNS-SD zone (recommended domain: `clawdbot.internal.`) and Tailscale split DNS.
See [Bonjour](/gateway/bonjour) for the CoreDNS example.

### Manual host/port

In Settings, enable **Manual Bridge** and enter the gateway host + port (default `18790`).

## Canvas + A2UI

The iOS node renders a WKWebView canvas. Use `node.invoke` to drive it:

```bash
clawdbot nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__clawdbot__/canvas/"}'
```

Notes:
- The Gateway canvas host serves `/__clawdbot__/canvas/` and `/__clawdbot__/a2ui/`.
- The iOS node auto-navigates to A2UI on connect when a canvas host URL is advertised.
- Return to the built-in scaffold with `canvas.navigate` and `{"url":""}`.

### Canvas eval / snapshot

```bash
clawdbot nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__clawdbot; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
clawdbot nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Voice wake + talk mode

- Voice wake and talk mode are available in Settings.
- iOS may suspend background audio; treat voice features as best-effort when the app is not active.

## Common errors

- `NODE_BACKGROUND_UNAVAILABLE`: bring the iOS app to the foreground (canvas/camera/screen commands require it).
- `A2UI_HOST_NOT_CONFIGURED`: the Gateway did not advertise a canvas host URL; check `canvasHost` in [Gateway configuration](/gateway/configuration).
- Pairing prompt never appears: run `clawdbot nodes pending` and approve manually.
- Reconnect fails after reinstall: the Keychain pairing token was cleared; re-pair the node.

## Related docs

- [Pairing](/gateway/pairing)
- [Discovery](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
