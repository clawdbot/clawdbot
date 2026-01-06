---
summary: "Agent-controlled Canvas panel embedded via WKWebView + custom URL scheme"
read_when:
  - Implementing the macOS Canvas panel
  - Adding agent controls for visual workspace
  - Debugging WKWebView canvas loads
---

# Canvas (macOS app)

Status: draft spec · Date: 2025-12-12

Note: for iOS/Android nodes that should render agent-edited HTML/CSS/JS over the network, prefer the Gateway `canvasHost` (serves `~/clawd/canvas` over LAN/tailnet with live reload). A2UI is also **hosted by the Gateway** over HTTP. This doc focuses on the macOS in-app canvas panel. See `docs/configuration.md`.

Clawdbot can embed an agent-controlled “visual workspace” panel (“Canvas”) inside the macOS app using `WKWebView`, served via a **custom URL scheme** (no loopback HTTP port required).

This is designed for:
- Agent-written HTML/CSS/JS on disk (per-session directory).
- A real browser engine for layout, rendering, and basic interactivity.
- Agent-driven visibility (show/hide), navigation, DOM/JS queries, and snapshots.
- Minimal chrome: borderless panel; bezel/chrome appears only on hover.

## Why a custom scheme (vs. loopback HTTP)

Using `WKURLSchemeHandler` keeps Canvas entirely in-process:
- No port conflicts and no extra local server lifecycle.
- Easier to sandbox: only serve files we explicitly map.
- Works offline and can use an ephemeral data store (no persistent cookies/cache).

If a Canvas page truly needs “real web” semantics (CORS, fetch to loopback endpoints, service workers), consider the loopback-server variant instead (out of scope for this doc).

## URL ↔ directory mapping

The Canvas scheme is:
- `clawdbot-canvas://<session>/<path>`

Routing model:
- `clawdbot-canvas://main/` → `<canvasRoot>/main/index.html` (or `index.htm`)
- `clawdbot-canvas://main/yolo` → `<canvasRoot>/main/yolo/index.html` (or `index.htm`)
- `clawdbot-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`

Directory listings are not served.

When `/` has no `index.html` yet, the handler serves a **built-in scaffold page** (bundled with the macOS app).
This is a visual placeholder only (no A2UI renderer).

### Suggested on-disk location

Store Canvas state under the app support directory:
- `~/Library/Application Support/Clawdbot/canvas/<session>/…`

This keeps it alongside other app-owned state and avoids mixing with `~/.clawdbot/` gateway config.

## Panel behavior (agent-controlled)

Canvas is presented as a borderless `NSPanel` (similar to the existing WebChat panel):
- Can be shown/hidden at any time by the agent.
- Supports an “anchored” presentation (near the menu bar icon or another anchor rect).
- Uses a rounded container; shadow stays on, but **chrome/bezel only appears on hover**.
- Default position is the **top-right corner** of the current screen’s visible frame (unless the user moved/resized it previously).
- The panel is **user-resizable** (edge resize + hover resize handle) and the last frame is persisted per session.

### Hover-only chrome

Implementation notes:
- Keep the window borderless at all times (don’t toggle `styleMask`).
- Add an overlay view inside the content container for chrome (stroke + subtle gradient/material).
- Use an `NSTrackingArea` to fade the chrome in/out on `mouseEntered/mouseExited`.
- Optionally show close/drag affordances only while hovered.

## Agent API surface (current)

Canvas is exposed via the Gateway **node bridge**, so the agent can:
- Show/hide the panel.
- Navigate to a path (relative to the session root).
- Evaluate JavaScript and optionally return results.
- Query/modify DOM (helpers mirroring “dom query/all/attr/click/type/wait” patterns).
- Capture a snapshot image of the current canvas view.
- Optionally set panel placement (screen `x/y` + `width/height`) when showing/navigating.

This should be modeled after `WebChatManager`/`WebChatSwiftUIWindowController` but targeting `clawdbot-canvas://…` URLs.

Related:
- For “invoke the agent again from UI” flows, prefer the macOS deep link scheme (`clawdbot://agent?...`) so *any* UI surface (Canvas, WebChat, native views) can trigger a new agent run. See `docs/macos.md`.

## Agent commands (current)

Use the main `clawdbot` CLI; it invokes canvas commands via `node.invoke`.

- `clawdbot canvas present [--node <id>] [--target <...>] [--x/--y/--width/--height]`
  - Local targets map into the session directory via the custom scheme (directory targets resolve `index.html|index.htm`).
  - If `/` has no index file, Canvas shows the built-in scaffold page and returns `status: "welcome"`.
- `clawdbot canvas hide [--node <id>]`
- `clawdbot canvas eval --js <code> [--node <id>]`
- `clawdbot canvas snapshot [--node <id>]`

### Canvas A2UI

Canvas A2UI is hosted by the **Gateway canvas host** at:

```
http://<gateway-host>:18793/__clawdbot__/a2ui/
```

The macOS app simply renders that page in the Canvas panel. The agent can drive it with JSONL **server→client protocol messages** (one JSON object per line):

- `clawdbot canvas a2ui push --jsonl <path> [--node <id>]`
- `clawdbot canvas a2ui reset [--node <id>]`

`push` expects a JSONL file where **each line is a single JSON object** (parsed and forwarded to the in-page A2UI renderer).

Minimal example (v0.8):

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOF'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, `canvas a2ui push` works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOF

clawdbot canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

Notes:
- This does **not** support the A2UI v0.9 examples using `createSurface`.
- A2UI **fails** if the Gateway canvas host is unreachable (no local fallback).
- `canvas a2ui push` validates JSONL (line numbers on errors) and rejects v0.9 payloads.
- Quick smoke: `clawdbot canvas a2ui push --text "Hello from A2UI"` renders a minimal v0.8 view.

## Triggering agent runs from Canvas (deep links)

Canvas can trigger new agent runs via the macOS app deep-link scheme:
- `clawdbot://agent?...`

This is intentionally separate from `clawdbot-canvas://…` (which is only for serving local Canvas files into the `WKWebView`).

Suggested patterns:
- HTML: render links/buttons that navigate to `clawdbot://agent?message=...`.
- JS: set `window.location.href = 'clawdbot://agent?...'` for “run this now” actions.

Implementation note (important):
- In `WKWebView`, intercept `clawdbot://…` navigations in `WKNavigationDelegate` and forward them to the app, e.g. by calling `DeepLinkHandler.shared.handle(url:)` and returning `.cancel` for the navigation.

Safety:
- Deep links (`clawdbot://agent?...`) are always enabled.
- Without a `key` query param, the app will prompt for confirmation before invoking the agent.
- With a valid `key`, the run is unattended (no prompt). For Canvas-originated actions, the app injects an internal key automatically.

## Security / guardrails

Recommended defaults:
- `WKWebsiteDataStore.nonPersistent()` for Canvas (ephemeral).
- Navigation policy: allow only `clawdbot-canvas://…` (and optionally `about:blank`); open `http/https` externally.
- Scheme handler must prevent directory traversal: resolved file paths must stay under `<canvasRoot>/<session>/`.
- Disable or tightly scope any JS bridge; prefer query-string/bootstrap config over `window.webkit.messageHandlers` for sensitive data.

## Debugging

Suggested debugging hooks:
- Enable Web Inspector for Canvas builds (same approach as WebChat).
- Log scheme requests + resolution decisions to OSLog (subsystem `com.clawdbot`, category `Canvas`).
- Provide a “copy canvas dir” action in debug settings to quickly reveal the session directory in Finder.
