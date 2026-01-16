# @clawdbot/zalouser

Clawdbot extension for Zalo Personal Account messaging via [zca-cli](https://zca-cli.dev).

> **Warning:** Using Zalo automation may result in account suspension or ban. Use at your own risk. This is an unofficial integration.

## Features

- **Channel Plugin Integration**: Appears in onboarding wizard with QR login
- **Gateway Integration**: Real-time message listening via the gateway
- **Multi-Account Support**: Manage multiple Zalo personal accounts
- **CLI Commands**: Full command-line interface for messaging
- **Agent Tool**: AI agent integration for automated messaging

## Prerequisites

Install `zca` CLI and ensure it's in your PATH:


**macOS / Linux:**
```bash
curl -fsSL https://get.zca-cli.dev/install.sh | bash

# Or with custom install directory
ZCA_INSTALL_DIR=~/.local/bin curl -fsSL https://get.zca-cli.dev/install.sh | bash

# Install specific version
curl -fsSL https://get.zca-cli.dev/install.sh | bash -s v1.0.0

# Uninstall
curl -fsSL https://get.zca-cli.dev/install.sh | bash -s uninstall
```

**Windows (PowerShell):**
```powershell
irm https://get.zca-cli.dev/install.ps1 | iex

# Or with custom install directory
$env:ZCA_INSTALL_DIR = "C:\Tools\zca"; irm https://get.zca-cli.dev/install.ps1 | iex

# Install specific version
iex "& { $(irm https://get.zca-cli.dev/install.ps1) } -Version v1.0.0"

# Uninstall
iex "& { $(irm https://get.zca-cli.dev/install.ps1) } -Uninstall"
```

### Manual Download

Download binary directly:

**macOS / Linux:**
```bash
curl -fsSL https://get.zca-cli.dev/latest/zca-darwin-arm64 -o zca && chmod +x zca
```

**Windows (PowerShell):**
```powershell
Invoke-WebRequest -Uri https://get.zca-cli.dev/latest/zca-windows-x64.exe -OutFile zca.exe
```

Available binaries:
- `zca-darwin-arm64` - macOS Apple Silicon
- `zca-darwin-x64` - macOS Intel
- `zca-linux-arm64` - Linux ARM64
- `zca-linux-x64` - Linux x86_64
- `zca-windows-x64.exe` - Windows

See [zca-cli](https://zca-cli.dev) for manual download (binaries for macOS/Linux/Windows) or building from source.

## Quick Start

### Option 1: Onboarding Wizard (Recommended)

```bash
clawdbot onboard
# Select "Zalo Personal" from channel list
# Follow QR code login flow
```

### Option 2: Login (QR, on the Gateway machine)

```bash
clawdbot channels login --channel zalouser
# Scan QR code with Zalo app
```

### Send a Message

```bash
clawdbot message send --channel zalouser --to <threadId> --message "Hello from Clawdbot!"
```

## Configuration

After onboarding, your config will include:

```yaml
channels:
  zalouser:
    enabled: true
    dmPolicy: pairing  # pairing | allowlist | open | disabled
```

For multi-account:

```yaml
channels:
  zalouser:
    enabled: true
    defaultAccount: default
    accounts:
      default:
        enabled: true
        profile: default
      work:
        enabled: true
        profile: work
```

## Commands

### Authentication

```bash
clawdbot channels login --channel zalouser              # Login via QR
clawdbot channels login --channel zalouser --account work
clawdbot channels status --probe
clawdbot channels logout --channel zalouser
```

### Directory (IDs, contacts, groups)

```bash
clawdbot directory self --channel zalouser
clawdbot directory peers list --channel zalouser --query "name"
clawdbot directory groups list --channel zalouser --query "work"
clawdbot directory groups members --channel zalouser --group-id <id>
```

### Account Management

```bash
zca account list      # List all profiles
zca account current   # Show active profile
zca account switch <profile>
zca account remove <profile>
zca account label <profile> "Work Account"
```

### Messaging

```bash
# Text
clawdbot message send --channel zalouser --to <threadId> --message "message"

# Media (URL)
clawdbot message send --channel zalouser --to <threadId> --message "caption" --media-url "https://example.com/img.jpg"
```

### Listener

The listener runs inside the Gateway when the channel is enabled. For debugging,
use `clawdbot channels logs --channel zalouser` or run `zca listen` directly.

### Data Access

```bash
# Friends
zca friend list
zca friend list -j    # JSON output
zca friend find "name"
zca friend online

# Groups
zca group list
zca group info <groupId>
zca group members <groupId>

# Profile
zca me info
zca me id
```

## Multi-Account Support

Use `--profile` or `-p` to work with multiple accounts:

```bash
clawdbot channels login --channel zalouser --account work
clawdbot message send --channel zalouser --account work --to <id> --message "Hello"
ZCA_PROFILE=work zca listen
```

Profile resolution order: `--profile` flag > `ZCA_PROFILE` env > default

## Agent Tool

The extension registers a `zalouser` tool for AI agents:

```json
{
  "action": "send",
  "threadId": "123456",
  "message": "Hello from AI!",
  "isGroup": false,
  "profile": "default"
}
```

Available actions: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`

## Troubleshooting

- **Login Issues:** Run `zca auth logout` then `zca auth login`
- **API Errors:** Try `zca auth cache-refresh` or re-login
- **File Uploads:** Check size (max 100MB) and path accessibility

## Credits

Built on [zca-cli](https://zca-cli.dev) which uses [zca-js](https://github.com/RFS-ADRENO/zca-js).
