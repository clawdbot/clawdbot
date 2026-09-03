---
summary: "Session dashboards: agent-built widgets, boards, tabs, and the dashboard side panel"
read_when:
  - Using or explaining session dashboards in the Control UI
  - Deciding what agents can do on a board and what needs an operator grant
title: "Session Dashboards"
---

Every thread in the Control UI can own a **dashboard** — a grid of live widgets
your agent builds for you. A thread with no widgets is just chat. When its first
widget is pinned, the dashboard opens beside the conversation in a resizable
side panel. Use **Expand side panel** to give the dashboard the full task area,
**Collapse** to return to the split layout, or close the panel to return to chat
alone. Later widget updates leave your current panel layout unchanged.

There is nothing to set up and no separate app to configure: dashboards are a
core feature, owned by the thread, stored with the agent, and they survive
`/new` and `/reset` (the conversation context clears; the board stays).

## Find your dashboards

Open `/dashboards` to browse dashboard-enabled threads as a card gallery. Search
by thread or author, filter by author, and sort by recent activity or title.
Select a card to open its owning chat with the dashboard panel expanded. An open
Dashboards page updates as threads are renamed, archived, or deleted, including
after a Gateway reconnect.
If a refresh fails, the page keeps the last loaded dashboards visible with a
stale-data warning. Choose **Retry** to load the list again.

The dashboard and its server-side thread preference follow you when you connect
to the same Gateway from another device. The active dashboard tab and side-panel
layout remain per-device UI state, so each browser can keep its own working
layout.

## Build a dashboard by asking

Watch Patrick Erichsen build an OpenClaw 2.0 release dashboard from one prompt:

<iframe
  style={{ width: "100%", height: "auto", aspectRatio: "16 / 9", border: 0, borderRadius: "8px" }}
  src="https://www.youtube-nocookie.com/embed/gHyBueWideg"
  title="Build an OpenClaw Dashboard with One Prompt"
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
  referrerPolicy="strict-origin-when-cross-origin"
  allowFullScreen
></iframe>

Ask your agent for what you want to see:

> Create a widget named revenue-graph: an interactive bar chart of monthly
> revenue. Add "Bars" and "Trend" buttons that switch views. Pin it to my
> dashboard.

The agent renders the widget inline in the chat first, so you can look at it
before it goes anywhere. From there:

- **You pin it**: hover an inline widget and choose **Pin to dashboard**.
- **Or the agent pins it** directly when you ask, and updates it later by
  name — widgets have stable names, so "update revenue-graph with June's
  numbers" replaces the content in place while the board stays put.

The first dashboard created for the current thread opens in the side panel once.
Updates after that do not reopen the panel or take focus from your current work.

Widgets are self-contained little apps (HTML/JS/SVG in a hard sandbox). Buttons
and view toggles inside a widget work immediately — switching a chart view
never needs the agent.

## The board

- **Fluid grid.** Drag widgets by their handle; everything reflows and
  compacts automatically. Resize by handle or pick a size preset (small,
  medium, large, extra large) from the widget menu. Nobody places pixels —
  not you, not the agent. On narrow boards, widgets stack at full width in
  their saved order; widening the board restores their saved column widths.
- **Automatic height.** HTML widgets adjust their height to fit their content.
  Resizing by handle or choosing a size preset fixes the height. Choose
  **Auto height** from the widget menu to fit the content again.
- **Tabs.** A board can have several pages — say, an overview tab and a
  focused tab with one big widget. Each tab remembers its widget layout.
- **Dashboard panel.** The board shares the task area with its owning chat and
  resizes like other side panels. Expand it for a dashboard-only view, choose
  **Collapse** to bring the chat back beside it, or close it for chat alone.
- **Agent parity.** The agent's `dashboard` tool creates or updates trusted
  plugin widgets, moves, resizes, and removes widgets, manages tabs, switches
  the visible tab, and requests a split or expanded dashboard. The `show_widget` tool
  creates or refreshes custom HTML and registered-source widgets; updating an
  existing widget uses `pin: true`, the same `name`, and new `widget_code`.
  Board snapshots identify each widget's `contentOwner` and, when applicable,
  `registeredContentKind`; remove a widget before replacing its content owner
  or registered source kind.
  Ask "show the finance tab and expand the dashboard" and watch it happen.

  Switching the visible tab or dashboard presentation requires a connected
  Control UI. If none is connected, the command returns `UNAVAILABLE`; open the
  Control UI and retry.

## What widgets are allowed to do

A widget that only renders needs no approval — it appears instantly, exactly
like inline chat widgets, and its network access is fully disabled.

Widgets that want **reach** must declare it. An explicit [session permission mode](/gateway/permission-modes)
decides what happens: **Full access** grants immediately; **Workspace** uses an
AI reviewer and rejects anything it does not allow; **Guarded** shows an
**Allow** / **Reject** card; **Read only** rejects the request. Without an
explicit session mode, the equivalent configured exec approval policy applies.

- **Network** (`net`): fetch declared HTTPS origins directly from the sandbox —
  a weather card that refreshes itself from an API, for example.
- **Gateway data** (`data`): read-only feeds like sessions, usage, or cron
  status, resolved by the gateway — the widget never holds your token.
- **Automation** (`actions`): trigger a specific cron job, so a button can run
  a real task (which may use a smaller model) without waking your main
  conversation.
- **Prompt** (`prompt`): send messages into your thread without the per-click
  confirmation that unapproved widgets require.

Enabled plugins can add their own named read-only feeds and actions to these capability lists; disabling the plugin removes those integrations.

Grants are bound to the exact widget bytes approved by your session policy.
Changed HTML or registered-source bytes require a new decision even when the
permissions stay the same or shrink. A grant is preserved only when the
approved bytes still match and the requested permissions do not widen.
The authoring result distinguishes pending, rejected, and granted access;
saving a widget does not imply its capabilities were approved.
Widget interactions the agent should know about (filters you clicked, views
you switched) reach it quietly as session notices — it stays informed without
being interrupted.

## MCP apps on the board

If your gateway has MCP servers configured, interactive MCP apps that appear
in chat can be pinned like any widget. Pinned apps come back to life on the
board with fresh sessions. By default they render without server tools or
same-server resource access. Granting the widget its declared server tools
enables both bridges while that revision-bound grant remains active.

## A2UI widgets

When the Canvas plugin is enabled, agents can render A2UI JSONL as a dashboard
widget. A2UI widgets use the same stable name, tab, size, pinning, sandbox, and
update-in-place behavior as HTML widgets. The renderer is loaded from the
Gateway's `/__openclaw__/a2ui/` asset route, so the renderer bundle is not
copied into each widget. The Canvas plugin and its hosted routes must be
enabled; both are enabled by default.

A2UI actions use the normal widget bridge. By default, clicks become quiet
session notices that the agent sees on its next turn. If the widget declares
and receives the `prompt` grant, its actions can instead send a visible prompt
into the thread. Disabling the Canvas plugin removes the A2UI kind and leaves
stored widgets visibly unavailable until the plugin is enabled again.

## Retired Workspaces

The experimental Workspaces plugin, its Control UI tab, `openclaw workspaces`
CLI, and `workspace_*` tools have been removed. Session dashboards use a
different storage model: each board belongs to a session and lives in the
owning agent's database. Legacy Workspaces documents and databases are not
automatically converted.

Preserve any legacy documents, data, and widget assets before running
`openclaw doctor --fix`: its Workspaces repair deletes identified legacy state
under `<stateDir>/workspaces`, without importing that content into a dashboard.

## Good to know

- Resetting a thread that has a board asks for confirmation and keeps the
  board.
- Deleting a thread deletes its board.
- Boards live on your gateway (in the owning agent's database) and appear on
  every device you connect from.
- Dashboard-enabled threads appear in `/dashboards`. Closing the side panel does
  not delete the dashboard or remove it from the gallery.
- The security model, storage details, and design rationale live in
  [Dashboard Architecture](/web/dashboard-architecture), including the
  documented sandbox tradeoffs.
