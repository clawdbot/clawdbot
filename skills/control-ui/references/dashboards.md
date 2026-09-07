# Dashboard operations

## Ownership map

| Object                  | Tool                        | Notes                                  |
| ----------------------- | --------------------------- | -------------------------------------- |
| Session row             | `sessions_list`, `sessions` | Find, label, group, pin, archive       |
| Board snapshot          | `dashboard read`            | Current session only                   |
| Tabs and layout         | `dashboard`                 | Create, rename, reorder, focus, expand |
| Custom HTML/SVG         | `show_widget`               | Set `pin: true`; update by stable name |
| Trusted plugin widget   | `dashboard widget_put`      | Requires an advertised `pluginKind`    |
| Visible browser state   | Browser-control tool        | Inspect, click, type, screenshot       |
| Client panes and panels | `screen`                    | Commands connected capable clients     |

## Recommended build sequence

1. Read the board.
2. Create tabs only when the existing structure does not fit.
3. Put each widget on its final tab with a stable name.
4. Move and resize after content exists.
5. Pin the session.
6. Focus the intended tab.
7. Choose a split or expanded dashboard panel.
8. Read again, then verify the rendered UI.

The Dashboard tool's focus and presentation commands need a connected Control
UI. They can return unavailable even though board storage is healthy.
`focus_tab` opens the side panel. Call `set_presentation` after focusing the tab:
`presentation: "expanded"` expands it; `"split"` restores a split view using the
current panel layout.

## Choose the owning session

Resolve the owning session before the first dashboard or widget mutation. For a
dedicated sidebar dashboard, create or reuse a visible session and move the work
there first. Board widgets cannot move between sessions, and tabs never create
sidebar rows.

## Choose the content boundary

`show_widget` is for self-contained HTML/SVG. The widget runs in a hard sandbox
that rejects child-frame URL assignments and navigation, so an external
application such as Grafana cannot be made into a dashboard widget by wrapping
it in `<iframe src="...">`. `gateway.controlUi.allowExternalEmbedUrls` governs
hosted transcript embeds; it does not relax the `show_widget` sandbox.

For external or live content, choose one supported boundary:

- add a normal user-clicked HTTPS link, which opens outside the widget;
- fetch an exact HTTPS API declared in `capabilities.netOrigins` and render the
  returned data in the widget;
- use an advertised Gateway data binding; or
- use a trusted plugin widget when the integration needs host privileges.

Do not weaken `embedSandbox` or expose an authenticated application just to make
a nested iframe render.

## Updating content

For a custom widget, call `show_widget` again with:

- `pin: true`;
- the same explicit `name`;
- the replacement `widget_code`;
- the existing tab and intended size.

This updates content without discarding the widget's board position. A content
change creates a new revision and may invalidate prior capability approval.

Use `dashboard widget_put` only for registered plugin kinds. It is not a second
HTML-authoring path.

## Dashboard panel and sidebar behavior

The session is the durable sidebar object. A board is not a separate session or
navigation page.

- `sessions patch` can pin and organize the session.
- `dashboard focus_tab` broadcasts a focus command. A connected Control UI
  opens the dashboard panel and saves the session's dashboard preference.
- **Expand side panel** fills the task area; **Collapse** brings chat back beside
  the dashboard. Closing the panel returns to chat alone.
- Sessions with a stored board appear in the `/dashboards` gallery, regardless
  of their saved view. Selecting a card opens its owning chat with the dashboard
  panel expanded.

The active tab and side-panel layout are per-device UI state. The dashboard
preference is server-side session state.

## Verification checklist

- Correct session key and label.
- Expected dashboard panel and tab.
- Stable widget names, correct owners, and current revisions.
- Layout is usable at desktop and narrow widths when relevant.
- Widget frame loaded; no sandbox-origin or ticket error.
- Every live-data origin is declared and granted in
  `capabilities.netOrigins`; browser requests complete without CSP, CORS,
  certificate, or mixed-content errors.
- External links open intentionally; the widget does not rely on a nested
  external iframe.
- Interactive controls perform their intended action.
- Capability prompts or grants match the widget's declared needs.
- Dedicated dashboards appear as the intended pinned session row; a tab name
  alone is not sidebar proof.

Source documentation:

- `docs/web/dashboards.md`
- `docs/web/dashboard-architecture.md`
- `docs/tools/screen.md`
- `docs/tools/show-widget.md`
