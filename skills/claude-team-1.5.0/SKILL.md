---
name: claude-team
description: Orchestrate multiple Claude Code workers via iTerm2 using the claude-team MCP server. Spawn workers with git worktrees, assign beads issues, monitor progress, and coordinate parallel development work.
homepage: https://github.com/Martian-Engineering/claude-team
metadata: {"clawdbot":{"emoji":"👥","os":["darwin"],"requires":{"bins":["mcporter"]}}}
---

# Claude Team

Claude-team is an MCP server that lets you spawn and manage teams of Claude Code sessions via iTerm2. Each worker gets their own terminal pane, optional git worktree, and can be assigned beads issues.

## Why Use Claude Team?

- **Parallelism**: Fan out work to multiple agents working simultaneously
- **Context isolation**: Each worker has fresh context, keeps coordinator context clean
- **Visibility**: Real Claude Code sessions you can watch, interrupt, or take over
- **Git worktrees**: Each worker can have an isolated branch for their work

## ⚠️ Important Rule

**NEVER make code changes directly.** Always spawn workers for code changes. This keeps your context clean and provides proper git workflow with worktrees.

## Prerequisites

- macOS with iTerm2 (Python API enabled: Preferences → General → Magic → Enable Python API)
- claude-team MCP server configured in `~/.claude.json`

## Using via mcporter

All tools are called through `mcporter call claude-team.<tool>`:

```bash
mcporter call claude-team.list_workers
mcporter call claude-team.spawn_workers workers='[{"project_path":"/path/to/repo","bead":"cp-123"}]'
```

## Core Tools

### spawn_workers

Create new Claude Code worker sessions.

```bash
mcporter call claude-team.spawn_workers \
  workers='[{
    "project_path": "/path/to/repo",
    "bead": "cp-123",
    "annotation": "Fix auth bug",
    "use_worktree": true,
    "skip_permissions": true
  }]' \
  layout="auto"
```

**Worker config fields:**
- `project_path`: Required. Path to repo or "auto" (uses CLAUDE_TEAM_PROJECT_DIR)
- `bead`: Optional beads issue ID — worker will follow beads workflow
- `annotation`: Task description (shown on badge, used in branch name)
- `prompt`: Additional instructions (if no bead, this is their assignment)
- `use_worktree`: Create isolated git worktree (default: true)
- `skip_permissions`: Start with --dangerously-skip-permissions (default: false)
- `name`: Optional worker name override (auto-picks from themed sets otherwise)

**Layout options:**
- `"auto"`: Reuse existing claude-team windows, split into available space
- `"new"`: Always create fresh window (1-4 workers in grid layout)

### list_workers

See all managed workers:

```bash
mcporter call claude-team.list_workers
mcporter call claude-team.list_workers status_filter="ready"
```

Status values: `spawning`, `ready`, `busy`, `closed`

### message_workers

Send messages to one or more workers:

```bash
mcporter call claude-team.message_workers \
  session_ids='["Groucho"]' \
  message="Please also add unit tests" \
  wait_mode="none"
```

**wait_mode options:**
- `"none"`: Fire and forget (default)
- `"any"`: Return when any worker is idle
- `"all"`: Return when all workers are idle

### check_idle_workers / wait_idle_workers

Check or wait for workers to finish:

```bash
# Quick poll
mcporter call claude-team.check_idle_workers session_ids='["Groucho","Harpo"]'

# Blocking wait
mcporter call claude-team.wait_idle_workers \
  session_ids='["Groucho","Harpo"]' \
  mode="all" \
  timeout=600
```

### read_worker_logs

Get conversation history:

```bash
mcporter call claude-team.read_worker_logs \
  session_id="Groucho" \
  pages=2
```

### examine_worker

Get detailed status including conversation stats:

```bash
mcporter call claude-team.examine_worker session_id="Groucho"
```

### close_workers

Terminate workers when done:

```bash
mcporter call claude-team.close_workers session_ids='["Groucho","Harpo"]'
```

⚠️ **Worktree cleanup**: Workers with worktrees commit to ephemeral branches. After closing:
1. Review commits on the worker's branch
2. Merge or cherry-pick to a persistent branch
3. Delete the branch: `git branch -D <branch-name>`

### bd_help

Quick reference for beads commands:

```bash
mcporter call claude-team.bd_help
```

## Worker Identification

Workers can be referenced by any of:
- **Internal ID**: Short hex string (e.g., `3962c5c4`)
- **Terminal ID**: `iterm:UUID` format
- **Worker name**: Human-friendly name (e.g., `Groucho`, `Aragorn`)

## Workflow: Assigning a Beads Issue

```bash
# 1. Spawn worker with a bead assignment
mcporter call claude-team.spawn_workers \
  workers='[{
    "project_path": "/Users/phaedrus/Projects/myrepo",
    "bead": "proj-abc",
    "annotation": "Implement config schemas",
    "use_worktree": true,
    "skip_permissions": true
  }]'

# 2. Worker automatically:
#    - Creates worktree with branch named after bead
#    - Runs `bd show proj-abc` to understand the task
#    - Marks issue in_progress
#    - Implements the work
#    - Closes the issue
#    - Commits with issue reference

# 3. Monitor progress
mcporter call claude-team.check_idle_workers session_ids='["Groucho"]'
mcporter call claude-team.read_worker_logs session_id="Groucho"

# 4. When done, close and merge
mcporter call claude-team.close_workers session_ids='["Groucho"]'
# Then: git merge or cherry-pick from worker's branch
```

## Workflow: Parallel Fan-Out

```bash
# Spawn multiple workers for parallel tasks
mcporter call claude-team.spawn_workers \
  workers='[
    {"project_path": "auto", "bead": "cp-123", "annotation": "Auth module"},
    {"project_path": "auto", "bead": "cp-124", "annotation": "API routes"},
    {"project_path": "auto", "bead": "cp-125", "annotation": "Unit tests"}
  ]' \
  layout="new"

# Wait for all to complete
mcporter call claude-team.wait_idle_workers \
  session_ids='["Groucho","Harpo","Chico"]' \
  mode="all"

# Review and close
mcporter call claude-team.close_workers \
  session_ids='["Groucho","Harpo","Chico"]'
```

## Best Practices

1. **Use beads**: Assign `bead` IDs so workers follow proper issue workflow
2. **Use worktrees**: Keeps work isolated, enables parallel commits
3. **Skip permissions**: Workers need `skip_permissions: true` to write files
4. **Monitor, don't micromanage**: Let workers complete, then review
5. **Merge carefully**: Review worker branches before merging to main
6. **Close workers**: Always close when done to clean up worktrees

## HTTP Mode (Streamable HTTP Transport)

For persistent server operation, claude-team can run as an HTTP server. This keeps the MCP server running continuously with persistent state, avoiding cold starts.

### Starting the HTTP Server

Run the claude-team HTTP server directly:

```bash
# From the claude-team directory
uv run python -m claude_team_mcp --http --port 8766

# Or specify the directory explicitly
uv run --directory /path/to/claude-team python -m claude_team_mcp --http --port 8766
```

For automatic startup on login, use launchd (see the "launchd Auto-Start" section below).

### mcporter.json Configuration

Once the HTTP server is running, configure mcporter to connect to it. Create `~/.mcporter/mcporter.json`:

```json
{
  "mcpServers": {
    "claude-team": {
      "transport": "streamable-http",
      "url": "http://127.0.0.1:8766/mcp",
      "lifecycle": "keep-alive"
    }
  }
}
```

### Benefits of HTTP Mode

- **Persistent state**: Worker registry survives across CLI invocations
- **Faster responses**: No Python environment startup on each call
- **External access**: Can be accessed by cron jobs, scripts, or other tools
- **Session recovery**: Server tracks sessions even if coordinator disconnects

### Connecting from Claude Code

Update your `.mcp.json` to use HTTP transport:

```json
{
  "mcpServers": {
    "claude-team": {
      "transport": "streamable-http",
      "url": "http://127.0.0.1:8766/mcp"
    }
  }
}
```

## launchd Auto-Start

To automatically start the claude-team server on login, use the bundled setup script.

### Quick Setup

Run the setup script from the skill's assets directory:

```bash
# From the skill directory
./assets/setup.sh

# Or specify a custom claude-team location
CLAUDE_TEAM_DIR=/path/to/claude-team ./assets/setup.sh
```

### What the Setup Does

The setup script:
1. Detects your `uv` installation path
2. Creates the log directory at `~/.claude-team/logs/`
3. Generates a launchd plist from `assets/com.claude-team.plist.template`
4. Installs it to `~/Library/LaunchAgents/com.claude-team.plist`
5. Loads the service to start immediately

The plist template uses `uv run` to start the HTTP server on port 8766, configured for iTerm2 Python API access (Aqua session type).

### Managing the Service

```bash
# Stop the service
launchctl unload ~/Library/LaunchAgents/com.claude-team.plist

# Restart (re-run setup)
./assets/setup.sh

# Check if running
launchctl list | grep claude-team

# View logs
tail -f ~/.claude-team/logs/stdout.log
tail -f ~/.claude-team/logs/stderr.log
```

### Troubleshooting launchd

```bash
# Check for load errors
launchctl print gui/$UID/com.claude-team

# Force restart
launchctl kickstart -k gui/$UID/com.claude-team

# Remove and reload (if plist changed)
launchctl bootout gui/$UID/com.claude-team
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.claude-team.plist
```

## Cron Integration

For background monitoring and notifications, claude-team supports cron-based worker tracking.

### Worker Tracking File

Claude-team writes worker state to `~/.claude-team/memory/worker-tracking.json`:

```json
{
  "workers": {
    "Groucho": {
      "session_id": "3962c5c4",
      "bead": "cp-123",
      "annotation": "Fix auth bug",
      "status": "busy",
      "project_path": "/Users/phaedrus/Projects/myrepo",
      "started_at": "2025-01-05T10:30:00Z",
      "last_activity": "2025-01-05T11:45:00Z"
    },
    "Harpo": {
      "session_id": "a1b2c3d4",
      "bead": "cp-124",
      "annotation": "Add API routes",
      "status": "idle",
      "project_path": "/Users/phaedrus/Projects/myrepo",
      "started_at": "2025-01-05T10:30:00Z",
      "last_activity": "2025-01-05T11:50:00Z",
      "completed_at": "2025-01-05T11:50:00Z"
    }
  },
  "last_updated": "2025-01-05T11:50:00Z"
}
```

### Cron Job for Monitoring Completions

Create a monitoring script at `~/.claude-team/scripts/check-workers.sh`:

```bash
#!/bin/bash
# Check for completed workers and send notifications

TRACKING_FILE="$HOME/.claude-team/memory/worker-tracking.json"
NOTIFIED_FILE="$HOME/.claude-team/memory/notified-workers.json"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID}"

# Exit if tracking file doesn't exist
[ -f "$TRACKING_FILE" ] || exit 0

# Initialize notified file if needed
[ -f "$NOTIFIED_FILE" ] || echo '{"notified":[]}' > "$NOTIFIED_FILE"

# Find idle workers that haven't been notified
IDLE_WORKERS=$(jq -r '
  .workers | to_entries[] |
  select(.value.status == "idle") |
  .key
' "$TRACKING_FILE")

for worker in $IDLE_WORKERS; do
  # Check if already notified
  ALREADY_NOTIFIED=$(jq -r --arg w "$worker" '.notified | index($w) != null' "$NOTIFIED_FILE")

  if [ "$ALREADY_NOTIFIED" = "false" ]; then
    # Get worker details
    BEAD=$(jq -r --arg w "$worker" '.workers[$w].bead // "no-bead"' "$TRACKING_FILE")
    ANNOTATION=$(jq -r --arg w "$worker" '.workers[$w].annotation // "no annotation"' "$TRACKING_FILE")

    # Send Telegram notification
    MESSAGE="🤖 Worker *${worker}* completed
📋 Bead: \`${BEAD}\`
📝 ${ANNOTATION}"

    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="$TELEGRAM_CHAT_ID" \
      -d text="$MESSAGE" \
      -d parse_mode="Markdown" > /dev/null

    # Mark as notified
    jq --arg w "$worker" '.notified += [$w]' "$NOTIFIED_FILE" > "${NOTIFIED_FILE}.tmp"
    mv "${NOTIFIED_FILE}.tmp" "$NOTIFIED_FILE"
  fi
done
```

Make it executable:

```bash
chmod +x ~/.claude-team/scripts/check-workers.sh
```

### Crontab Entry

Add to crontab (`crontab -e`):

```cron
# Check claude-team workers every 2 minutes
*/2 * * * * TELEGRAM_BOT_TOKEN="your-bot-token" TELEGRAM_CHAT_ID="your-chat-id" ~/.claude-team/scripts/check-workers.sh
```

### Environment Setup

Set Telegram credentials in your shell profile (`~/.zshrc`):

```bash
export TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
export TELEGRAM_CHAT_ID="-1001234567890"
```

### Alternative: Using clawdbot for Notifications

If you have clawdbot configured, you can send notifications through it instead:

```bash
# In check-workers.sh, replace the curl command with:
clawdbot send --to "$TELEGRAM_CHAT_ID" --message "$MESSAGE" --provider telegram
```

### Clearing Notification State

When starting a fresh batch of workers, clear the notified list:

```bash
echo '{"notified":[]}' > ~/.claude-team/memory/notified-workers.json
```
