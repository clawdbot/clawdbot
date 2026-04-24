---
name: apple-reminders
description: List, add, edit, complete, or delete Apple Reminders and reminder lists via remindctl.
homepage: https://github.com/steipete/remindctl
metadata:
  {
    "openclaw":
      {
        "emoji": "⏰",
        "os": ["darwin"],
        "requires": { "bins": ["remindctl"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/remindctl",
              "bins": ["remindctl"],
              "label": "Install remindctl via Homebrew",
            },
          ],
      },
  }
---

# Apple Reminders CLI (remindctl)

Use `remindctl` to manage Apple Reminders directly from the terminal.

## When to Use

✅ **USE this skill when:**

- User explicitly mentions "reminder" or "Reminders app"
- Creating personal to-dos with due dates that sync to iOS
- Managing Apple Reminders lists
- User wants tasks to appear in their iPhone/iPad Reminders app

## When NOT to Use

❌ **DON'T use this skill when:**

- Scheduling OpenClaw tasks or alerts → use `cron` tool with systemEvent instead
- Calendar events or appointments → use Apple Calendar
- Project/work task management → use Notion, GitHub Issues, or task queue
- One-time notifications → use `cron` tool for timed alerts
- User says "remind me" but means an OpenClaw alert → clarify first

## Setup

- Install: `brew install steipete/tap/remindctl`
- macOS-only; grant Reminders permission when prompted
- Check status: `remindctl status`
- Request access: `remindctl authorize`

## Common Commands

### View Reminders

```bash
remindctl                    # Today's reminders
remindctl today              # Today
remindctl tomorrow           # Tomorrow
remindctl week               # This week
remindctl overdue            # Past due
remindctl all                # Everything
remindctl 2026-01-04         # Specific date
```

### Manage Lists

```bash
remindctl list               # List all lists
remindctl list Work          # Show specific list
remindctl list Projects --create    # Create list
remindctl list Work --delete        # Delete list
```

### Create Reminders

```bash
remindctl add "Buy milk"
remindctl add --title "Call mom" --list Personal --due tomorrow
remindctl add --title "Meeting prep" --due "2026-02-15 09:00"
```

### Complete/Delete

```bash
remindctl complete 1 2 3     # Complete by ID
remindctl delete 4A83 --force  # Delete by ID
```

### Output Formats

```bash
remindctl today --json       # JSON for scripting
remindctl today --plain      # TSV format
remindctl today --quiet      # Counts only
```

## Date Formats

Accepted by `--due` and date filters:

- `today`, `tomorrow`, `yesterday`
- `YYYY-MM-DD`
- `YYYY-MM-DD HH:mm`
- ISO 8601 (`2026-01-04T12:34:56Z`)

## Example: Clarifying User Intent

User: "Remind me to check on the deploy in 2 hours"

**Ask:** "Do you want this in Apple Reminders (syncs to your phone) or as an OpenClaw alert (I'll message you here)?"

- Apple Reminders → use this skill
- OpenClaw alert → use `cron` tool with systemEvent
