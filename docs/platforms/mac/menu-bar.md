---
summary: "Menu bar status logic and what is surfaced to users"
read_when:
  - Tweaking mac menu UI or status logic
title: "Menu bar"
---

## What is shown

- The current agent work state renders in the menu bar icon and in the first status row of the menu.
- Health status is hidden while work is active; it returns once all sessions are idle.
- A root "Context" item opens a submenu with recent sessions instead of expanding them in the root menu.
- A "Devices" block in the root menu lists paired **devices** only (from `node.list`), not client/presence entries.
- A root "Usage" section appears below Context when provider usage snapshots are available, followed by cost details when available. Cost totals for **Today** and the daily chart use the Mac’s local time zone.
- When two or more Gateways are available, the first status row includes the primary Gateway name and a root "Gateways" section lists every Gateway with its health and primary marker. Select a row to open or focus that Gateway's dashboard; hold Option to reveal "Set as Primary…" for eligible saved Gateways.
- **Quick Chat** opens the floating main-session composer; its current global shortcut appears beside the item.
- **Settings…** (Cmd-,) opens Dashboard settings. App and device preferences live under **This Mac**, voice controls under **Talk**, and app update preferences under **Updates**.
- **Connection…** opens the native Connection window, a standard macOS settings window with **Connection** and **Gateways** toolbar tabs, plus **Debug** while the developer toggle is enabled. It remains available when the Gateway is unreachable.
- **About OpenClaw** opens the standard macOS About panel with version, build information, and credits.

The app's main **Gateways** menu is always present. It lists the primary Gateway, when configured, followed by saved Gateways, with Command-1 through Command-9 assigned in that order. Each card shows health, version and shortened build ID, endpoint, latency, and the number of open dashboard windows when available. Browser-authenticated profiles also show **Access** and their session expiry. A **Primary** badge identifies the primary Gateway; a front-window marker follows the frontmost dashboard window. Selecting a card opens that Gateway's dashboard window or brings its existing window to the front. Hold Option to reveal **New … Window**, or press Option-Command with the same digit, to open another independent window for that Gateway. **Manage Gateways…** opens **Connection → Gateways** and remains available when no Gateways are configured.

Gateway health probes run only while the main **Gateways** menu is open. Cards show cached facts while refreshing, **checking…** before the first result, or **unreachable** with the last successful contact time after a failure. Closing the menu cancels its probes and disconnects probed saved Gateways with no open dashboard windows. The primary connection stays connected, and cached facts remain available until the app quits.

The Devices and Automations summaries refresh while the menu is open. Closing it stops their menu-owned polling. Cached summaries remain available when reopening the same Primary Gateway. Changing Primary refreshes Devices, Automations, Usage, and cost details from the newly selected Gateway. Manage jobs in the Dashboard's **Cron Jobs** page.

The Automations summary shows the full enabled-job count and previews up to eight jobs, ordered by next run.

Manual Cron refreshes and successful job changes supersede older reads, so an in-flight response cannot restore a deleted job to the list.

## State model

- Source: `WorkActivityStore` (`apps/macos/Sources/OpenClaw/WorkActivityStore.swift`).
- Events arrive as `ControlAgentEvent` with a `runId`; the handler (`ControlChannel.routeWorkActivity`) reads `sessionKey` from the event payload and defaults to `"main"` if absent.
- Priority: the main session (`sessionKey == "main"` by default) always wins. If main is active, its state shows immediately. If main is idle, the most recently active non-main session shows instead. The store does not flip mid-activity; it only switches when the current session goes idle or main becomes active.
- Activity kinds:
  - `job`: high-level command execution (`state: started|streaming|done|error|...`).
  - `tool`: `phase: start|result` with `name`, optional `meta`/`args`.

## IconState enum (Swift)

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)` (debug override)

### ActivityKind -> badge symbol

`ActivityKind` wraps a `ToolKind` (`bash`, `read`, `write`, `edit`, `attach`, `other`) or a bare `job`. Each maps to an SF Symbol badge drawn over the critter icon (`IconState.badgeSymbolName`):

| Kind            | Symbol                             |
| --------------- | ---------------------------------- |
| `bash`          | `chevron.left.slash.chevron.right` |
| `read`          | `doc`                              |
| `write`         | `pencil`                           |
| `edit`          | `pencil.tip`                       |
| `attach`        | `paperclip`                        |
| `other` / `job` | `gearshape.fill`                   |

### Visual mapping

- `idle`: normal critter, no badge.
- `workingMain`: badge with symbol, full tint (`.primary` prominence), leg "working" animation.
- `workingOther`: badge with symbol, muted tint (`.secondary` prominence), no scurry.
- `overridden`: uses the chosen symbol/tint regardless of real activity.

## Context submenu

- The root menu shows one "Context" row with a session count/status; it opens a submenu (`MenuSessionsInjector`).
- The submenu header shows the active session count for the last 24 hours.
- Each session row keeps its token bar, age, preview, thinking/verbose toggle, reset, compact, and delete actions.
- Loading, disconnected, and session-load error messages render inside the Context submenu.
- Usage and cost sections stay root-level below Context so they remain glanceable without opening the submenu.

## Status row text (menu)

- With two or more Gateways, the connection label appends the primary Gateway's catalog display name, such as `OpenClaw Active — Mac Studio`.
- While work is active: `<Session role> · <activity label>` (`"\(roleLabel) · \(activity.label)"` in `MenuContentView`), where role label is `Main` or `Other`.
- When idle: falls back to the health summary.

## Event ingestion

- Source: control-channel `agent` events, routed by `ControlChannel.routeWorkActivity(from:)`.
- Parsed fields:
  - `stream: "job"` with `data.state` for start/stop.
  - `stream: "tool"` with `data.phase`, `data.name`, optional `data.meta`/`data.args`.
- Tool labels come from `ToolDisplayRegistry.resolve(name:args:meta:)`; unresolved names fall back to the raw tool name.

## Debug override

- Enable the developer toggle in **Dashboard → Settings → This Mac → Developer**, then open **Connection… → Debug → Icon override**:
  - `System (auto)` (default)
  - `Working: main` / `Working: other` (per tool kind: bash, read, write, edit, other)
  - `Idle`
- Stored under `UserDefaults` key `openclaw.iconOverride`; mapped to `IconState.overridden`.

## Testing checklist

- Trigger main session job: icon switches immediately and status row shows the main label.
- Trigger non-main session job while main is idle: icon/status shows the non-main session; stays stable until it finishes.
- Start main while another session is active: icon flips to main instantly.
- Rapid tool bursts: badge does not flicker (2s grace window before clearing a finished tool, `WorkActivityStore.toolResultGrace`).
- Health row reappears once all sessions are idle.

## Related

- [macOS app](/platforms/macos)
- [Menu bar icon](/platforms/mac/icon)
