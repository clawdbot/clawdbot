---
summary: "Zalo personal account support via native zca-js (QR login), capabilities, and configuration"
read_when:
  - Setting up Zalo Personal for OpenClaw
  - Debugging Zalo Personal login or message flow
title: "Zalo personal"
---

Status: experimental. This integration automates a **personal Zalo account** via native `zca-js`, in-process, with no external CLI binary.

<Warning>
This is an unofficial integration and may result in account suspension or ban. Use at your own risk.
</Warning>

## Install

Zalo Personal is an official external plugin, not bundled in core. Install it before use:

```bash
openclaw plugins install @openclaw/zalouser
```

- Pin a version: `openclaw plugins install @openclaw/zalouser@<version>`
- From a source checkout: `openclaw plugins install ./path/to/local/zalouser-plugin`
- Details: [Plugins](/tools/plugin)

## Quick setup

1. Install the plugin (above).
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

- Runs entirely in-process via the `zca-js` library (no external `zca`/`openzca` binary).
- Uses native event listeners (`message`, `error`) to receive inbound messages.
- Sends replies directly through the JS API (text/media/link).
- Designed for "personal account" use cases where the Zalo Bot API is not available.

## Naming

Channel id is `zalouser` to make it explicit this automates a **personal Zalo user account** (unofficial). `zalo` is reserved for a potential future official Zalo API integration.

## Finding IDs (directory)

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## Limits

- Outbound text is chunked to 2000 characters (Zalo client limit).
- Streaming is not supported.
- Completed inbound message ids are retained for 30 days, bounded to the 1000 most recent entries per account.

## Inbound durability

OpenClaw stores each raw `zca-js` message callback before processing it. Pending messages resume from the account queue after a Gateway restart, and processing stays serialized per direct chat or group.

The `zca-js` socket listener does not expose a delivery acknowledgement or automatically replay old messages after reconnect. The durable queue therefore protects the local crash window after a callback reaches OpenClaw; it cannot recover a message the socket never delivered. Replay tombstones are mostly a safeguard against a repeated callback with the same Zalo message id.

## Access control (DMs)

`channels.zalouser.dmPolicy`: `pairing | allowlist | open | disabled` (default: `pairing`).

`channels.zalouser.allowFrom` should use stable Zalo user IDs. It can also reference static sender access groups (`accessGroup:<name>`). During interactive setup, entered names can be resolved to IDs using the plugin's in-process contact lookup.

If a raw name remains in config, startup resolves it only when `channels.zalouser.dangerouslyAllowNameMatching: true` is enabled. Without that opt-in, runtime sender checks are ID-only and raw names are ignored for authorization.

Approve via:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## Group access (optional)

- Default: `channels.zalouser.groupPolicy = "allowlist"` (groups require an explicit allowlist entry).
- Open all groups: `channels.zalouser.groupPolicy = "open"`.
- Block all groups: `channels.zalouser.groupPolicy = "disabled"`.
- With `groupPolicy = "allowlist"`:
  - `channels.zalouser.groups` keys should be stable group IDs; names resolve to IDs on startup only when `channels.zalouser.dangerouslyAllowNameMatching: true` is enabled.
  - `channels.zalouser.groupAllowFrom` controls which senders in allowed groups can trigger the bot; static sender access groups can be referenced with `accessGroup:<name>`.
- The configure wizard can prompt for group allowlists.
- Group allowlist matching is ID-only by default. Unresolved names are ignored for auth unless `channels.zalouser.dangerouslyAllowNameMatching: true` is enabled.
- `channels.zalouser.dangerouslyAllowNameMatching: true` is a break-glass compatibility mode that re-enables mutable startup name resolution and runtime group-name matching.
- `groupAllowFrom` does **not** fall back to `allowFrom` for normal group messages: leaving it empty on an allowlisted group opens that group to any sender. Authorized control commands (for example `/new`) are the exception; command sender checks fall back to `allowFrom` when `groupAllowFrom` is empty.

Example:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["1471383327500481391"],
      groups: {
        "123456789": { enabled: true },
        "Work Chat": { enabled: true },
      },
    },
  },
}
```

<Note>
`channels.zalouser.groups.<id>.allow` is a legacy field name; current config uses `enabled`. `openclaw doctor --fix` migrates `allow` to `enabled` automatically.
</Note>

### Group mention gating

- `channels.zalouser.groups.<group>.requireMention` controls whether group replies require a mention.
- Resolution order: group id -> `group:<id>` alias -> group name/slug (name-based candidates only apply when `dangerouslyAllowNameMatching: true`) -> `*` -> default (`true`).
- Applies both to allowlisted groups and open group mode.
- Quoting a bot message counts as an implicit mention for group activation.
- Authorized control commands (for example `/new`) can bypass mention gating.
- When a group message is skipped because a mention is required, OpenClaw stores it as pending group history and includes it on the next processed group message.
- Group history limit: `channels.zalouser.historyLimit`, then `messages.groupChat.historyLimit`, then a fallback of `50`.

Example:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "*": { enabled: true, requireMention: true },
        "Work Chat": { enabled: true, requireMention: false },
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

## Environment variables

Profile selection can also come from environment variables:

| Var                | Purpose                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `ZALOUSER_PROFILE` | Profile name to use when no `profile` is set in channel or account config. |
| `ZCA_PROFILE`      | Legacy fallback, used only when `ZALOUSER_PROFILE` is not set.             |

Profile names select the saved Zalo login credentials in OpenClaw state. Resolution order:

1. Explicit `profile` in config.
2. `ZALOUSER_PROFILE`.
3. `ZCA_PROFILE`.
4. The account id for non-default accounts, or `default` for the default account.

For multi-account setups, prefer setting `profile` on each account in config so one environment variable does not make multiple accounts share the same login session.

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

- Use numeric IDs in `allowFrom`/`groupAllowFrom` and stable group IDs in `groups`. If you intentionally need exact friend/group names, enable `channels.zalouser.dangerouslyAllowNameMatching: true`.

**Upgraded from an old external `zca`/CLI-based setup:**

- Remove any external `zca` process assumptions; the channel now runs fully in-process via `zca-js`, with no external CLI binary.

## Related

- [Channels Overview](/channels) - all supported channels
- [Pairing](/channels/pairing) - DM authentication and pairing flow
- [Groups](/channels/groups) - group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) - session routing for messages
- [Security](/gateway/security) - access model and hardening
