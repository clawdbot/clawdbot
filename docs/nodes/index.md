---
summary: "Nodes: pairing, capabilities, permissions, and CLI helpers for canvas/camera/screen/system"
read_when:
  - Pairing iOS/Android nodes to a gateway
  - Using node canvas/camera for agent context
  - Adding new node commands or CLI helpers
---

# Nodes

A **node** is a companion device (iOS/Android today) that connects to the Gateway over the **Bridge** and exposes a command surface (e.g. `canvas.*`, `camera.*`, `system.*`) via `node.invoke`. Bridge protocol details: [Bridge protocol](/gateway/bridge-protocol).

macOS can also run in **node mode**: the menubar app connects to the Gateway’s bridge and exposes its local canvas/camera commands as a node (so `clawdbot nodes …` works against this Mac).

Notes:
- Nodes are **peripherals**, not gateways. They don’t run the gateway daemon.
- Telegram/WhatsApp/etc. messages land on the **gateway**, not on nodes.

## Pairing + status

Pairing is gateway-owned and approval-based. See [Gateway pairing](/gateway/pairing) for the full flow.

Quick CLI:

```bash
clawdbot nodes pending
clawdbot nodes approve <requestId>
clawdbot nodes reject <requestId>
clawdbot nodes status
clawdbot nodes describe --node <idOrNameOrIp>
clawdbot nodes rename --node <idOrNameOrIp> --name "Kitchen iPad"
```

Notes:
- `nodes rename` stores a display name override in the gateway pairing store.

## Invoking commands

Low-level (raw RPC):

```bash
clawdbot nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

Higher-level helpers exist for the common “give the agent a MEDIA attachment” workflows.

## Screenshots (canvas snapshots)

If the node is showing the Canvas (WebView), `canvas.snapshot` returns `{ format, base64 }`.

CLI helper (writes to a temp file and prints `MEDIA:<path>`):

```bash
clawdbot nodes canvas snapshot --node <idOrNameOrIp> --format png
clawdbot nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Canvas controls

```bash
clawdbot nodes canvas present --node <idOrNameOrIp> --target https://example.com
clawdbot nodes canvas hide --node <idOrNameOrIp>
clawdbot nodes canvas navigate https://example.com --node <idOrNameOrIp>
clawdbot nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

Notes:
- `canvas present` accepts URLs or local file paths (`--target`), plus optional `--x/--y/--width/--height` for positioning.
- `canvas eval` accepts inline JS (`--js`) or a positional arg.

### A2UI (Canvas)

```bash
clawdbot nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
clawdbot nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
clawdbot nodes canvas a2ui reset --node <idOrNameOrIp>
```

Notes:
- Only A2UI v0.8 JSONL is supported (v0.9/createSurface is rejected).

## Photos + videos (node camera)

Photos (`jpg`):

```bash
clawdbot nodes camera list --node <idOrNameOrIp>
clawdbot nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
clawdbot nodes camera snap --node <idOrNameOrIp> --facing front
```

Video clips (`mp4`):

```bash
clawdbot nodes camera clip --node <idOrNameOrIp> --duration 10s
clawdbot nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Notes:
- The node must be **foregrounded** for `canvas.*` and `camera.*` (background calls return `NODE_BACKGROUND_UNAVAILABLE`).
- Clip duration is clamped (currently `<= 60s`) to avoid oversized base64 payloads.
- Android will prompt for `CAMERA`/`RECORD_AUDIO` permissions when possible; denied permissions fail with `*_PERMISSION_REQUIRED`.

## Screen recordings (nodes)

Nodes expose `screen.record` (mp4). Example:

```bash
clawdbot nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
clawdbot nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
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
clawdbot nodes location get --node <idOrNameOrIp>
clawdbot nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Notes:
- Location is **off by default**.
- “Always” requires system permission; background fetch is best-effort.
- The response includes lat/lon, accuracy (meters), and timestamp.

## SMS (Android nodes)

Android nodes can expose `sms.send` when the user grants **SMS** permission and the device supports telephony.

Low-level invoke:

```bash
clawdbot nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from Clawdbot"}'
```

Notes:
- The permission prompt must be accepted on the Android device before the capability is advertised.
- Wi-Fi-only devices without telephony will not advertise `sms.send`.

## System commands (node host / mac node)

The macOS node exposes `system.run` and `system.notify`. The headless node host
exposes `system.run` and `system.which`.

Examples:

```bash
clawdbot nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
clawdbot nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

Notes:
- `system.run` returns stdout/stderr/exit code in the payload.
- `system.notify` respects notification permission state on the macOS app.
- `system.run` supports `--cwd`, `--env KEY=VAL`, `--command-timeout`, and `--needs-screen-recording`.
- `system.notify` supports `--priority <passive|active|timeSensitive>` and `--delivery <system|overlay|auto>`.
- On macOS node mode, `system.run` is gated by exec approvals in the macOS app (Settings → Exec approvals).
  Ask/allowlist/full behave the same as the headless node host; denied prompts return `SYSTEM_RUN_DENIED`.
- On headless node host, `system.run` is gated by exec approvals (`~/.clawdbot/exec-approvals.json`).

## Exec node binding

When multiple nodes are available, you can bind exec to a specific node.
This sets the default node for `exec host=node` (and can be overridden per agent).

Global default:

```bash
clawdbot config set tools.exec.node "node-id-or-name"
```

Per-agent override:

```bash
clawdbot config get agents.list
clawdbot config set agents.list[0].tools.exec.node "node-id-or-name"
```

Unset to allow any node:

```bash
clawdbot config unset tools.exec.node
clawdbot config unset agents.list[0].tools.exec.node
```

## Permissions map

Nodes may include a `permissions` map in `node.list` / `node.describe`, keyed by permission name (e.g. `screenRecording`, `accessibility`) with boolean values (`true` = granted).

## Headless node host (cross-platform)

Clawdbot can run a **headless node host** (no UI) that connects to the Gateway
bridge and exposes `system.run` / `system.which`. This is useful on Linux/Windows
or for running a minimal node alongside a server.

Start it:

```bash
clawdbot node start --host <gateway-host> --port 18790
```

Notes:
- Pairing is still required (the Gateway will show a node approval prompt).
- The node host stores its node id + pairing token in `~/.clawdbot/node.json`.
- Exec approvals are enforced locally via `~/.clawdbot/exec-approvals.json`
  (see [Exec approvals](/tools/exec-approvals)).
- Add `--tls` / `--tls-fingerprint` when the bridge requires TLS.

## Mac node mode

- The macOS menubar app connects to the Gateway bridge as a node (so `clawdbot nodes …` works against this Mac).
- In remote mode, the app opens an SSH tunnel for the bridge port and connects to `localhost`.
