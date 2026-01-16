---
summary: "Zalo personal account support via zca-cli (QR login), capabilities, and configuration"
read_when:
  - Setting up Zalo Personal for Clawdbot
  - Debugging Zalo Personal login or message flow
---
# Zalo Personal (unofficial)

Status: experimental. This integration automates a **personal Zalo account** via `zca-cli`.

> **Warning:** This is an unofficial integration and may result in account suspension/ban. Use at your own risk.

## Plugin required
Zalo Personal ships as a plugin and is not bundled with the core install.
- Install via CLI: `clawdbot plugins install @clawdbot/zalouser`
- Or from a source checkout: `clawdbot plugins install ./extensions/zalouser`
- Details: [Plugins](/plugin)

## Prerequisite: zca-cli
The Gateway machine must have the `zca` binary available in `PATH`.

- Verify: `zca --version`
- If missing, install zca-cli (see `extensions/zalouser/README.md` or the upstream zca-cli docs).

## Quick setup (beginner)
1) Install the plugin (see above).
2) Login (QR, on the Gateway machine):
   - `clawdbot channels login --channel zalouser`
   - Scan the QR code in the terminal with the Zalo mobile app.
3) Enable the channel:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing"
    }
  }
}
```

4) Restart the Gateway (or finish onboarding).
5) DM access defaults to pairing; approve the pairing code on first contact.

## What it is
- Uses `zca listen` to receive inbound messages.
- Uses `zca msg ...` to send replies (text/media/link).
- Designed for “personal account” use cases where Zalo Bot API is not available.

## Naming
Channel id is `zalouser` to make it explicit this automates a **personal Zalo user account** (unofficial). We keep `zalo` reserved for a potential future official Zalo API integration.

## Finding IDs (directory)
Use the directory CLI to discover peers/groups and their IDs:

```bash
clawdbot directory self --channel zalouser
clawdbot directory peers list --channel zalouser --query "name"
clawdbot directory groups list --channel zalouser --query "work"
```

## Limits
- Outbound text is chunked to ~2000 characters (Zalo client limits).
- Streaming is blocked by default.

## Access control (DMs)
`channels.zalouser.dmPolicy` supports: `pairing | allowlist | open | disabled` (default: `pairing`).

Approve via:
- `clawdbot pairing list zalouser`
- `clawdbot pairing approve zalouser <code>`

## Multi-account
Accounts map to zca profiles. Example:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" }
      }
    }
  }
}
```

## Troubleshooting

**`zca` not found:**
- Install zca-cli and ensure it’s on `PATH` for the Gateway process.

**Login doesn’t stick:**
- `clawdbot channels status --probe`
- Re-login: `clawdbot channels logout --channel zalouser && clawdbot channels login --channel zalouser`
