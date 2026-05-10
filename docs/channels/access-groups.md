---
summary: "Reusable sender allowlists for message channels"
read_when:
  - Configuring the same allowlist across multiple message channels
  - Sharing DM and group sender access rules
  - Reviewing message-channel access control
title: "Access groups"
---

Access groups are named sender lists you define once and reference from channel allowlists with `accessGroup:<name>`.

Use them when the same people should be allowed across several message channels, or when one trusted set should apply to both DMs and group sender authorization.

Access groups do not grant access by themselves. A group only matters when an allowlist field references it.

## Static message sender groups

Static sender groups use `type: "message.senders"`.

```json5
{
  accessGroups: {
    operators: {
      type: "message.senders",
      members: {
        "*": ["global-owner-id"],
        discord: ["discord:123456789012345678"],
        telegram: ["987654321"],
        whatsapp: ["+15551234567"],
      },
    },
  },
}
```

Member lists are keyed by message-channel id:

| Key        | Meaning                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `"*"`      | Shared entries checked for every message channel that references group. |
| `discord`  | Entries checked only for Discord allowlist matching.                    |
| `telegram` | Entries checked only for Telegram allowlist matching.                   |
| `whatsapp` | Entries checked only for WhatsApp allowlist matching.                   |

Entries are matched with the destination channel's normal `allowFrom` rules. OpenClaw does not translate sender ids between channels. If Alice has a Telegram id and a Discord id, list both ids under the appropriate keys.

## Reference groups from allowlists

Reference a group with `accessGroup:<name>` anywhere the message channel path supports sender allowlists.

DM allowlist example:

```json5
{
  accessGroups: {
    operators: {
      type: "message.senders",
      members: {
        discord: ["discord:123456789012345678"],
        telegram: ["987654321"],
      },
    },
  },
  channels: {
    discord: {
      dmPolicy: "allowlist",
      allowFrom: ["accessGroup:operators"],
    },
    telegram: {
      dmPolicy: "allowlist",
      allowFrom: ["accessGroup:operators"],
    },
  },
}
```

Group sender allowlist example:

```json5
{
  accessGroups: {
    oncall: {
      type: "message.senders",
      members: {
        whatsapp: ["+15551234567"],
        googlechat: ["users/1234567890"],
      },
    },
  },
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["accessGroup:oncall"],
    },
    googlechat: {
      spaces: {
        "spaces/AAA": {
          users: ["accessGroup:oncall"],
        },
      },
    },
  },
}
```

You can mix groups and direct entries:

```json5
{
  channels: {
    discord: {
      dmPolicy: "allowlist",
      allowFrom: ["accessGroup:operators", "discord:123456789012345678"],
    },
  },
}
```

## Supported message-channel paths

Access groups are available in shared message-channel authorization paths, including:

- DM sender allowlists such as `channels.<channel>.allowFrom`
- group sender allowlists such as `channels.<channel>.groupAllowFrom`
- channel-specific per-room sender allowlists that use the same sender matching rules
- command authorization paths that reuse message-channel sender allowlists

Channel support depends on whether that channel is wired through the shared OpenClaw sender-authorization helpers. Current bundled support includes Discord, Feishu, Google Chat, iMessage, LINE, Mattermost, Microsoft Teams, Nextcloud Talk, Nostr, QQBot, Signal, WhatsApp, Zalo, and Zalo Personal. Static `message.senders` groups are designed to be channel-agnostic, so new message channels should support them by using the shared plugin SDK helpers instead of custom allowlist expansion.

## Plugin diagnostics

Plugin authors can inspect structured access-group state without expanding it back into a flat allowlist:

```typescript
import { resolveAccessGroupAllowFromState } from "openclaw/plugin-sdk/security-runtime";

const state = await resolveAccessGroupAllowFromState({
  accessGroups: cfg.accessGroups,
  allowFrom: channelConfig.allowFrom,
  channel: "my-channel",
  accountId: "default",
  senderId,
  isSenderAllowed,
});
```

The result reports referenced, matched, missing, unsupported, and failed groups. Use this when you need diagnostics or conformance tests. Use `expandAllowFromWithAccessGroups(...)` only for compatibility paths that still expect a flat `allowFrom` array.

## Discord channel audiences

Discord also supports a dynamic access group type:

```json5
{
  accessGroups: {
    maintainers: {
      type: "discord.channelAudience",
      guildId: "1456350064065904867",
      channelId: "1456744319972282449",
      membership: "canViewChannel",
    },
  },
  channels: {
    discord: {
      dmPolicy: "allowlist",
      allowFrom: ["accessGroup:maintainers"],
    },
  },
}
```

`discord.channelAudience` means "allow Discord DM senders who can currently view this guild channel." OpenClaw resolves the sender through Discord at authorization time and applies Discord `ViewChannel` permission rules.

Use this when a Discord channel is already the source of truth for a team, such as `#maintainers` or `#on-call`.

Requirements and failure behavior:

- The bot needs access to the guild and channel.
- The bot needs the Discord Developer Portal **Server Members Intent**.
- The access group fails closed when Discord returns `Missing Access`, the sender cannot be resolved as a guild member, or the channel belongs to another guild.

More Discord-specific examples: [Discord access control](/channels/discord#access-control-and-routing)

## Security notes

- Access groups are allowlist aliases, not roles. They do not create owners, approve pairing requests, or grant tool permissions by themselves.
- `dmPolicy: "open"` still requires `"*"` in the effective DM allowlist. Referencing an access group is not the same as public access.
- Missing group names fail closed. If `allowFrom` contains `accessGroup:operators` and `accessGroups.operators` is absent, that entry authorizes nobody.
- Keep channel ids stable. Prefer numeric/user ids over display names when the channel supports both.

## Troubleshooting

If a sender should match but is blocked:

1. Confirm the allowlist field contains the exact `accessGroup:<name>` reference.
2. Confirm `accessGroups.<name>.type` is correct.
3. Confirm the sender id is listed under the matching channel key, or under `"*"`.
4. Confirm the entry uses that channel's normal allowlist syntax.
5. For Discord channel audiences, confirm the bot can see the guild channel and has Server Members Intent enabled.

Run `openclaw doctor` after editing access-control config. It catches many invalid allowlist and policy combinations before runtime.
