---
summary: "Agent-composable Workspaces in the Control UI"
read_when:
  - Building or rearranging workspace tabs and widgets
  - Letting an agent compose a workspace
  - Reviewing the custom-widget approval and sandbox model
title: "Workspaces"
---

The **Workspaces** tab in the [Control UI](/web/control-ui) is a surface you and your
agents arrange together. Tabs, widgets, their positions on a 12-column grid, and their
data bindings all live in one document. Anything that can edit that document can compose
the workspace: you, the `openclaw workspaces` CLI, or an agent calling `workspace_*` tools.

Every write goes through the same validated path, so a human's layout and an agent's
layout cannot diverge. Each accepted write bumps a version and broadcasts
`plugin.workspaces.changed`, so an agent's edit appears in an already-open browser without
a reload.

## Enable Workspaces

The bundled Workspaces plugin is disabled by default. In the Control UI, open **Plugins**,
find **Workspaces**, and select **Enable**. You can also enable it from the CLI:

```sh
openclaw plugins enable workspaces
```

Enabling the plugin adds the **Workspaces** tab and makes the `openclaw workspaces` CLI
and `workspace_*` agent tools available. Disabling it removes those surfaces without
deleting the workspace database or widget assets.

## The default workspace

On first load you get an **Overview** workspace: cost and token cards, instance health,
sessions, cron status, and an activity feed. It is ordinary workspace content — drag it,
collapse it, hide it, or delete it.

## Built-in widgets

Thirteen trusted widgets ship with the plugin and render as first-party UI:

`stat-card`, `markdown`, `table`, `iframe-embed`, `sessions`, `usage`, `cron`,
`instances`, `activity`, `chart`, `preview`, `agent-status`,
`custom-widget-approvals`.

The `chart` widget renders dependency-free inline SVG as `line`, `bar`, `area`,
`sparkline`, or `gauge`. Bind `value` to a numeric array or to an object shaped like
`{ "points": [1, { "y": 2 }, { "value": 3 }] }`. Set `props.type` to select the
visual and optionally set finite numeric `props.min` and `props.max` bounds. Invalid
types, bounds, points, and series longer than 500 entries render a safe error state;
empty series render an empty state.

The `preview` widget embeds a live page with reload plus desktop, tablet, and mobile
viewport controls. Set `props.url`, or bind `value` to a URL when the preview target is
data-driven; a binding takes precedence over the prop. Relative and same-origin HTTP(S)
URLs are allowed. External HTTP(S) URLs follow the gateway's external-embed policy, and
other schemes are blocked. Preview frames share the `iframe-embed` sandbox ceiling and
never receive same-origin access.

The `agent-status` widget presents the current Busy or Idle state from a
`sessions.list` RPC binding. Session-list events refresh it immediately, while the normal
visibility-gated binding poll remains a fallback. The `custom-widget-approvals` widget
lists only pending entries from the Workspaces custom-widget registry. Its Approve and
Reject controls are disabled unless the current connection holds `operator.approvals`;
it does not expose exec, plugin, or system-agent approvals.

Tabs use the 12-column widget grid by default. A tab containing zero or one widget can
instead use the `full` layout, which removes the widget card chrome and lets the widget
fill the tab. Switch layouts with `openclaw workspaces tabs full <slug>` and
`openclaw workspaces tabs grid <slug>`.

Widgets declare data through **bindings**, they never fetch on their own:

| Binding  | Resolves to                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------- |
| `static` | A literal value stored in the document (8 KB max).                                                        |
| `file`   | A JSON, Markdown, or CSV file under `<stateDir>/workspaces/data/`, optionally narrowed by a JSON pointer. |
| `rpc`    | One of a fixed allowlist of read-only gateway methods, resolved by the trusted Control UI.                |

The `file` binding is the simplest way to put your own numbers in a workspace: write a
JSON file into the data directory and point a `stat-card` at it.

## Provenance

Tabs and widgets carry a `createdBy` stamp — `user`, `system`, or `agent:<id>` — set from
whoever made the write. It cannot be supplied by the caller, so an agent cannot label its
work as yours, and the "AI" chip on an agent-authored widget always means what it says.

## Custom widgets

An agent can author a real HTML widget with `workspace_widget_scaffold` (or you can, with
`openclaw workspaces widget-scaffold <name>`). Agent-authored code is treated as hostile:

- A scaffolded widget enters the registry as **pending**. No iframe is created, and the
  asset route returns 404 for its files, until an operator approves it.
- Approval is a separate decision from editing a layout: `workspaces.widget.approve`
  requires the `operator.approvals` scope, the same scope that guards exec approvals.
- An approved widget renders in an `<iframe sandbox="allow-scripts">` — never
  `allow-same-origin` — so its origin is opaque and it cannot reach the parent's DOM,
  storage, or cookies.
- Its assets are served with `connect-src 'none'`, blocking script networking such as
  `fetch`, XHR, and WebSockets. It holds no credential and never talks to the gateway.
- Data reaches it only through a versioned `postMessage` bridge. Custom code can receive
  declared `static` bindings, which are already agent- or operator-authored workspace
  values. RPC and file bindings stay in trusted built-in widgets: browsers allow a
  sandboxed child to navigate its own frame, so privileged data is never posted into
  agent-authored HTML.

Sending a prompt into chat from a widget additionally requires a manifest capability, a
per-invocation confirmation quoting the exact text, and passes a rate limit.

## CLI

```sh
openclaw workspaces tabs list
openclaw workspaces tabs create --title Financials
openclaw workspaces tabs full financials
openclaw workspaces widget-scaffold revenue-chart --title "Revenue Chart"
openclaw workspaces widget-approve revenue-chart
```

`widget-approve` and the Control UI decision controls both need a device paired with the
`operator.approvals` scope.

## Storage

The workspace document, the custom-widget registry, and a 20-entry undo ring live in
`<stateDir>/workspaces/workspaces.sqlite`. Agent-authored widget assets stay on disk under
`<stateDir>/workspaces/widgets/<name>/`, and file-binding data under
`<stateDir>/workspaces/data/`, because an agent authors those with ordinary file tools and
the widget route serves their bytes.
