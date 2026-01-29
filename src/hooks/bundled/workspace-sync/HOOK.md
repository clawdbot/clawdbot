---
name: workspace-sync
description: Sync workspace with cloud storage (Dropbox, Google Drive, etc.) on session start/end
metadata:
  events:
    - session:start
    - session:end
  requires:
    bins:
      - rclone
    config:
      - workspace.sync.provider
---

# Workspace Sync Hook

Automatically syncs your agent workspace with cloud storage when sessions start or end.

## Configuration

Enable in `~/.clawdbot/moltbot.json`:

```json5
{
  workspace: {
    sync: {
      provider: "dropbox", // dropbox | gdrive | onedrive | s3 | custom
      remotePath: "moltbot-share", // folder in cloud storage
      localPath: "shared", // subfolder in workspace
      onSessionStart: true, // sync when session starts
      onSessionEnd: false, // sync when session ends
    },
  },
  hooks: {
    internal: {
      entries: {
        "workspace-sync": { enabled: true },
      },
    },
  },
}
```

## Requirements

- rclone (auto-installed via `moltbot workspace setup` if missing)
- Cloud provider account (Dropbox, Google Drive, OneDrive, or S3)

## Setup

Run the interactive setup wizard:

```bash
moltbot workspace setup
```

The wizard will:

1. Install rclone (if needed)
2. Guide you through provider selection
3. Handle OAuth authorization
4. Configure sync settings
5. Run first sync

See [Workspace Cloud Sync](/gateway/workspace-sync) for full documentation.
