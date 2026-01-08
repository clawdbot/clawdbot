---
name: vikunja
description: Manage projects and tasks in Vikunja for One Point engagement timelines. Syncs with Twenty CRM.
---

# Vikunja Project Management

Manage projects, tasks, and timelines for One Point engagements.

## Access

- **URL:** https://projects.mollified.app
- **Steve's login:** steve@withagency.ai

## CLI Commands

```bash
# List projects
uv run {baseDir}/scripts/vikunja.py projects

# Get project details
uv run {baseDir}/scripts/vikunja.py project <ID>

# List all tasks
uv run {baseDir}/scripts/vikunja.py tasks

# List tasks in a project
uv run {baseDir}/scripts/vikunja.py tasks --project <ID>

# Create a project
uv run {baseDir}/scripts/vikunja.py create-project "Project Name" -d "Description"

# Create a task
uv run {baseDir}/scripts/vikunja.py create-task "Task title" --project <ID> --due 2026-01-15 --priority 3

# Complete a task
uv run {baseDir}/scripts/vikunja.py complete <TASK_ID>

# Sync with Twenty CRM (creates projects for opportunities)
uv run {baseDir}/scripts/vikunja.py sync-twenty
```

## Environment Variables

Set in `~/.clawdbot/clawdbot.json`:
- `VIKUNJA_URL` — https://projects.mollified.app
- `VIKUNJA_USER` — steve@withagency.ai
- `VIKUNJA_PASSWORD` — (configured)
- `TWENTY_API_URL` — https://api.mollified.app
- `TWENTY_API_TOKEN` — (configured)

## Priority Levels

- 0: Unset
- 1: Low
- 2: Medium
- 3: High
- 4: Urgent
- 5: DO NOW

## Twenty CRM Sync

The `sync-twenty` command:
1. Fetches all opportunities from Twenty CRM
2. Creates a Vikunja project for each (if not exists)
3. Adds standard engagement tasks:
   - Kickoff Meeting (High)
   - Discovery Phase (Medium)
   - Milestone 1 (Medium)
   - Milestone 2 (Medium)
   - Final Delivery (High)
   - Retrospective (Low)

**Cron:** `vikunja-twenty-sync` runs daily at 8 AM to keep in sync.

## Use Cases

- **"Create a project for Acme engagement"** → `create-project "Acme Corp Engagement"`
- **"What tasks are due this week?"** → `tasks` then filter by due_date
- **"Mark kickoff complete"** → `complete <task_id>`
- **"Sync with Twenty"** → `sync-twenty`
