# Backup Script

Complete backup solution for Clawdbot including all workspaces, agents, and sandboxes.

## Usage

```bash
./scripts/backup-complete.sh
```

## What Gets Backed Up

The script creates a comprehensive backup in `~/.backup/clawdbot/<timestamp>/`:

### Core State
- `~/.clawdbot/` - Complete state directory including:
  - Agent configurations
  - Session history (all agents)
  - Sandbox workspaces
  - Credentials
  - Logs
  - Cron jobs
  - Browser state

### Workspaces
All configured agent workspaces are backed up with their original directory names.

The script automatically discovers workspaces by parsing `routing.agents.*.workspace` in your config.

### Docker Volumes (optional)
If Docker is running, the script will also export all `clawdbot-*` Docker volumes as `.tar.gz` files.

## Backup Structure

```
~/.backup/clawdbot/20260108125916/
├── .clawdbot/                    # Complete state
├── clawd/                        # Workspace 1
├── clawd-agent2/                 # Workspace 2
├── clawd-agent3/                 # Workspace 3
└── docker-volumes/               # Docker volumes (if available)
    └── clawdbot-sandbox.tar.gz
```

## Restore

The script provides restore commands at the end of the backup. Example:

```bash
# Restore everything
rsync -a ~/.backup/clawdbot/<timestamp>/.clawdbot/ ~/.clawdbot/

# Restore specific workspace
rsync -a ~/.backup/clawdbot/<timestamp>/clawd/ ~/clawd/
```

## Features

- ✅ **Complete**: Backs up all state, workspaces, and sandboxes
- ✅ **Smart**: Auto-discovers workspaces from config
- ✅ **Safe**: Uses rsync for reliable copying
- ✅ **Timestamped**: Each backup has unique timestamp
- ✅ **Summary**: Shows what was backed up with sizes
- ✅ **Restore hints**: Provides ready-to-use restore commands

## Output Example

```
📦 Creating complete Clawdbot backup...
Timestamp: 20260108125916
Target: /Users/user/.backup/clawdbot/20260108125916

=== Core State Directory ===
📁 Backing up: /Users/user/.clawdbot
  ✅ 120M - .clawdbot (complete)

=== Workspace Directories ===
📁 clawd
   Source: /Users/user/clawd
   ✅ 3.1M (114 files)
📁 clawd-agent2
   Source: /Users/user/clawd-agent2
   ✅  28K (7 files)
📁 clawd-agent3
   Source: /Users/user/clawd-agent3
   ✅ 2.3M (24 files)

=== Agent Summary ===
🤖 agent1: 47 sessions → /Users/user/clawd
🤖 agent2: 2 sessions → /Users/user/clawd-agent2
🤖 agent3: 2 sessions → /Users/user/clawd-agent3

=== Sandbox Summary ===
🐳 6 sandbox workspace(s) (included in .clawdbot backup)

✅ Backup complete!

📊 Backup Structure:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  clawd/                                  3.1M (114 files)
  clawd-agent2/                            28K (7 files)
  clawd-agent3/                           2.3M (24 files)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Total: 125M
```

## When to Use

- Before major updates or configuration changes
- Before testing new features
- Regular maintenance backups
- Before migrating to a new machine
- After important agent sessions

## Requirements

- `rsync` (pre-installed on macOS/Linux)
- `jq` (for parsing config)
- Optional: Docker (for volume backups)
