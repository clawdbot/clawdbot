---
summary: "Menu bar status logic and what is surfaced to users"
read_when:
  - Tweaking mac menu UI or status logic
title: "Menu bar"
---

## What is shown

- We surface the current agent work state in the menu bar icon and in the first status row of the menu.
- Health status is hidden while work is active; it returns when all sessions are idle.
- A root "Context" submenu contains recent sessions instead of expanding them directly in the root menu.
- The "Nodes" block in the root menu lists **devices** only (paired nodes via `node.list`), not client/presence entries.
- A root "Usage" section appears below Context when provider usage snapshots are available, followed by usage-cost details when available.

## State model

- Sessions: events arrive with `runId` (per-run) plus `sessionKey` in the payload. The "main" session is the key `main`; if absent, we fall back to the most recently updated session.
- Priority: main always wins. If main is active, its state is shown immediately. If main is idle, the most recently active non-main session is shown. We do not flip-flop mid-activity; we only switch when the current session goes idle or main becomes active.
- Activity kinds:
  - `job`: high-level command execution (`state: started|streaming|done|error`).
  - `tool`: `phase: start|result` with `toolName` and `meta/args`.

## IconState enum (Swift)

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)` (debug override)

### ActivityKind → glyph

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- default → 🛠️

### Visual mapping

- `idle`: normal critter.
- `workingMain`: badge with glyph, full tint, leg "working" animation.
- `workingOther`: badge with glyph, muted tint, no scurry.
- `overridden`: uses the chosen glyph/tint regardless of activity.

## Context submenu

- The root menu shows one "Context" row with a session count/status and opens a submenu.
- The Context submenu header shows the active session count for the last 24 hours.
- Each session row keeps its token bar, age, preview, thinking/verbose, reset, compact, and delete actions.
- Loading, disconnected, and session-load error messages appear inside the Context submenu.
- Provider usage and usage-cost details stay root-level below Context so they remain glanceable without opening the submenu.

## Status row text (menu)

- While work is active: `<Session role> · <activity label>`
  - Examples: `Main · exec: pnpm test`, `Other · read: apps/macos/Sources/OpenClaw/AppState.swift`.
- When idle: falls back to the health summary.

## Event ingestion

- Source: control-channel `agent` events (`ControlChannel.handleAgentEvent`).
- Parsed fields:
  - `stream: "job"` with `data.state` for start/stop.
  - `stream: "tool"` with `data.phase`, `name`, optional `meta`/`args`.
- Labels:
  - `exec`: first line of `args.command`.
  - `read`/`write`: shortened path.
  - `edit`: path plus inferred change kind from `meta`/diff counts.
  - fallback: tool name.

## Debug override

- Settings ▸ Debug ▸ "Icon override" picker:
  - `System (auto)` (default)
  - `Working: main` (per tool kind)
  - `Working: other` (per tool kind)
  - `Idle`
- Stored via `@AppStorage("iconOverride")`; mapped to `IconState.overridden`.

## Testing checklist

- Trigger main session job: verify icon switches immediately and status row shows main label.
- Trigger non-main session job while main idle: icon/status shows non-main; stays stable until it finishes.
- Start main while other active: icon flips to main instantly.
- Rapid tool bursts: ensure badge does not flicker (TTL grace on tool results).
- Health row reappears once all sessions idle.

## Related

- [macOS app](/platforms/macos)
- [Menu bar icon](/platforms/mac/icon)
