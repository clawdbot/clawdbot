---
name: caly
description: Calendar wizard CLI for macOS. List, search, and create calendar events.
metadata: {"clawdbot":{"emoji":"🧙","requires":{"bins":["caly"]}}}
---

# Caly - Calendar Wizard CLI

A quirky calendar CLI for macOS that works with your system calendars.

## List Events

```bash
caly list                          # Next 7 days
caly list --days 14                # Next 14 days
caly list --from 2026-01-10 --to 2026-01-20
caly list --calendar "Work"        # Filter by calendar
caly list --limit 5                # Limit results
caly list --include-past           # Include past events from today
```

## Search Events

```bash
caly search "meeting"              # Search by keyword
caly search "doctor" --days 60     # Search in next 60 days
```

## List Calendars

```bash
caly calendars                     # Show all available calendars
```

## Create Events

```bash
caly create "Team Standup" --start 2026-01-10T09:00:00 --end 2026-01-10T09:30:00
caly create "Vacation" --start 2026-01-15 --end 2026-01-20 --all-day
caly create "Meeting" --start 2026-01-10T14:00:00 --end 2026-01-10T15:00:00 --calendar "Work"
```

## Notes

- Works with all calendars synced to macOS Calendar app (iCloud, Google, Exchange, etc.)
- Requires Calendar access permission in System Settings > Privacy & Security > Calendars
