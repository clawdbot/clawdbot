---
summary: "iOS app (node): architecture + connection runbook"
read_when:
  - Pairing or reconnecting the iOS node
  - Debugging iOS bridge discovery or auth
  - Sending screen/canvas commands to iOS
  - Designing iOS node + gateway integration
  - Extending the Gateway protocol for node/canvas commands
  - Implementing Bonjour pairing or transport security
---
# iOS App (Node)

Status: prototype implemented (internal) · Date: 2025-12-13

## Connection Runbook

This is the practical “how do I connect the iOS node” guide:

**iOS app** ⇄ (Bonjour + TCP bridge) ⇄ **Gateway bridge** ⇄ (loopback WS) ⇄ **Gateway**

The Gateway WebSocket stays loopback-only (`ws://127.0.0.1:18789`). The iOS node talks to the LAN-facing **bridge** (default `tcp://0.0.0.0:18790`) and uses Gateway-owned pairing.

### Prerequisites

- You can run the Gateway on the “master” machine.
- iOS node app can reach the gateway bridge:
  - Same LAN with Bonjour/mDNS, **or**
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

### 2) Verify Bonjour discovery (optional but recommended)

From the gateway machine:

```bash
dns-sd -B _clawdbot-bridge._tcp local.
```

You should see your gateway advertising `_clawdbot-bridge._tcp`.

If browse works, but the iOS node can’t connect, try resolving one instance:

```bash
dns-sd -L "<instance name>" _clawdbot-bridge._tcp local.
```

More debugging notes: `docs/bonjour.md`.

#### Tailnet (Vienna ⇄ London) discovery via unicast DNS-SD

If the iOS node and the gateway are on different networks but connected via Tailscale, multicast mDNS won’t cross the boundary. Use Wide-Area Bonjour / unicast DNS-SD instead:

1) Set up a DNS-SD zone (example `clawdbot.internal.`) on the gateway host and publish `_clawdbot-bridge._tcp` records.
2) Configure Tailscale split DNS for `clawdbot.internal` pointing at that DNS server.

Details and example CoreDNS config: `docs/bonjour.md`.

### 3) Connect from the iOS node app

In the iOS node app:
- Pick the discovered bridge (or hit refresh).
- If not paired yet, it will initiate pairing automatically.
- After the first successful pairing, it will auto-reconnect **strictly to the last discovered gateway** on launch (including after reinstall), as long as the iOS Keychain entry is still present.

#### Connection indicator (always visible)

The Settings tab icon shows a small status dot:
- **Green**: connected to the bridge
- **Yellow**: connecting (subtle pulse)
- **Red**: not connected / error

### 4) Approve pairing (CLI)

On the gateway machine:

```bash
clawdbot nodes pending
```

Approve the request:

```bash
clawdbot nodes approve <requestId>
```

After approval, the iOS node receives/stores the token and reconnects authenticated.

Pairing details: `docs/gateway/pairing.md`.

### 5) Verify the node is connected

- In the macOS app: **Instances** tab should show something like `iOS Node (...)` with a green “Active” presence dot shortly after connect.
- Via nodes status (paired + connected):
  ```bash
  clawdbot nodes status
  ```
- Via Gateway (paired + connected):
  ```bash
  clawdbot gateway call node.list --params "{}"
  ```
- Via Gateway presence (legacy-ish, still useful):
  ```bash
  clawdbot gateway call system-presence --params "{}"
  ```
  Look for the node `instanceId` (often a UUID).

### 6) Drive the iOS Canvas (draw / snapshot)

The iOS node runs a WKWebView “Canvas” scaffold which exposes:
- `window.__clawdbot.canvas`
- `window.__clawdbot.ctx` (2D context)
- `window.__clawdbot.setStatus(title, subtitle)`

#### Gateway Canvas Host (recommended for web content)

If you want the node to show real HTML/CSS/JS that the agent can edit on disk, point it at the Gateway canvas host.

Note: nodes always use the standalone canvas host on `canvasHost.port` (default `18793`), bound to the bridge interface.

1) Create `~/clawd/canvas/index.html` on the gateway host.

2) Navigate the node to it (LAN):

```bash
clawdbot nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__clawdbot__/canvas/"}'
```

Notes:
- The server injects a live-reload client into HTML and reloads on file changes.
- A2UI is hosted on the same canvas host at `http://<gateway-host>:18793/__clawdbot__/a2ui/`.
- Tailnet (optional): if both devices are on Tailscale, use a MagicDNS name or tailnet IP instead of `.local`, e.g. `http://<gateway-magicdns>:18793/__clawdbot__/canvas/`.
- iOS may require App Transport Security allowances to load plain `http://` URLs; if it fails to load, prefer HTTPS or adjust the iOS app’s ATS config.

#### Draw with `canvas.eval`

```bash
clawdbot nodes invoke --node "iOS Node" --command canvas.eval --params "$(cat <<'JSON'
{"javaScript":"(() => { const {ctx,setStatus} = window.__clawdbot; setStatus('Drawing','…'); ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle='#ff2d55'; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); setStatus(null,null); return 'ok'; })()"}
JSON
)"
```

#### Snapshot with `canvas.snapshot`

```bash
clawdbot nodes invoke --node 192.168.0.88 --command canvas.snapshot --params '{"maxWidth":900}'
```

The response includes `{ format, base64 }` image data (default `format="jpeg"`; pass `{"format":"png"}` when you specifically need lossless PNG).

### Common gotchas

- **iOS in background:** all `canvas.*` commands fail fast with `NODE_BACKGROUND_UNAVAILABLE` (bring the iOS node app to foreground).
- **Return to default scaffold:** `canvas.navigate` with `{"url":""}` or `{"url":"/"}` returns to the built-in scaffold page.
- **mDNS blocked:** some networks block multicast; use a different LAN or plan a tailnet-capable bridge (see `docs/discovery.md`).
- **Wrong node selector:** `--node` can be the node id (UUID), display name (e.g. `iOS Node`), IP, or an unambiguous prefix. If it’s ambiguous, the CLI will tell you.
- **Stale pairing / Keychain cleared:** if the pairing token is missing (or iOS Keychain was wiped), the node must pair again; approve a new pending request.
- **App reinstall but no reconnect:** the node restores `instanceId` + last bridge preference from Keychain; if it still comes up “unpaired”, verify Keychain persistence on your device/simulator and re-pair once.

## Design + Architecture

### Goals
- Build an **iOS app** that acts as a **remote node** for Clawdbot:
  - **Voice trigger** (wake-word / always-listening intent) that forwards transcripts to the Gateway `agent` method.
  - **Canvas** surface that the agent can control: navigate, draw/render, evaluate JS, snapshot.
- **Dead-simple setup**:
  - Auto-discover the host on the local network via **Bonjour**.
  - One-tap pairing with an approval prompt on the Mac.
  - iOS is **never** a local gateway; it is always a remote node.
- Operational clarity:
  - When iOS is backgrounded, voice may still run; **canvas commands must fail fast** with a structured error.
  - Provide **settings**: node display name, enable/disable voice wake, pairing status.

Non-goals (v1):
- Exposing the Node Gateway directly on the LAN.
- Supporting arbitrary third-party “plugins” on iOS.
- Perfect App Store compliance; this is **internal-only** initially.

### Current repo reality (constraints we respect)
- The Gateway WebSocket server binds to `127.0.0.1:18789` (`src/gateway/server.ts`) with an optional `CLAWDBOT_GATEWAY_TOKEN`.
- The Gateway exposes a Canvas file server (`canvasHost`) on `canvasHost.port` (default `18793`), so nodes can `canvas.navigate` to `http://<lanHost>:18793/__clawdbot__/canvas/` and auto-reload on file changes (`docs/configuration.md`).
- macOS “Canvas” is controlled via the Gateway node protocol (`canvas.*`), matching iOS/Android (`docs/mac/canvas.md`).
- Voice wake forwards via `GatewayChannel` to Gateway `agent` (mac app: `VoiceWakeForwarder` → `GatewayConnection.sendAgent`).

### Recommended topology (B): Gateway-owned Bridge + loopback Gateway
Keep the Node gateway loopback-only; expose a dedicated **gateway-owned bridge** to the LAN/tailnet.

**iOS App** ⇄ (TLS + pairing) ⇄ **Bridge (in gateway)** ⇄ (loopback) ⇄ **Gateway WS** (`ws://127.0.0.1:18789`)

Why:
- Preserves current threat model: Gateway remains local-only.
- Centralizes auth, rate limiting, and allowlisting in the bridge.
- Lets us unify “canvas node” semantics across mac + iOS without exposing raw gateway methods.

### Security plan (internal, but still robust)
#### Transport
- **Current (v0):** bridge is a LAN-facing **TCP** listener with token-based auth after pairing.
- **Next:** wrap the bridge in **TLS** and prefer key-pinned or mTLS-like auth after pairing.

#### Pairing
- Bonjour discovery shows a candidate “Clawdbot Bridge” on the LAN.
- First connection:
  1) iOS generates a keypair (Secure Enclave if available).
  2) iOS connects to the bridge and requests pairing.
  3) The bridge forwards the pairing request to the **Gateway** as a *pending request*.
  4) Approval can happen via:
     - **macOS UI** (Clawdbot shows an alert with Approve/Reject/Later, including the node IP), or
     - **Terminal/CLI** (headless flows).
  5) Once approved, the bridge returns a token to iOS; iOS stores it in Keychain.
- Subsequent connections:
  - The bridge requires the paired identity. Unpaired clients get a structured “not paired” error and no access.

##### Gateway-owned pairing (Option B details)
Pairing decisions must be owned by the Gateway (`clawd` / Node) so nodes can be approved without the macOS app running.

Key idea:
- The Swift app may still show an alert, but it is only a **frontend** for pending requests stored in the Gateway.

Desired behavior:
- If the Swift UI is present: show alert with Approve/Reject/Later.
- If the Swift UI is not present: `clawdbot` CLI can list pending requests and approve/reject.

See `docs/gateway/pairing.md` for the API/events and storage.

CLI (headless approvals):
- `clawdbot nodes pending`
- `clawdbot nodes approve <requestId>`
- `clawdbot nodes reject <requestId>`

#### Authorization / scope control (bridge-side ACL)
The bridge must not be a raw proxy to every gateway method.

- Allow by default:
  - `agent` (with guardrails; idempotency required)
  - minimal `system-event` beacons (presence updates for the node)
  - node/canvas methods defined below (new protocol surface)
- Deny by default:
  - anything that widens control without explicit intent (future “shell”, “files”, etc.)
- Rate limit:
  - handshake attempts
  - voice forwards per minute
  - snapshot frequency / payload size

### Protocol unification: add “node/canvas” to Gateway protocol
#### Principle
Unify mac Canvas + iOS Canvas under a single conceptual surface:
- The agent talks to the Gateway using a stable method set (typed protocol).
- The Gateway routes node-targeted requests to:
  - local mac Canvas implementation, or
  - remote iOS node via the bridge

#### Minimal protocol additions (v1)
Add to `src/gateway/protocol/schema.ts` (and regenerate Swift models):

**Identity**
- Node identity comes from `connect.params.client.instanceId` (stable), and `connect.params.client.mode = "node"` (or `"ios-node"`).

**Methods**
- `node.list` → list paired/connected nodes + capabilities
- `node.describe` → describe a node (capabilities + supported `node.invoke` commands)
- `node.invoke` → send a command to a specific node
  - Params: `{ nodeId, command, params?, timeoutMs? }`

**Events**
- `node.event` → async node status/errors
  - e.g. background/foreground transitions, voice availability, canvas availability

#### Node command set (canvas)
These are values for `node.invoke.command`:
- `canvas.present` / `canvas.hide`
- `canvas.navigate` with `{ url }` (loads a URL; use `""` or `"/"` to return to the default scaffold)
- `canvas.eval` with `{ javaScript }`
- `canvas.snapshot` with `{ maxWidth?, quality?, format? }`
- A2UI (mobile + macOS canvas):
  - `canvas.a2ui.push` with `{ messages: [...] }` (A2UI v0.8 server→client messages)
  - `canvas.a2ui.pushJSONL` with `{ jsonl: "..." }` (legacy alias)
  - `canvas.a2ui.reset`
  - A2UI is hosted by the Gateway canvas host (`/__clawdbot__/a2ui/`) on `canvasHost.port`. Commands fail if the host is unreachable.

Result pattern:
- Request is a standard `req/res` with `ok` / `error`.
- Long operations (loads, streaming drawing, etc.) may also emit `node.event` progress.

##### Current (implemented)
As of 2025-12-13, the Gateway supports `node.invoke` for bridge-connected nodes.

Example: draw a diagonal line on the iOS Canvas:
```bash
clawdbot nodes invoke --node ios-node --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__clawdbot; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

### Background behavior requirement
When iOS is backgrounded:
- Voice may still be active (subject to iOS suspension).
- **All `canvas.*` commands must fail** with a stable error code, e.g.:
  - `NODE_BACKGROUND_UNAVAILABLE`
  - Include `retryable: true` and `retryAfterMs` if we want the agent to wait.

## iOS app architecture (SwiftUI)
### App structure
- Single fullscreen Canvas surface (WKWebView).
- One settings entry point: a **gear button** that opens a settings sheet.
- All navigation is **agent-driven** (no local URL bar).

### Components
- `BridgeDiscovery`: Bonjour browse + resolve (Network.framework `NWBrowser`)
- `BridgeConnection`: TCP session + pairing handshake + reconnect (TLS planned)
- `NodeRuntime`:
  - Voice pipeline (wake-word + capture + forward)
  - Canvas pipeline (WKWebView controller + snapshot + eval)
  - Background state tracking; enforces “canvas unavailable in background”

### Voice in background (internal)
- Enable background audio mode (and required session configuration) so the mic pipeline can keep running when the user switches apps.
- If iOS suspends the app anyway, surface a clear node status (`node.event`) so operators can see voice is unavailable.

## Code sharing (macOS + iOS)
Create/expand SwiftPM targets so both apps share:
- `ClawdbotProtocol` (generated models; platform-neutral)
- `ClawdbotGatewayClient` (shared WS framing + connect/req/res + seq-gap handling)
- `ClawdbotKit` (node/canvas command types + deep links + shared utilities)

macOS continues to own:
- local Canvas implementation details (custom scheme handler serving on-disk HTML, window/panel presentation)

iOS owns:
- iOS-specific audio/speech + WKWebView presentation and lifecycle

## Repo layout
- iOS app: `apps/ios/` (XcodeGen `project.yml`)
- Shared Swift packages: `apps/shared/`
- Lint/format: iOS target runs `swiftformat --lint` + `swiftlint lint` using repo configs (`.swiftformat`, `.swiftlint.yml`).

Generate the Xcode project:
```bash
cd apps/ios
xcodegen generate
open Clawdbot.xcodeproj
```

## Storage plan (private by default)
### iOS
- Canvas/workspace files (persistent, private):
  - `Application Support/Clawdbot/canvas/<sessionKey>/...`
- Snapshots / temp exports (evictable):
  - `Library/Caches/Clawdbot/canvas-snapshots/<sessionKey>/...`
- Credentials:
  - Keychain (paired identity + bridge trust anchor)

## Related docs

- `docs/gateway.md` (gateway runbook)
- `docs/gateway/pairing.md` (approval + storage)
- `docs/bonjour.md` (discovery debugging)
- `docs/discovery.md` (LAN vs tailnet vs SSH)
