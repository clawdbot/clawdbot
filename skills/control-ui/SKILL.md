---
name: control-ui
description: "Operate and troubleshoot the OpenClaw Control UI: navigate connected clients, organize sessions, build session dashboards, and handle direct or Tailscale-hosted Gateways."
user-invocable: true
---

# Control UI

Use OpenClaw's typed UI tools for state and layout. Use browser automation only
to inspect or interact with rendered pixels.

## Mental model

- A sidebar item is a **session**, not a dashboard page.
- Each session owns one board. The board contains tabs and widgets.
- Pinning a session keeps it in the sidebar. Sessions with a stored board appear
  in the `/dashboards` gallery.
- `screen` changes connected Control UI layout and navigation. It does not read
  the page or take screenshots.
- `sessions_list` finds sessions. `sessions` renames, groups, pins, or archives
  them. It does not edit board content.
- `dashboard` reads and arranges the current session's board and registered
  plugin widgets. `show_widget` authors or updates custom HTML/SVG widgets.

Do not replace these operations with shell calls or raw Gateway RPC when the
typed tool exists.

## Start safely

1. Identify the target session and whether the Control UI is local/direct or
   published through Tailscale or another HTTPS proxy.
2. Read current state before changing it:
   - use `sessions_list` to resolve the session;
   - use `dashboard` with `action: "read"` for the current session;
   - inspect existing tabs, stable widget names, owners, sizes, and panel layout.
3. If the task targets another session's board, move the work into that session.
   Dashboard tools intentionally operate on the current session.

Read [hosting.md](references/hosting.md) before opening or repairing a remote
Control UI. Read [dashboards.md](references/dashboards.md) before creating or
restructuring a board.

## Navigate and arrange the UI

Use `screen` for deterministic client commands:

- `navigate` to open a session by `sessionKey`;
- `sidebar_show` / `sidebar_hide` for the session sidebar;
- `split_right` / `split_down`, `focus`, and `close_pane` for panes;
- `terminal_show` / `terminal_hide` and `browser_show` / `browser_hide` for
  docked panels.

`screen` broadcasts to every connected Control UI that advertises UI commands;
it cannot select one browser tab. Confirm the blast radius when several clients
may be open. If it reports no capable client, ask the user to open the Control
UI and retry.

Use the in-app browser or an available browser-control tool when the task needs
DOM inspection, clicking, typing, or screenshots. Reuse the existing signed-in
Control UI tab when possible.

## Build a session dashboard

1. Call `dashboard read`. Reuse suitable tabs and widget names.
2. Create or rename tabs with `tab_create` / `tab_update`; use short lowercase
   slug IDs.
3. Add content with the correct owner:
   - custom HTML/SVG or registered-source content: `show_widget` with
     `pin: true`;
   - trusted plugin widgets: `dashboard widget_put` with an advertised
     `pluginKind`.
4. Use a stable `name` when calling `show_widget`. Reusing the same name with
   new `widget_code` updates the widget in place.
5. Arrange with `widget_move`, `widget_resize`, and tab reordering. Prefer size
   presets and board order over pixel placement.
6. Pin the current session with `sessions patch` when it should stay prominent.
7. Call `dashboard focus_tab` to show the intended tab in the dashboard side
   panel. If no Control UI is connected, the command returns unavailable; have
   the user open the session and retry.
8. Choose the presentation after focusing the tab. `set_presentation` with
   `presentation: "expanded"` expands the dashboard; `"split"` shows it beside
   chat in the current panel layout. The human can use
   **Expand side panel** for a full-width dashboard, **Collapse** to bring chat
   back, or close the panel for chat alone.

Never create a fake top-level page for a dashboard. For a dedicated dashboard,
use a dedicated session, pin that session, and build its board from inside it.

## Update without breaking the board

- Read first and mutate the smallest unit.
- Keep stable tab IDs and widget names unless replacement is intentional.
- Do not change a widget's content owner in place. Remove it, then recreate it
  with the new owner or registered kind.
- Capability grants are bound to exact widget bytes and revision. Changed
  content may require approval again.
- Resetting a conversation preserves its board. Deleting the session deletes
  the board.

## Verify the result

Use two layers of proof:

1. **State:** `dashboard read` shows the expected tabs, widgets, names, owners,
   order, and sizes; `sessions_list` shows the expected session
   metadata.
2. **Rendered UI:** open the actual Control UI, confirm the correct session and
   dashboard panel, then inspect or screenshot the widget frame. Exercise any
   important controls.

An HTTP 200 for the shell or widget route is transport proof, not visual proof.
Do not claim the dashboard works until the sandboxed frame renders.

## Recovery order

When a widget is blank or stale:

1. confirm the expected session, tab, widget name, and revision with
   `dashboard read`;
2. classify the hosting path using [hosting.md](references/hosting.md);
3. verify the Control UI origin and the separate widget sandbox origin;
4. after a Gateway restart or routing change, republish/update the widget so the
   browser receives a fresh ticketed frame URL;
5. reload the Control UI and verify the rendered frame, not only route status.
