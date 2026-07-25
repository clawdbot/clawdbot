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
- A "Nodes" block in the root menu lists paired **devices** only (from `node.list`), not client/presence entries.
- A root "Usage" section appears below Context when provider usage snapshots are available, followed by cost details when available.
- **Quick Chat** opens the floating main-session composer; its current global shortcut appears beside the item.

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

- While work is active: `<Session role> · <activity label>` (`"\(roleLabel) · \(activity.label)"` in `MenuContentView`), where role label is `Main` or `Other`.
- When idle: falls back to the health summary.

## Event ingestion

- Source: control-channel `agent` events, routed by `ControlChannel.routeWorkActivity(from:)`.
- Parsed fields:
  - `stream: "job"` with `data.state` for start/stop.
  - `stream: "tool"` with `data.phase`, `data.name`, optional `data.meta`/`data.args`.
- Tool labels come from `ToolDisplayRegistry.resolve(name:args:meta:)`; unresolved names fall back to the raw tool name.

## Debug override

- Settings > Debug > "Icon override" picker:
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
