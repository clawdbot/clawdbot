---
summary: "Zalo personal account support via zca-cli (QR login), capabilities, and configuration"
read_when:
  - Setting up Zalo Personal for Moltbot
  - Debugging Zalo Personal login or message flow
---
# Zalo Personal (unofficial)

Status: experimental. This integration automates a **personal Zalo account** via `zca-cli`.

> **Warning:** This is an unofficial integration and may result in account suspension/ban. Use at your own risk.

## Plugin required
Zalo Personal ships as a plugin and is not bundled with the core install.
- Install via CLI: `moltbot plugins install @moltbot/zalouser`
- Or from a source checkout: `moltbot plugins install ./extensions/zalouser`
- Details: [Plugins](/plugin)

## Prerequisite: zca-cli
The Gateway machine must have the `zca` binary available in `PATH`.

- Verify: `zca --version`
- If missing, install zca-cli (see `extensions/zalouser/README.md` or the upstream zca-cli docs).

## Quick setup (beginner)
1) Install the plugin (see above).
2) Login (QR, on the Gateway machine):
   - `moltbot channels login --channel zalouser`
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
moltbot directory self --channel zalouser
moltbot directory peers list --channel zalouser --query "name"
moltbot directory groups list --channel zalouser --query "work"
```

## Limits
- Outbound text is chunked to ~2000 characters (Zalo client limits).
- Streaming is blocked by default.

## Access control (DMs)
`channels.zalouser.dmPolicy` supports: `pairing | allowlist | open | disabled` (default: `pairing`).
`channels.zalouser.allowFrom` accepts user IDs or names. The wizard resolves names to IDs via `zca friend find` when available.

Approve via:
- `moltbot pairing list zalouser`
- `moltbot pairing approve zalouser <code>`

## Group access (optional)
- Default: `channels.zalouser.groupPolicy = "open"` (groups allowed). Use `channels.defaults.groupPolicy` to override the default when unset.
- Restrict to an allowlist with:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (keys are group IDs or names)
- Block all groups: `channels.zalouser.groupPolicy = "disabled"`.
- The configure wizard can prompt for group allowlists.
- On startup, Moltbot resolves group/user names in allowlists to IDs and logs the mapping; unresolved entries are kept as typed.

Example:
```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true }
      }
    }
  }
}
```

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
- `moltbot channels status --probe`
- Re-login: `moltbot channels logout --channel zalouser && moltbot channels login --channel zalouser`
