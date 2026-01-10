---
summary: "Group chat behavior across surfaces (WhatsApp/Telegram/Discord/Slack/Signal/iMessage)"
read_when:
  - Changing group chat behavior or mention gating
---
# Groups

Clawdbot treats group chats consistently across surfaces: WhatsApp, Telegram, Discord, Slack, Signal, iMessage.

## Beginner intro (2 minutes)
Clawdbot “lives” on your own messaging accounts. There is no separate WhatsApp bot user.
If **you** are in a group, Clawdbot can see that group and respond there.

Default behavior:
- Groups are allowed (`groupPolicy: "open"`).
- Replies require a mention unless you explicitly disable mention gating.

Translation: anyone in the group can trigger Clawdbot by mentioning it.

> TL;DR
> - **DM access** is controlled by `*.allowFrom`.
> - **Group access** is controlled by `*.groupPolicy` + allowlists (`*.groups`, `*.groupAllowFrom`).
> - **Reply triggering** is controlled by mention gating (`requireMention`, `/activation`).

Quick flow (what happens to a group message):
```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Group message flow](/images/groups-flow.svg)

If you want...
| Goal | What to set |
|------|-------------|
| Allow all groups but only reply on @mentions | `groups: { "*": { requireMention: true } }` |
| Disable all group replies | `groupPolicy: "disabled"` |
| Only specific groups | `groups: { "<group-id>": { ... } }` (no `"*"` key) |
| Only you can trigger in groups | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |

## Session keys
- Group sessions use `agent:<agentId>:<provider>:group:<id>` session keys (rooms/channels use `agent:<agentId>:<provider>:channel:<id>`).
- Telegram forum topics add `:topic:<threadId>` to the group id so each topic has its own session.
- Direct chats use the main session (or per-sender if configured).
- Heartbeats are skipped for group sessions.

## Display labels
- UI labels use `displayName` when available, formatted as `<provider>:<token>`.
- `#room` is reserved for rooms/channels; group chats use `g-<slug>` (lowercase, spaces -> `-`, keep `#@+._-`).

## Group policy
Control how group/room messages are handled per provider:

```json5
{
  whatsapp: {
    groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
    groupAllowFrom: ["+15551234567"]
  },
  telegram: {
    groupPolicy: "disabled",
    groupAllowFrom: ["123456789", "@username"]
  },
  signal: {
    groupPolicy: "disabled",
    groupAllowFrom: ["+15551234567"]
  },
  imessage: {
    groupPolicy: "disabled",
    groupAllowFrom: ["chat_id:123"]
  },
  discord: {
    groupPolicy: "allowlist",
    guilds: {
      "GUILD_ID": { channels: { help: { allow: true } } }
    }
  },
  slack: {
    groupPolicy: "allowlist",
    channels: { "#general": { allow: true } }
  }
}
```

| Policy | Behavior |
|--------|----------|
| `"open"` | Default. Groups bypass allowlists; mention-gating still applies. |
| `"disabled"` | Block all group messages entirely. |
| `"allowlist"` | Only allow groups/rooms that match the configured allowlist. |

Notes:
- `groupPolicy` is separate from mention-gating (which requires @mentions).
- WhatsApp/Telegram/Signal/iMessage: use `groupAllowFrom` (fallback: explicit `allowFrom`).
- Discord: allowlist uses `discord.guilds.<id>.channels`.
- Slack: allowlist uses `slack.channels`.
- Group DMs are controlled separately (`discord.dm.*`, `slack.dm.*`).
- Telegram allowlist can match user IDs (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) or usernames (`"@alice"` or `"alice"`); prefixes are case-insensitive.

Quick mental model (evaluation order for group messages):
1) `groupPolicy` (open/disabled/allowlist)
2) group allowlists (`*.groups`, `*.groupAllowFrom`, provider-specific allowlist)
3) mention gating (`requireMention`, `/activation`)

## Mention gating (default)
Group messages require a mention unless overridden per group. Defaults live per subsystem under `*.groups."*"`.

```json5
{
  whatsapp: {
    groups: {
      "*": { requireMention: true },
      "123@g.us": { requireMention: false }
    }
  },
  telegram: {
    groups: {
      "*": { requireMention: true },
      "123456789": { requireMention: false }
    }
  },
  imessage: {
    groups: {
      "*": { requireMention: true },
      "123": { requireMention: false }
    }
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@clawd", "clawdbot", "\\+15555550123"],
          historyLimit: 50
        }
      }
    ]
  }
}
```

Notes:
- `mentionPatterns` are case-insensitive regexes.
- Surfaces that provide explicit mentions still pass; patterns are a fallback.
- Per-agent override: `agents.list[].groupChat.mentionPatterns` (useful when multiple agents share a group).
- Mention gating is only enforced when mention detection is possible (native mentions or `mentionPatterns` are configured).
- Discord defaults live in `discord.guilds."*"` (overridable per guild/channel).
- Group history context is wrapped uniformly across providers; use `messages.groupChat.historyLimit` for the global default and `<provider>.historyLimit` (or `<provider>.accounts.*.historyLimit`) for overrides. Set `0` to disable.

## Group allowlists
When `whatsapp.groups`, `telegram.groups`, or `imessage.groups` is configured, the keys act as a group allowlist. Use `"*"` to allow all groups while still setting default mention behavior.

Common intents (copy/paste):

1) Disable all group replies
```json5
{
  whatsapp: { groupPolicy: "disabled" }
}
```

2) Allow only specific groups (WhatsApp)
```json5
{
  whatsapp: {
    groups: {
      "123@g.us": { requireMention: true },
      "456@g.us": { requireMention: false }
    }
  }
}
```

3) Allow all groups but require mention (explicit)
```json5
{
  whatsapp: {
    groups: { "*": { requireMention: true } }
  }
}
```

4) Only the owner can trigger in groups (WhatsApp)
```json5
{
  whatsapp: {
    groupPolicy: "allowlist",
    groupAllowFrom: ["+15551234567"],
    groups: { "*": { requireMention: true } }
  }
}
```

## Activation (owner-only)
Group owners can toggle per-group activation:
- `/activation mention`
- `/activation always`

Owner is determined by `whatsapp.allowFrom` (or the bot’s self E.164 when unset). Send the command as a standalone message. Other surfaces currently ignore `/activation`.

## Context fields
Group inbound payloads set:
- `ChatType=group`
- `GroupSubject` (if known)
- `GroupMembers` (if known)
- `WasMentioned` (mention gating result)
- Telegram forum topics also include `MessageThreadId` and `IsForum`.

The agent system prompt includes a group intro on the first turn of a new group session.

## iMessage specifics
- Prefer `chat_id:<id>` when routing or allowlisting.
- List chats: `imsg chats --limit 20`.
- Group replies always go back to the same `chat_id`.

## WhatsApp specifics
See [Group messages](/concepts/group-messages) for WhatsApp-only behavior (history injection, mention handling details).
