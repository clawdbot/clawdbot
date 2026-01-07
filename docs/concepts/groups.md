---
summary: "Group chat behavior across surfaces (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Matrix)"
read_when:
  - Changing group chat behavior or mention gating
---
# Groups

Clawdbot treats group chats consistently across surfaces: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Matrix.

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
  },
  matrix: {
    groupPolicy: "allowlist",
    rooms: { "!roomid:example": { allow: true } }
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
- Matrix: allowlist uses `matrix.rooms`.
- Group DMs are controlled separately (`discord.dm.*`, `slack.dm.*`).
- Telegram allowlist can match user IDs (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) or usernames (`"@alice"` or `"alice"`); prefixes are case-insensitive.

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
  matrix: {
    rooms: {
      "*": { requireMention: true },
      "!roomid:example": { requireMention: false }
    }
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@clawd", "clawdbot", "\\+15555550123"],
      historyLimit: 50
    }
  }
}
```

Notes:
- `mentionPatterns` are case-insensitive regexes.
- Surfaces that provide explicit mentions still pass; patterns are a fallback.
- Mention gating is only enforced when mention detection is possible (native mentions or `mentionPatterns` are configured).
- Discord defaults live in `discord.guilds."*"` (overridable per guild/channel).

## Group allowlists
When `whatsapp.groups`, `telegram.groups`, `imessage.groups`, or `matrix.rooms` is configured, the keys act as a group allowlist. Use `"*"` to allow all groups while still setting default mention behavior.

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

## Matrix specifics
- Prefer room ids (`!roomid:server`) in allowlists and delivery targets.
- DMs are detected from `m.direct` only; rooms not flagged there are treated as group rooms.
- Thread replies stay in-thread when the inbound message is threaded (`matrix.threadReplies`).

## WhatsApp specifics
See [`docs/group-messages.md`](/concepts/group-messages) for WhatsApp-only behavior (history injection, mention handling details).
