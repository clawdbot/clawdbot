---
name: apple-reminders
description: Manage Apple Reminders via the `remindctl` CLI on macOS (list, add, edit, complete, delete). Supports lists, date filters, and JSON/plain output.
homepage: https://github.com/steipete/remindctl
metadata: {"moltbot":{"emoji":"⏰","os":["darwin"],"requires":{"bins":["remindctl"]},"install":[{"id":"brew","kind":"brew","formula":"steipete/tap/remindctl","bins":["remindctl"],"label":"Install remindctl via Homebrew"}]}}
---

# Apple Reminders CLI (remindctl)

Use `remindctl` to manage Apple Reminders directly from the terminal. It supports list filtering, date-based views, and scripting output.

Setup
- Install (Homebrew): `brew install steipete/tap/remindctl`
- From source: `pnpm install && pnpm build` (binary at `./bin/remindctl`)
- macOS-only; grant Reminders permission when prompted.

Permissions
- Check status: `remindctl status`
- Request access: `remindctl authorize`

View Reminders
- Default (today): `remindctl`
- Today: `remindctl today`
- Tomorrow: `remindctl tomorrow`
- Week: `remindctl week`
- Overdue: `remindctl overdue`
- Upcoming: `remindctl upcoming`
- Completed: `remindctl completed`
- All: `remindctl all`
- Specific date: `remindctl 2026-01-04`

Manage Lists
- List all lists: `remindctl list`
- Show list: `remindctl list Work`
- Create list: `remindctl list Projects --create`
- Rename list: `remindctl list Work --rename Office`
- Delete list: `remindctl list Work --delete`

Create Reminders
- Quick add: `remindctl add "Buy milk"`
- With list + due: `remindctl add --title "Call mom" --list Personal --due tomorrow`

Edit Reminders
- Edit title/due: `remindctl edit 1 --title "New title" --due 2026-01-04`

Complete Reminders
- Complete by id: `remindctl complete 1 2 3`

Delete Reminders
- Delete by id: `remindctl delete 4A83 --force`

Output Formats
- JSON (scripting): `remindctl today --json`
- Plain TSV: `remindctl today --plain`
- Counts only: `remindctl today --quiet`

Date Formats
Accepted by `--due` and date filters:
- `today`, `tomorrow`, `yesterday`
- `YYYY-MM-DD`
- `YYYY-MM-DD HH:mm`
- ISO 8601 (`2026-01-04T12:34:56Z`)

Notes
- macOS-only.
- If access is denied, enable Terminal/remindctl in System Settings → Privacy & Security → Reminders.
- If running over SSH, grant access on the Mac that runs the command.
