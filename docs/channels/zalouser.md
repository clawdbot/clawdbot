---
summary: "Zalo personal account support via native zca-js (QR login), capabilities, and configuration"
read_when:
  - Setting up Zalo Personal for OpenClaw
  - Debugging Zalo Personal login or message flow
title: "Zalo personal"
---

Status: experimental. This integration automates a **personal Zalo account** via native `zca-js` inside OpenClaw.

<Warning>
This is an unofficial integration and may result in account suspension or ban. Use at your own risk.
</Warning>

## Bundled plugin

Zalo Personal ships as a bundled plugin in current OpenClaw releases, so normal
packaged builds do not need a separate install.

If you are on an older build or a custom install that excludes Zalo Personal,
install it manually:

- Install via CLI: `openclaw plugins install @openclaw/zalouser`
- Or from a source checkout: `openclaw plugins install ./path/to/local/zalouser-plugin`
- Details: [Plugins](/tools/plugin)

No external `zca`/`openzca` CLI binary is required.

## Quick setup (beginner)

1. Ensure the Zalo Personal plugin is available.
   - Current packaged OpenClaw releases already bundle it.
   - Older/custom installs can add it manually with the commands above.
2. Login (QR, on the Gateway machine):
   - `openclaw channels login --channel zalouser`
   - Scan the QR code with the Zalo mobile app.
3. Enable the channel:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

4. Restart the Gateway (or finish setup).
5. DM access defaults to pairing; approve the pairing code on first contact.

## What it is

- Runs entirely in-process via `zca-js`.
- Uses native event listeners to receive inbound messages.
- Sends replies directly through the JS API (text/media/link).
- Designed for “personal account” use cases where Zalo Bot API is not available.

## Naming

Channel id is `zalouser` to make it explicit this automates a **personal Zalo user account** (unofficial). We keep `zalo` reserved for a potential future official Zalo API integration.

## Finding IDs (directory)

Use the directory CLI to discover peers/groups and their IDs:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## Limits

- Outbound text is chunked to ~2000 characters (Zalo client limits).
- Streaming is blocked by default.

## Access control (DMs)

`channels.zalouser.dmPolicy` supports: `pairing | allowlist | open | disabled` (default: `pairing`).

`channels.zalouser.allowFrom` accepts user IDs or names. During setup, names are resolved to IDs using the plugin's in-process contact lookup.

Approve via:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## Group access (optional)

- Default: `channels.zalouser.groupPolicy = "open"` (groups allowed). Use `channels.defaults.groupPolicy` to override the default when unset.
- Restrict to an allowlist with:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (keys should be stable group IDs; names are resolved to IDs on startup when possible)
  - `channels.zalouser.groupAllowFrom` (controls which senders in allowed groups can trigger the bot)
- Block all groups: `channels.zalouser.groupPolicy = "disabled"`.
- The configure wizard can prompt for group allowlists.
- On startup, OpenClaw resolves group/user names in allowlists to IDs and logs the mapping.
- Group allowlist matching is ID-only by default. Unresolved names are ignored for auth unless `channels.zalouser.dangerouslyAllowNameMatching: true` is enabled.
- `channels.zalouser.dangerouslyAllowNameMatching: true` is a break-glass compatibility mode that re-enables mutable group-name matching.
- If `groupAllowFrom` is unset, runtime falls back to `allowFrom` for group sender checks.
- Sender checks apply to both normal group messages and control commands (for example `/new`, `/reset`).

Example:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["1471383327500481391"],
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

### Group mention gating

- `channels.zalouser.groups.<group>.requireMention` controls whether group replies require a mention.
- Resolution order: exact group id/name -> normalized group slug -> `*` -> default (`true`).
- This applies both to allowlisted groups and open group mode.
- Quoting a bot message counts as an implicit mention for group activation.
- Authorized control commands (for example `/new`) can bypass mention gating.
- When a group message is skipped because mention is required, OpenClaw stores it as pending group history and includes it on the next processed group message.
- Group history limit defaults to `messages.groupChat.historyLimit` (fallback `50`). You can override per account with `channels.zalouser.historyLimit`.

Example:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "*": { allow: true, requireMention: true },
        "Work Chat": { allow: true, requireMention: false },
      },
    },
  },
}
```

## Multi-account

Accounts map to `zalouser` profiles in OpenClaw state. Example:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## Typing, reactions, and delivery acknowledgements

- OpenClaw sends a typing event before dispatching a reply (best-effort).
- Message reaction action `react` is supported for `zalouser` in channel actions.
  - Use `remove: true` to remove a specific reaction emoji from a message.
  - Reaction semantics: [Reactions](/tools/reactions)
- For inbound messages that include event metadata, OpenClaw sends delivered + seen acknowledgements (best-effort).

## Troubleshooting

**Login doesn't stick:**

- `openclaw channels status --probe`
- Re-login: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`

**Allowlist/group name didn't resolve:**

- Use numeric IDs in `allowFrom`/`groupAllowFrom`/`groups`, or exact friend/group names.

**Upgraded from old CLI-based setup:**

- Remove any old external `zca` process assumptions.
- The channel now runs fully in OpenClaw without external CLI binaries.

## Related

- [Channels Overview](/channels) — all supported channels
- [Pairing](/channels/pairing) — DM authentication and pairing flow
- [Groups](/channels/groups) — group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Security](/gateway/security) — access model and hardening
