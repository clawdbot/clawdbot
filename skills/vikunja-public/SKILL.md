---
name: vikunja
description: Manage projects and tasks in Vikunja, an open-source project management tool. Create projects, tasks, set due dates, priorities, and track completion.
homepage: https://vikunja.io
metadata: {"clawdbot":{"emoji":"📋","requires":{"bins":["uv"],"env":["VIKUNJA_URL","VIKUNJA_USER","VIKUNJA_PASSWORD"]},"primaryEnv":"VIKUNJA_URL"}}
---

# Vikunja Project Management

Manage projects and tasks in [Vikunja](https://vikunja.io), an open-source, self-hosted project management tool.

## Setup

Set these environment variables:
- `VIKUNJA_URL` - Your Vikunja instance URL (e.g., `https://vikunja.example.com`)
- `VIKUNJA_USER` - Username or email
- `VIKUNJA_PASSWORD` - Password

## Commands

### Projects
```bash
# List all projects
uv run {baseDir}/scripts/vikunja.py projects

# Get project details
uv run {baseDir}/scripts/vikunja.py project <ID>

# Create a project
uv run {baseDir}/scripts/vikunja.py create-project "Project Name" -d "Description"
```

### Tasks
```bash
# List all tasks
uv run {baseDir}/scripts/vikunja.py tasks

# List tasks in a specific project
uv run {baseDir}/scripts/vikunja.py tasks --project <PROJECT_ID>

# Create a task
uv run {baseDir}/scripts/vikunja.py create-task "Task title" --project <ID> --due 2026-01-15 --priority 3

# Mark task complete
uv run {baseDir}/scripts/vikunja.py complete <TASK_ID>
```

### Options
- `--json` - Output results as JSON (for programmatic use)

## Priority Levels
- 0: None
- 1: Low
- 2: Medium  
- 3: High
- 4: Urgent
- 5: Critical

## Examples

```bash
# Create a project for Q1 planning
uv run {baseDir}/scripts/vikunja.py create-project "Q1 2026 Planning" -d "Quarterly planning tasks"

# Add a high-priority task
uv run {baseDir}/scripts/vikunja.py create-task "Review budget" --project 5 --due 2026-01-20 --priority 3

# Check what's due
uv run {baseDir}/scripts/vikunja.py tasks --project 5 --json
```
