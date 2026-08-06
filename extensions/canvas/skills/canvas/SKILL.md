---
name: canvas
description: "Present HTML on connected OpenClaw node canvases, navigate/eval/snapshot, and debug canvas host URLs."
metadata: { "openclaw": { "emoji": "🖼️" } }
---

# Canvas

Use canvas to show HTML on connected Mac/iOS/Android nodes.

## Model

- Canvas host serves files from `plugins.entries.canvas.config.host.root`.
- Canvas routes live on the Gateway HTTP port (`gateway.port`, default `18789`).
- Node bridge sends canvas URLs to connected node apps.
- Node apps render URLs in a WebView.
- Host name follows `gateway.bind`: loopback local only, LAN IP for LAN, Tailscale host for tailnet, auto picks best route.
- Localhost URLs only work for a node on the same machine.
- Paired nodes normally receive node-scoped `pluginSurfaceUrls.canvas` capability URLs; prefer those when available.

## Config

Active config: `$OPENCLAW_CONFIG_PATH` or `~/.openclaw/openclaw.json`.

```json
{
  "plugins": {
    "entries": {
      "canvas": {
        "config": {
          "host": {
            "enabled": true,
            "root": "~/.openclaw/canvas",
            "liveReload": true
          }
        }
      }
    }
  },
  "gateway": { "bind": "auto" }
}
```

## Actions

- `present`: show canvas, optional URL.
- `hide`: hide canvas.
- `navigate`: open new URL.
- `eval`: run JavaScript in current canvas.
- `snapshot`: capture screenshot.

## Workflow

1. Ensure Canvas plugin host is enabled.
2. Put HTML/CSS/JS under `plugins.entries.canvas.config.host.root` or the default state canvas dir.
3. Use a route reachable by the target node.
4. Present the hosted URL: `/__openclaw__/canvas/<file>.html`.
5. Use `snapshot` when the user needs proof.

## URL shape

```text
http://<gateway-host>:<gateway.port>/__openclaw__/canvas/index.html
http://<gateway-host>:<gateway.port>/__openclaw__/canvas/games/snake.html
```

Path mapping:

- `/__openclaw__/canvas/index.html` -> `<canvas host root>/index.html`
- `/__openclaw__/canvas/games/snake.html` -> `<canvas host root>/games/snake.html`

## Troubleshooting

- Node sees localhost but is remote: fix `gateway.bind` or public URL, regenerate URL.
- LAN node cannot load: verify same network, firewall, Gateway port, and auth/capability URL.
- Tailnet node cannot load: verify Tailscale status and advertised host.
- Blank page: open URL locally, check browser console, then snapshot node.
- Live reload missing: verify `liveReload` and file write under root.
