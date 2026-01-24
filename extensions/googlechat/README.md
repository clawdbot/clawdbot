# Google Chat Plugin for Clawdbot

Connect Clawdbot to Google Chat via Pub/Sub webhooks.

## Prerequisites

- Google Cloud Project
- Service account with Google Chat API access
- Pub/Sub subscription configured

## Quick Start

1. **Enable the plugin:**

```bash
clawdbot config set channels.googlechat.enabled true
```

2. **Configure credentials:**

```bash
clawdbot config set channels.googlechat.projectId "your-project-id"
clawdbot config set channels.googlechat.subscriptionName "projects/your-project/subscriptions/your-sub"
clawdbot config set channels.googlechat.credentialsPath "/path/to/service-account.json"
```

3. **Set up allowlist:**

```bash
clawdbot config set channels.googlechat.allowFrom '["user@example.com"]'
```

4. **Start the gateway:**

```bash
clawdbot gateway run
```

## Configuration

See `clawdbot.plugin.json` for full configuration schema.

### DM Policy

- `open`: Accept DMs from anyone
- `pairing`: Require email to be in allowlist (default)
- `closed`: Disable DMs

### Space Policy

- `open`: Accept messages from any space
- `pairing`: Require space ID in allowlist
- `closed`: Disable space messages (default)

## Setup Guide

Detailed setup instructions coming soon.

## Features

- ✅ Text messages
- ✅ Thread replies
- ✅ DM and space support
- ✅ Email-based allowlists
- ✅ Multi-account support
- ❌ Media upload (Google Chat API limitation)

## License

Same as Clawdbot
