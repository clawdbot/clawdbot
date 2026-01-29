---
summary: "Sync your agent workspace with cloud storage (Dropbox, Google Drive, OneDrive, S3)"
read_when:
  - Setting up workspace sync on a remote/cloud Gateway
  - Sharing files between local machine and remote Moltbot
---

# Workspace Cloud Sync

Sync your agent workspace between a remote Gateway (Fly.io, Hetzner, VPS) and your local machine using cloud storage.

## How it works

```
Local Machine              Cloud Provider              Remote Gateway
~/Dropbox/moltbot/    ←→    Dropbox/GDrive/etc    ←→    <workspace>/shared/
   (native app)               (any provider)              (rclone bisync)
```

- **Local**: Native cloud app syncs `~/Dropbox/moltbot/` (or equivalent)
- **Remote**: rclone bisync keeps `<workspace>/shared/` in sync with the cloud
- **Result**: Drop a file locally, it appears on the remote Gateway (and vice versa)

## Quick start

```bash
# Interactive setup wizard (recommended)
moltbot workspace setup
```

The setup wizard guides you through:
1. ✅ Checking rclone installation
2. 📦 Selecting cloud provider (Dropbox, Google Drive, OneDrive, S3)
3. 🔐 Dropbox app folder option (for scoped access)
4. ⏱️ Background sync interval
5. 🔑 OAuth authorization
6. 🔄 First sync

Or configure manually:

**1) Add minimal config:**

```json5
{
  workspace: {
    sync: {
      provider: "dropbox",
      remotePath: "moltbot-share"
    }
  }
}
```

**2) Authorize and sync:**

```bash
moltbot workspace authorize   # opens browser for OAuth
moltbot workspace sync --resync   # first sync (establishes baseline)
```

## Configuration

Add to `~/.clawdbot/moltbot.json`:

```json5
{
  workspace: {
    sync: {
      provider: "dropbox",           // dropbox | gdrive | onedrive | s3 | custom
      remotePath: "moltbot-share",   // folder in cloud storage
      localPath: "shared",           // subfolder in workspace (default: shared)
      interval: 300,                 // background sync every 5 minutes (0 = disabled)
      onSessionStart: true,          // sync when session starts
      onSessionEnd: false,           // sync when session ends
      conflictResolve: "newer",      // newer | local | remote
      exclude: [".git/**", "node_modules/**", "*.log"]
    }
  }
}
```

<Note>
**Zero LLM cost.** The `interval` setting runs pure rclone in the background.
It does NOT wake the bot or trigger any LLM calls - it's just file synchronization.
</Note>

### Provider-specific options

**Dropbox with app folder (recommended):**

```json5
{
  workspace: {
    sync: {
      provider: "dropbox",
      remotePath: "",  // empty = app folder root
      dropbox: {
        appFolder: true,
        appKey: "your-app-key",
        appSecret: "your-app-secret"
      }
    }
  }
}
```

**S3 (AWS, R2, Minio):**

```json5
{
  workspace: {
    sync: {
      provider: "s3",
      remotePath: "moltbot-sync",  // path within bucket
      s3: {
        // AWS S3: https://s3.<REGION>.amazonaws.com (or omit for default)
        // Cloudflare R2: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
        // Minio: https://your-minio-host:9000
        endpoint: "https://s3.us-east-1.amazonaws.com",
        bucket: "your-bucket",
        region: "us-east-1"
        // accessKeyId and secretAccessKey via env vars recommended
      }
    }
  }
}
```

## CLI commands

```bash
# Interactive setup wizard
moltbot workspace setup

# Check sync status
moltbot workspace status

# Sync bidirectionally
moltbot workspace sync

# First sync (required to establish baseline)
moltbot workspace sync --resync

# Preview changes without syncing
moltbot workspace sync --dry-run

# One-way sync
moltbot workspace sync --direction pull   # remote → local
moltbot workspace sync --direction push   # local → remote

# Authorize with cloud provider (use 'setup' for guided flow)
moltbot workspace authorize
moltbot workspace authorize --provider gdrive

# List remote files
moltbot workspace list
```

## Auto-sync hooks

Enable automatic sync on session start/end. These hooks run during existing agent activity,
so they **don't wake the bot** or incur extra LLM costs:

```json5
{
  workspace: {
    sync: {
      provider: "dropbox",
      remotePath: "moltbot-share",
      onSessionStart: true,   // sync when session starts (no LLM cost)
      onSessionEnd: false     // sync when session ends (no LLM cost)
    }
  },
  hooks: {
    internal: {
      entries: {
        "workspace-sync": { enabled: true }
      }
    }
  }
}
```

## Periodic background sync

Set `interval` to enable automatic background sync (in seconds):

```json5
{
  workspace: {
    sync: {
      provider: "dropbox",
      remotePath: "moltbot-share",
      interval: 300   // sync every 5 minutes (minimum: 60s)
    }
  }
}
```

The gateway runs rclone bisync in the background at this interval.
This is a **pure file operation** - it does NOT wake the bot or incur any LLM costs.

### Alternative: External cron

If you prefer external scheduling (e.g., for more control or logging):

```bash
# Add to crontab (crontab -e)
*/5 * * * * moltbot workspace sync >> /var/log/moltbot-sync.log 2>&1
```

## Supported providers

| Provider | Config value | Auth method |
|----------|--------------|-------------|
| Dropbox | `dropbox` | OAuth token |
| Google Drive | `gdrive` | OAuth token |
| OneDrive | `onedrive` | OAuth token |
| S3/R2/Minio | `s3` | Access keys |
| Custom rclone | `custom` | Varies |

For the full list of 70+ providers, see [rclone overview](https://rclone.org/overview/).

## Manual setup (without wizard)

If you prefer manual configuration:

### 1. Install rclone

rclone is **auto-installed** when you run `moltbot workspace setup`.

For manual installation:
- **macOS**: `brew install rclone`
- **Linux**: `curl -s https://rclone.org/install.sh | sudo bash`
- **Docker**: Add to Dockerfile: `RUN curl -s https://rclone.org/install.sh | bash`

### 2. Authorize rclone (from your local machine)

Run this on your **local machine** (where you have a browser):

```bash
# Install rclone locally if needed
brew install rclone  # or: curl -s https://rclone.org/install.sh | bash

# Authorize with your cloud provider
rclone authorize "dropbox"  # or: gdrive, onedrive, s3, etc.
```

Copy the JSON token it outputs.

### 3. Configure rclone on the Gateway

SSH into your Gateway and create the config:

```bash
mkdir -p /data/workspace/.config/rclone

cat > /data/workspace/.config/rclone/rclone.conf << 'EOF'
[cloud]
type = dropbox
token = {"access_token":"YOUR_TOKEN_HERE","token_type":"bearer","expiry":"..."}
EOF
```

For other providers, see [rclone config docs](https://rclone.org/docs/).

### 4. Create the sync folder

**On your local machine:**

Create the folder your cloud app syncs (e.g., `~/Dropbox/moltbot-share/`).

**On the Gateway:**

```bash
mkdir -p /data/workspace/shared
```

### 5. Run the first sync

```bash
# First sync needs --resync to establish baseline
rclone bisync cloud:moltbot-share /data/workspace/shared --resync

# Subsequent syncs
rclone bisync cloud:moltbot-share /data/workspace/shared
```

## Troubleshooting

### Token expired

Re-authorize on your local machine and update the config:

```bash
moltbot workspace authorize
# Or manually:
rclone authorize "dropbox"
# Copy new token to Gateway's rclone.conf
```

### Conflicts

Files modified on both sides get `.conflict` suffix. Check and resolve manually:

```bash
find /data/workspace/shared -name "*.conflict"
```

### First sync fails

Use `--resync` flag to establish baseline:

```bash
moltbot workspace sync --resync
```

### Permission errors

Ensure the workspace directory is writable:

```bash
chmod -R 755 /data/workspace/shared
```

## Security notes

- **Token storage**: rclone tokens are stored in `rclone.conf`. Keep this file secure.
- **Sensitive files**: Don't sync secrets, API keys, or credentials.
- **Encryption**: Consider using rclone's [crypt](https://rclone.org/crypt/) for sensitive data.

### Dropbox: App folder access (recommended)

By default, `rclone authorize "dropbox"` requests **full Dropbox access**. For better security, create an app-scoped token that only accesses a single folder:

**1. Create a Dropbox App**

1. Go to [Dropbox App Console](https://www.dropbox.com/developers/apps)
2. Click **Create app**
3. Choose:
   - **Scoped access** (not "Dropbox Business API")
   - **App folder** — only access to `Apps/<your-app-name>/`
4. Name it (e.g., `moltbot-sync`)
5. Click **Create app**

**2. Configure permissions**

In your app's **Permissions** tab, enable:
- `files.metadata.read`
- `files.metadata.write`
- `files.content.read`
- `files.content.write`

Click **Submit** to save.

**3. Generate token**

In the **Settings** tab:
- Note your **App key** and **App secret**
- Under **OAuth 2**, click **Generate** to create an access token

**4. Configure in moltbot.json**

```json5
{
  workspace: {
    sync: {
      provider: "dropbox",
      remotePath: "",  // empty = app folder root
      dropbox: {
        appFolder: true,
        appKey: "your-app-key",
        appSecret: "your-app-secret"
      }
    }
  }
}
```

Then authorize:

```bash
moltbot workspace authorize
```

**Benefits of app folder access:**
- 🔒 Token only accesses one folder, not your entire Dropbox
- 🛡️ If token is compromised, blast radius is limited
- 📁 Clean separation — sync folder lives under `Apps/`

### Google Drive: Limited folder access

Similar scoping is possible with Google Drive using a service account + shared folder, but setup is more involved. See [rclone Google Drive docs](https://rclone.org/drive/).

## See also

- [Agent workspace](/concepts/agent-workspace) — workspace layout and backup
- [Fly.io deployment](/platforms/fly) — Docker-based cloud deployment
- [Hetzner deployment](/platforms/hetzner) — VPS deployment
- [rclone docs](https://rclone.org/docs/) — full rclone documentation
