---
summary: "Session dashboards: agent-built widgets, boards, tabs, and the docked chat"
read_when:
  - Using or explaining session dashboards in the Control UI
  - Deciding what agents can do on a board and what needs an operator grant
title: "Session Dashboards"
---

Every thread in the Control UI has two faces: the conversation you know, and a
**dashboard** — a grid of live widgets your agent builds for you. A thread with
no widgets is just chat. The moment a widget is pinned, a **Chat | Dashboard**
toggle appears in the header, and the dashboard becomes the main surface with
your chat docked beside it.

There is nothing to set up and no separate app to configure: dashboards are a
core feature, owned by the thread, stored with the agent, and they survive
`/new` and `/reset` (the conversation context clears; the board stays).

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
- **Docked chat.** On the dashboard face, your conversation docks to the
  left, right, or bottom, resizes like the sidebar, and can be hidden
  entirely — the agent still hears you when you bring it back.
- **Agent parity.** Everything you can do, the agent can do with its
  `dashboard` tool: add, update, move, resize, and remove widgets, manage
  tabs, switch the visible tab, and move or hide the chat dock. Ask "put the
  chat on the left and show the finance tab" and watch it happen.

## What widgets are allowed to do

A widget that only renders needs no approval — it appears instantly, exactly
like inline chat widgets, and its network access is fully disabled.

Widgets that want **reach** must declare it, and you grant it once per widget
with one tap:

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

Grants are bound to the exact widget bytes and revision you reviewed. If the
agent changes the widget and asks for _more_ than you approved, it goes back
to pending; refreshing content within the same permissions keeps the grant.
Widget interactions the agent should know about (filters you clicked, views
you switched) reach it quietly as session notices — it stays informed without
being interrupted.

## MCP apps on the board

If your gateway has MCP servers configured, interactive MCP apps that appear
in chat can be pinned like any widget. Pinned apps come back to life on the
board with fresh sessions; by default they are display-only, and granting the
widget its declared server tools makes it fully interactive — with the same
one-tap, revision-bound approval as everything else.

## Good to know

- Resetting a thread that has a board asks for confirmation and keeps the
  board.
- Deleting a thread deletes its board.
- Boards live on your gateway (in the owning agent's database) and appear on
  every device you connect from.
- The security model, storage details, and design rationale live in
  [Dashboard Architecture](/web/dashboard-architecture), including the
  documented sandbox tradeoffs.
