---
summary: "Session dashboards: agent-built widgets, boards, tabs, and the docked chat"
read_when:
  - Using or explaining session dashboards in the Control UI
  - Deciding what agents can do on a board and what needs an operator grant
title: "Session Dashboards"
---

Every thread in the Control UI has two faces: the conversation you know, and a
**dashboard** — a grid of live widgets your agent builds for you. A thread with
no widgets is just chat. The moment a widget is pinned, a **Chat | Split |
Dashboard** switch appears in the header: Chat is the conversation alone, Split
shows the dashboard with your chat docked beside it, and Dashboard gives the
board the whole surface.

There is nothing to set up and no separate app to configure: dashboards are a
core feature, owned by the thread, stored with the agent, and they survive
`/new` and `/reset` (the conversation context clears; the board stays).

## Find your dashboards

Open `/dashboards` to see every thread whose preferred face is Dashboard, with
the most recently updated thread first. Open any row to go directly to that
thread's `/dashboard/<agent>/<sessionRef>` URL. An open Dashboards page updates
as threads are renamed, archived, deleted, or switched between Chat and
Dashboard, including after a Gateway reconnect.

Use **Open dashboard in focus mode** on a row to open its board as a standalone
browser document at `/focus/dashboard/<agent>/<sessionRef>`, with no sidebar,
top bar, or chat. This focus presentation does not invoke browser fullscreen;
the close button returns to the previous page. Inside a session, use the
fullscreen button beside the Chat / Split / Dashboard switch to enter or leave
browser fullscreen while the board is visible.

The Chat or Dashboard face preference is stored server-side per thread. It
therefore follows you when you connect to the same gateway from another device.
Opening a thread from the sidebar, Sessions, Tasks, Workboard, or Worktrees
applies that stored face even when the thread is outside the page of sessions
already loaded by the browser.
The active dashboard tab and remembered chat-dock position remain per-device UI
state, so each browser can keep its own working layout.

## Build a dashboard by asking

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

Widgets are self-contained little apps (HTML/JS/SVG in a hard sandbox). Buttons
and view toggles inside a widget work immediately — switching a chart view
never needs the agent.

## The board

- **Fluid grid.** Drag widgets by their handle; everything reflows and
  compacts automatically. Resize by handle or pick a size preset (small,
  medium, large, extra large) from the widget menu. Nobody places pixels —
  not you, not the agent.
- **Tabs.** A board can have several pages — say, an overview tab and a
  focused tab with one big widget. Each tab remembers its own chat-dock
  position.
- **Docked chat.** In Split, your conversation docks to the left, right, or
  bottom — pick the side from the small arrow on the header switch — and
  resizes like the sidebar. Choose Dashboard to hide the chat entirely; the
  agent still hears you when you bring it back.
- **Agent parity.** The agent's `dashboard` tool creates or updates trusted
  plugin widgets, moves, resizes, and removes widgets, manages tabs, switches
  the visible tab, and moves or hides the chat dock. The `show_widget` tool
  creates or refreshes custom HTML and registered-source widgets; updating an
  existing widget uses `pin: true`, the same `name`, and new `widget_code`.
  Board snapshots identify each widget's `contentOwner` and, when applicable,
  `registeredContentKind`; remove a widget before replacing its content owner
  or registered source kind.
  Ask "put the chat on the left and show the finance tab" and watch it happen.

  Switching the visible tab or chat dock requires a connected Control UI. If
  none is connected, the command returns `UNAVAILABLE`; open the Control UI and retry.

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

Grants are bound to the exact widget bytes and revision approved by your session
policy. If the agent changes the widget and asks for _more_ than was approved,
OpenClaw applies that policy again; refreshing content within the same
permissions keeps the grant.
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

## Good to know

- Resetting a thread that has a board asks for confirmation and keeps the
  board.
- Deleting a thread deletes its board.
- Boards live on your gateway (in the owning agent's database) and appear on
  every device you connect from.
- Switching a thread to the Dashboard face adds it to `/dashboards`. Switching
  it back to Chat removes it.
- The security model, storage details, and design rationale live in
  [Dashboard Architecture](/web/dashboard-architecture), including the
  documented sandbox tradeoffs.
