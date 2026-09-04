# Dashboard operations

## Ownership map

| Object                  | Tool                        | Notes                                  |
| ----------------------- | --------------------------- | -------------------------------------- |
| Session row             | `sessions_list`, `sessions` | Find, label, group, pin, archive       |
| Board snapshot          | `dashboard read`            | Current session only                   |
| Tabs and layout         | `dashboard`                 | Create, rename, reorder, focus, dock   |
| Custom HTML/SVG         | `show_widget`               | Set `pin: true`; update by stable name |
| Trusted plugin widget   | `dashboard widget_put`      | Requires an advertised `pluginKind`    |
| Visible browser state   | Browser-control tool        | Inspect, click, type, screenshot       |
| Client panes and panels | `screen`                    | Commands connected capable clients     |

## Recommended build sequence

1. Read the board.
2. Create tabs only when the existing structure does not fit.
3. Put each widget on its final tab with a stable name.
4. Move and resize after content exists.
5. Configure the chat dock.
6. Pin the session.
7. Focus the intended tab.
8. Read again, then verify the rendered UI.

The Dashboard tool's focus and dock commands need a connected Control UI. They
can return unavailable even though board storage is healthy.

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

## Face and sidebar behavior

The session is the durable sidebar object. A board is not a separate session or
navigation page.

- `sessions patch` can pin and organize the session.
- `dashboard focus_tab` broadcasts a focus command. A connected Control UI
  switches to Dashboard and persists the face preference for that session.
- The human can also choose Chat, Split, or Dashboard in the session header.
- Sessions whose stored preference is Dashboard appear under `/dashboards`.

The active tab and remembered dock placement are per-device UI state. The
Chat/Dashboard preference is server-side session state.

## Verification checklist

- Correct session key and label.
- Expected Dashboard face and tab.
- Stable widget names, correct owners, and current revisions.
- Layout is usable at desktop and narrow widths when relevant.
- Widget frame loaded; no sandbox-origin or ticket error.
- Interactive controls perform their intended action.
- Capability prompts or grants match the widget's declared needs.

Source documentation:

- `docs/web/dashboards.md`
- `docs/web/dashboard-architecture.md`
- `docs/tools/screen.md`
- `docs/tools/show-widget.md`
