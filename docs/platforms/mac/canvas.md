---
summary: "Agent-controlled Canvas panel embedded via WKWebView + custom URL scheme"
read_when:
  - Implementing the macOS Canvas panel
  - Adding agent controls for visual workspace
  - Debugging WKWebView canvas loads
title: "Canvas"
---

The macOS app embeds an agent-controlled **Canvas panel** using `WKWebView`, a
lightweight visual workspace for HTML/CSS/JS, A2UI, and small interactive UI
surfaces.

## Where Canvas lives

Canvas state is stored under Application Support:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

The Canvas panel serves those files via a custom URL scheme,
`openclaw-canvas://<session>/<path>`:

- `openclaw-canvas://main/` -> `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` -> `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` -> `<canvasRoot>/main/widgets/todo/index.html`

If no `index.html` exists at the root, the app shows a built-in scaffold page.

## Panel behavior

- Borderless, resizable panel anchored near the menu bar (or mouse cursor).
- Remembers size/position per session.
- Auto-reloads when local canvas files change.
- Only one Canvas panel is visible at a time (session switches as needed).

Canvas can be disabled from Settings -> **Allow Canvas**. When disabled,
canvas node commands return `CANVAS_DISABLED`.

## Agent API surface

Canvas is exposed via the Gateway WebSocket, so the agent can show/hide the
panel, navigate to a path or URL, evaluate JavaScript, and capture a
snapshot image:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

`canvas.navigate` accepts local canvas paths, `http(s)` URLs, and `file://`
URLs. Passing `"/"` shows the local scaffold or `index.html`.

Gateway-hosted targets under `/__openclaw__/canvas/` and
`/__openclaw__/a2ui/` are resolved through the node session's current scoped
Canvas URL. The app refreshes that short-lived capability before navigation;
you do not need to construct or copy a capability URL yourself.

## A2UI in Canvas

A2UI is hosted by the Gateway canvas host and rendered inside the Canvas
panel. When the Gateway advertises a Canvas host, the macOS app auto-navigates
to the A2UI host page on first open.

The advertised URL is capability-scoped, for example
`http://<gateway-host>:18789/__openclaw__/cap/<token>/__openclaw__/a2ui/?platform=macos`.
Treat it as ephemeral credentials, not a stable link.

### A2UI commands (v0.8)

Canvas accepts A2UI v0.8 server-to-client messages: `beginRendering`,
`surfaceUpdate`, `dataModelUpdate`, `deleteSurface`. `createSurface` (v0.9) is
not supported yet.

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

Quick smoke test:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Triggering agent runs from Canvas

Canvas can trigger new agent runs via `openclaw://agent?...` deep links:

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

Supported query parameters:

| Parameter                  | Meaning                                               |
| -------------------------- | ----------------------------------------------------- |
| `message`                  | Prefilled agent prompt.                               |
| `sessionKey`               | Stable session identifier.                            |
| `thinking`                 | Optional thinking profile.                            |
| `deliver`, `to`, `channel` | Delivery target.                                      |
| `timeoutSeconds`           | Optional run timeout.                                 |
| `key`                      | App-generated safety token for trusted local callers. |

The app prompts for confirmation unless a valid key is provided. Unkeyed
links show the message and URL before approval, and ignore delivery routing
fields; keyed links use the normal Gateway run path.

## Security notes

- Canvas scheme blocks directory traversal; files must live under the session root.
- Local Canvas content uses a custom scheme (no loopback server required).
- External `http(s)` URLs are allowed only when explicitly navigated.
- Ordinary web pages are render-only. Agent actions are accepted only from the
  app-owned Canvas scheme or the exact capability-scoped Gateway A2UI document
  selected by the app; subframes, redirects, stale capabilities, and changed
  queries cannot dispatch actions.

## Related

- [macOS app](/platforms/macos)
- [WebChat](/web/webchat)
