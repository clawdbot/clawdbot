---
summary: "Present hosted widgets in the macOS panel"
read_when:
  - Showing an agent-created widget on a Mac
  - Controlling the macOS widget panel from a paired node
  - Debugging hosted widget navigation
title: "Widget panel"
doc-schema-version: 1
---

The macOS app includes a native panel for presenting hosted widget documents.
The Canvas plugin owns this presentation path; it is not a standalone visual
workspace or an A2UI push target.

The recommended agent path is [`show_widget`](/tools/show-widget) with
`presentation.target: "node_panel"`. OpenClaw stores the widget as a hosted
document, selects a connected macOS node, opens the panel, and navigates it to
that document. If no eligible Mac is connected or presentation fails, the
widget still appears inline in chat and the tool result explains how to retry.

Widgets in the native panel are render-only. Host-integrated widget actions
remain available in Control UI chat and [session dashboard](/web/dashboards)
surfaces, not in the panel.

## Panel behavior

- The panel is borderless, resizable, and anchored near the menu bar or mouse
  cursor.
- Presenting a widget does not switch apps or take keyboard focus.
- Only one widget panel is visible at a time.
- The app remembers the panel's size and position per session.

Canvas can be disabled from **Settings -> Allow Canvas**. When it is disabled,
panel commands return `CANVAS_DISABLED`.

## Agent path

Ask the agent to use `show_widget` and target the node panel. The tool exposes
`node_panel` only while a widget presenter plugin is active.

```json
{
  "title": "Build status",
  "widget_code": "<main><h1>Build passed</h1></main>",
  "presentation": { "target": "node_panel" }
}
```

The result identifies the selected Mac when presentation succeeds. OpenClaw
currently selects only a connected macOS node that declares `canvas.present`.

## Node commands

The paired-node command surface contains three commands:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> "/__openclaw__/canvas/documents/<document-id>/index.html"
openclaw nodes canvas hide --node <id>
```

- `canvas.present` shows the panel. It also accepts the existing optional
  target and placement arguments.
- `canvas.navigate` loads a hosted widget-document path or an app-local Canvas
  URL.
- `canvas.hide` hides the panel without changing its current document.

Hosted paths under `/__openclaw__/canvas/` are resolved through the node
session's current scoped `pluginSurfaceUrls.canvas` URL. The app refreshes that
short-lived capability before navigation; callers should pass the document
path, not construct or copy a capability URL.

The app-local scheme remains available for app-owned content:

```text
openclaw-canvas://<session>/<path>
```

Files addressed by that scheme must remain inside the session's Canvas root in
Application Support. Directory traversal is blocked.

## A2UI belongs on session dashboards

A2UI widgets render on [session dashboards](/web/dashboards), where they share
the same pinning, layout, approval, and interaction model as other dashboard
widgets. Their renderer bundles continue to load from the Gateway's
`/__openclaw__/a2ui/` asset route.

The macOS panel does not accept A2UI push/reset commands and does not
automatically navigate to an A2UI page.

## Migrating documents from a custom root

Run `openclaw doctor --fix` to move documents from the retired
`plugins.entries.canvas.config.host.root` (or the older `canvasHost.root`) into
the state directory's `canvas/documents` folder. An explicit plugin root takes
precedence over the older setting. Doctor removes the root setting only after no
legacy documents remain. If directory access or a document copy fails, doctor
warns and retains the source locator for retry. It may move the older setting
into the plugin config while preserving the path. A root that already points to
canonical storage, including through a symlink, needs no copy.

Fix the reported permissions or target conflict, then rerun the command; do not
remove the root setting yourself. Hosted routes serve only the canonical folder,
so remaining legacy documents are unavailable until migration completes.

## Related

- [Show widget](/tools/show-widget)
- [Session dashboards](/web/dashboards)
- [macOS app](/platforms/macos)
- [Nodes](/nodes)
