---
summary: "Let an agent arrange the connected Control UI"
title: "Screen"
sidebarTitle: "Screen"
read_when:
  - You want an agent to split, focus, close, or navigate Control UI panes
  - You want an agent to show or hide the sidebar, terminal, or browser panels
  - You need the ui.command capability and fan-out contract
---

The `screen` tool lets an agent arrange the browser-based Control UI. It is a
typed layout and navigation surface, not screenshot capture or browser
automation.

The tool is exposed only when the originating client advertises the
`ui-commands` capability. At least one capable Control UI must still be
connected when the tool runs; otherwise the Gateway returns `UNAVAILABLE`.

## Actions

| Action                            | Effect                                     | Optional inputs                                |
| --------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| `split_right`                     | Split the target session pane to the right | `sessionKey` (defaults to the current session) |
| `split_down`                      | Split the target session pane downward     | `sessionKey` (defaults to the current session) |
| `close_pane`                      | Close the target session pane              | `sessionKey` (defaults to the current session) |
| `focus`                           | Focus the target session pane              | `sessionKey` (defaults to the current session) |
| `navigate`                        | Open the target session                    | `sessionKey` (defaults to the current session) |
| `sidebar_show` / `sidebar_hide`   | Show or hide the main sidebar              | -                                              |
| `terminal_show` / `terminal_hide` | Show or hide the operator terminal panel   | `dock` (`bottom` or `right`) when showing      |
| `browser_show` / `browser_hide`   | Show or hide the browser panel             | `dock` (`bottom` or `right`) when showing      |

A successful command returns `{ "ok": true }` after the Gateway broadcasts
the typed `ui.command` event.

## Routing and security

Protocol v1 intentionally sends the command to every connected Control UI that
advertises `ui-commands`; it does not target one browser tab. This matters when
the same operator has several dashboards open.

The Gateway RPC requires `operator.write`. The tool can change presentation
state only: it cannot read pixels, take screenshots, click arbitrary page
content, or bypass the permissions of the selected session and operator
panels.

## Related

- [Control UI](/web/control-ui)
- [Gateway protocol](/gateway/protocol#method-families)
- [Browser tool](/tools/browser)
