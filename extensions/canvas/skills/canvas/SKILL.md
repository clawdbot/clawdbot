---
name: canvas
description: "Present hosted widget documents on a connected macOS panel and control panel visibility or navigation."
metadata: { "openclaw": { "emoji": "🖼️" } }
---

# Widget panel

Use `show_widget` with `presentation.target: "node_panel"` to create a hosted widget document and present it on an eligible connected Mac. This is the normal agent path.

The Canvas tool is limited to direct panel control:

- `present`: show the panel, optionally with a hosted document path or local app scheme.
- `hide`: hide the panel.
- `navigate`: navigate the visible panel to a hosted document path or local app scheme.

Do not invent local file paths or arbitrary external URLs. Hosted documents use the capability-scoped `/__openclaw__/canvas/documents/...` route returned by `show_widget`. A2UI content renders on session boards and loads renderer assets from `/__openclaw__/a2ui`.

If `plugins.entries.canvas.config.host.enabled` is `false`, hosted widget documents, A2UI renderer assets, and node-panel presentation are disabled together.
