---
summary: "Android app (node): connection runbook + Canvas/Chat/Camera"
read_when:
  - Pairing or reconnecting the Android node
  - Debugging Android bridge discovery or auth
  - Verifying chat history parity across clients
---

# Android App (Node)

## Connection Runbook

Android node app ⇄ (mDNS/NSD + TCP bridge) ⇄ **Gateway bridge** ⇄ (loopback WS) ⇄ **Gateway**

The Gateway WebSocket stays loopback-only (`ws://127.0.0.1:18789`). Android talks to the LAN-facing **bridge** (default `tcp://0.0.0.0:18790`) and uses Gateway-owned pairing.

### Prerequisites

- You can run the Gateway on the “master” machine.
- Android device/emulator can reach the gateway bridge:
  - Same LAN with mDNS/NSD, **or**
  - Same Tailscale tailnet using Wide-Area Bonjour / unicast DNS-SD (see below), **or**
  - Manual bridge host/port (fallback)
- You can run the CLI (`clawdbot`) on the gateway machine (or via SSH).

### 1) Start the Gateway (with bridge enabled)

Bridge is enabled by default (disable via `CLAWDBOT_BRIDGE_ENABLED=0`).

```bash
pnpm clawdbot gateway --port 18789 --verbose
```

Confirm in logs you see something like:
- `bridge listening on tcp://0.0.0.0:18790 (node)`

For tailnet-only setups (recommended for Vienna ⇄ London), bind the bridge to the gateway machine’s Tailscale IP instead:

- Set `bridge.bind: "tailnet"` in `~/.clawdbot/clawdbot.json` on the gateway host.
- Restart the Gateway / macOS menubar app.

### 2) Verify discovery (optional)

From the gateway machine:

```bash
dns-sd -B _clawdbot-bridge._tcp local.
```

More debugging notes: `docs/bonjour.md`.

#### Tailnet (Vienna ⇄ London) discovery via unicast DNS-SD

Android NSD/mDNS discovery won’t cross networks. If your Android node and the gateway are on different networks but connected via Tailscale, use Wide-Area Bonjour / unicast DNS-SD instead:

1) Set up a DNS-SD zone (example `clawdbot.internal.`) on the gateway host and publish `_clawdbot-bridge._tcp` records.
2) Configure Tailscale split DNS for `clawdbot.internal` pointing at that DNS server.

Details and example CoreDNS config: `docs/bonjour.md`.

### 3) Connect from Android

In the Android app:

- The app keeps its bridge connection alive via a **foreground service** (persistent notification).
- Open **Settings**.
- Under **Discovered Bridges**, select your gateway and hit **Connect**.
- If mDNS is blocked, use **Advanced → Manual Bridge** (host + port) and **Connect (Manual)**.

After the first successful pairing, Android auto-reconnects on launch:
- Manual endpoint (if enabled), otherwise
- The last discovered bridge (best-effort).

### 4) Approve pairing (CLI)

On the gateway machine:

```bash
clawdbot nodes pending
clawdbot nodes approve <requestId>
```

Pairing details: `docs/gateway/pairing.md`.

### 5) Verify the node is connected

- Via nodes status:
  ```bash
  clawdbot nodes status
  ```
- Via Gateway:
  ```bash
  clawdbot gateway call node.list --params "{}"
  ```

### 6) Chat + history

The Android node’s Chat sheet uses the gateway’s **primary session key** (`main`), so history and replies are shared with WebChat and other clients:

- History: `chat.history`
- Send: `chat.send`
- Push updates (best-effort): `chat.subscribe` → `event:"chat"`

### 7) Canvas + camera

#### Gateway Canvas Host (recommended for web content)

If you want the node to show real HTML/CSS/JS that the agent can edit on disk, point the node at the Gateway canvas host.

Note: nodes always use the standalone canvas host on `canvasHost.port` (default `18793`), bound to the bridge interface.

1) Create `~/clawd/canvas/index.html` on the gateway host.

2) Navigate the node to it (LAN):

```bash
clawdbot nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__clawdbot__/canvas/"}'
```

Tailnet (optional): if both devices are on Tailscale, use a MagicDNS name or tailnet IP instead of `.local`, e.g. `http://<gateway-magicdns>:18793/__clawdbot__/canvas/`.

This server injects a live-reload client into HTML and reloads on file changes.
The A2UI host lives at `http://<gateway-host>:18793/__clawdbot__/a2ui/`.

Canvas commands (foreground only):
- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (use `{"url":""}` or `{"url":"/"}` to return to the default scaffold). `canvas.snapshot` returns `{ format, base64 }` (default `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` legacy alias)

Camera commands (foreground only; permission-gated):
- `camera.snap` (jpg)
- `camera.clip` (mp4)

See `docs/camera.md` for parameters and CLI helpers.
