---
summary: "Nodes: pairing, capabilities, permissions, and CLI helpers for canvas/camera/screen/system"
read_when:
  - Pairing iOS/Android nodes to a gateway
  - Using node canvas/camera for agent context
  - Adding new node commands or CLI helpers
---

# Nodes

A **node** is a companion device (macOS/iOS/Android/headless) that connects to the Gateway **WebSocket** (same port as operators) with `role: "node"` and exposes a command surface (e.g. `canvas.*`, `camera.*`, `system.*`) via `node.invoke`. Protocol details: [Gateway protocol](/gateway/protocol).

Legacy transport: [Bridge protocol](/gateway/bridge-protocol) (TCP JSONL; deprecated/removed for current nodes).

macOS can also run in **node mode**: the menubar app connects to the Gateway’s WS server and exposes its local canvas/camera commands as a node (so `moltbot nodes …` works against this Mac).

Notes:
- Nodes are **peripherals**, not gateways. They don’t run the gateway service.
- Telegram/WhatsApp/etc. messages land on the **gateway**, not on nodes.

## Pairing + status

**WS nodes use device pairing.** Nodes present a device identity during `connect`; the Gateway
creates a device pairing request for `role: node`. Approve via the devices CLI (or UI).

Quick CLI:

```bash
moltbot devices list
moltbot devices approve <requestId>
moltbot devices reject <requestId>
moltbot nodes status
moltbot nodes describe --node <idOrNameOrIp>
```

Notes:
- `nodes status` marks a node as **paired** when its device pairing role includes `node`.
- `node.pair.*` (CLI: `moltbot nodes pending/approve/reject`) is a separate gateway-owned
  node pairing store; it does **not** gate the WS `connect` handshake.

## Remote node host (system.run)

Use a **node host** when your Gateway runs on one machine and you want commands
to execute on another. The model still talks to the **gateway**; the gateway
forwards `exec` calls to the **node host** when `host=node` is selected.

### What runs where
- **Gateway host**: receives messages, runs the model, routes tool calls.
- **Node host**: executes `system.run`/`system.which` on the node machine.
- **Approvals**: enforced on the node host via `~/.clawdbot/exec-approvals.json`.

### Start a node host (foreground)

On the node machine:

```bash
moltbot node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### Start a node host (service)

```bash
moltbot node install --host <gateway-host> --port 18789 --display-name "Build Node"
moltbot node restart
```

### Pair + name

On the gateway host:

```bash
moltbot nodes pending
moltbot nodes approve <requestId>
moltbot nodes list
```

Naming options:
- `--display-name` on `moltbot node run` / `moltbot node install` (persists in `~/.clawdbot/node.json` on the node).
- `moltbot nodes rename --node <id|name|ip> --name "Build Node"` (gateway override).

### Allowlist the commands

Exec approvals are **per node host**. Add allowlist entries from the gateway:

```bash
moltbot approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
moltbot approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Approvals live on the node host at `~/.clawdbot/exec-approvals.json`.

### Point exec at the node

Configure defaults (gateway config):

```bash
moltbot config set tools.exec.host node
moltbot config set tools.exec.security allowlist
moltbot config set tools.exec.node "<id-or-name>"
```

Or per session:

```
/exec host=node security=allowlist node=<id-or-name>
```

Once set, any `exec` call with `host=node` runs on the node host (subject to the
node allowlist/approvals).

Related:
- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

## Invoking commands

Low-level (raw RPC):

```bash
moltbot nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

Higher-level helpers exist for the common “give the agent a MEDIA attachment” workflows.

## Screenshots (canvas snapshots)

If the node is showing the Canvas (WebView), `canvas.snapshot` returns `{ format, base64 }`.

CLI helper (writes to a temp file and prints `MEDIA:<path>`):

```bash
moltbot nodes canvas snapshot --node <idOrNameOrIp> --format png
moltbot nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Canvas controls

```bash
moltbot nodes canvas present --node <idOrNameOrIp> --target https://example.com
moltbot nodes canvas hide --node <idOrNameOrIp>
moltbot nodes canvas navigate https://example.com --node <idOrNameOrIp>
moltbot nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

Notes:
- `canvas present` accepts URLs or local file paths (`--target`), plus optional `--x/--y/--width/--height` for positioning.
- `canvas eval` accepts inline JS (`--js`) or a positional arg.

### A2UI (Canvas)

```bash
moltbot nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
moltbot nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
moltbot nodes canvas a2ui reset --node <idOrNameOrIp>
```

Notes:
- Only A2UI v0.8 JSONL is supported (v0.9/createSurface is rejected).

## Photos + videos (node camera)

Photos (`jpg`):

```bash
moltbot nodes camera list --node <idOrNameOrIp>
moltbot nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
moltbot nodes camera snap --node <idOrNameOrIp> --facing front
```

Video clips (`mp4`):

```bash
moltbot nodes camera clip --node <idOrNameOrIp> --duration 10s
moltbot nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Notes:
- The node must be **foregrounded** for `canvas.*` and `camera.*` (background calls return `NODE_BACKGROUND_UNAVAILABLE`).
- Clip duration is clamped (currently `<= 60s`) to avoid oversized base64 payloads.
- Android will prompt for `CAMERA`/`RECORD_AUDIO` permissions when possible; denied permissions fail with `*_PERMISSION_REQUIRED`.

## Screen recordings (nodes)

Nodes expose `screen.record` (mp4). Example:

```bash
moltbot nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
moltbot nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

Notes:
- `screen.record` requires the node app to be foregrounded.
- Android will show the system screen-capture prompt before recording.
- Screen recordings are clamped to `<= 60s`.
- `--no-audio` disables microphone capture (supported on iOS/Android; macOS uses system capture audio).
- Use `--screen <index>` to select a display when multiple screens are available.

## Location (nodes)

Nodes expose `location.get` when Location is enabled in settings.

CLI helper:

```bash
moltbot nodes location get --node <idOrNameOrIp>
moltbot nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Notes:
- Location is **off by default**.
- “Always” requires system permission; background fetch is best-effort.
- The response includes lat/lon, accuracy (meters), and timestamp.

## SMS (Android nodes)

Android nodes can expose `sms.send` when the user grants **SMS** permission and the device supports telephony.

Low-level invoke:

```bash
moltbot nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from Moltbot"}'
```

Notes:
- The permission prompt must be accepted on the Android device before the capability is advertised.
- Wi-Fi-only devices without telephony will not advertise `sms.send`.

## System commands (node host / mac node)

The macOS node exposes `system.run`, `system.notify`, and `system.execApprovals.get/set`.
The headless node host exposes `system.run`, `system.which`, and `system.execApprovals.get/set`.

Examples:

```bash
moltbot nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
moltbot nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

Notes:
- `system.run` returns stdout/stderr/exit code in the payload.
- `system.notify` respects notification permission state on the macOS app.
- `system.run` supports `--cwd`, `--env KEY=VAL`, `--command-timeout`, and `--needs-screen-recording`.
- `system.notify` supports `--priority <passive|active|timeSensitive>` and `--delivery <system|overlay|auto>`.
- macOS nodes drop `PATH` overrides; headless node hosts only accept `PATH` when it prepends the node host PATH.
- On macOS node mode, `system.run` is gated by exec approvals in the macOS app (Settings → Exec approvals).
  Ask/allowlist/full behave the same as the headless node host; denied prompts return `SYSTEM_RUN_DENIED`.
- On headless node host, `system.run` is gated by exec approvals (`~/.clawdbot/exec-approvals.json`).

## Exec node binding

When multiple nodes are available, you can bind exec to a specific node.
This sets the default node for `exec host=node` (and can be overridden per agent).

Global default:

```bash
moltbot config set tools.exec.node "node-id-or-name"
```

Per-agent override:

```bash
moltbot config get agents.list
moltbot config set agents.list[0].tools.exec.node "node-id-or-name"
```

Unset to allow any node:

```bash
moltbot config unset tools.exec.node
moltbot config unset agents.list[0].tools.exec.node
```

## Permissions map

Nodes may include a `permissions` map in `node.list` / `node.describe`, keyed by permission name (e.g. `screenRecording`, `accessibility`) with boolean values (`true` = granted).

## Headless node host (cross-platform)

Moltbot can run a **headless node host** (no UI) that connects to the Gateway
WebSocket and exposes `system.run` / `system.which`. This is useful on Linux/Windows
or for running a minimal node alongside a server.

Start it:

```bash
moltbot node run --host <gateway-host> --port 18789
```

Notes:
- Pairing is still required (the Gateway will show a node approval prompt).
- The node host stores its node id, token, display name, and gateway connection info in `~/.clawdbot/node.json`.
- Exec approvals are enforced locally via `~/.clawdbot/exec-approvals.json`
  (see [Exec approvals](/tools/exec-approvals)).
- On macOS, the headless node host prefers the companion app exec host when reachable and falls
  back to local execution if the app is unavailable. Set `CLAWDBOT_NODE_EXEC_HOST=app` to require
  the app, or `CLAWDBOT_NODE_EXEC_FALLBACK=0` to disable fallback.
- Add `--tls` / `--tls-fingerprint` when the Gateway WS uses TLS.

## Mac node mode

- The macOS menubar app connects to the Gateway WS server as a node (so `moltbot nodes …` works against this Mac).
- In remote mode, the app opens an SSH tunnel for the Gateway port and connects to `localhost`.
