---
summary: "Group chat behavior across surfaces (Discord/iMessage/Matrix/Microsoft Teams/Signal/Slack/Telegram/WhatsApp/Zalo)"
read_when:
  - Changing group chat behavior or mention gating
title: "Groups"
---

OpenClaw treats group chats consistently across surfaces: Discord, iMessage, Matrix, Microsoft Teams, Signal, Slack, Telegram, WhatsApp, Zalo.

## Beginner intro (2 minutes)

OpenClaw “lives” on your own messaging accounts. There is no separate WhatsApp bot user.
If **you** are in a group, OpenClaw can see that group and respond there.

Default behavior:

- Groups are restricted (`groupPolicy: "allowlist"`).
- Replies require a mention unless you explicitly disable mention gating.

Translation: allowlisted senders can trigger OpenClaw by mentioning it.

> TL;DR
>
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

## Context visibility and allowlists

Two different controls are involved in group safety:

- **Trigger authorization**: who can trigger the agent (`groupPolicy`, `groups`, `groupAllowFrom`, channel-specific allowlists).
- **Context visibility**: what supplemental context is injected into the model (reply text, quotes, thread history, forwarded metadata).

By default, OpenClaw prioritizes normal chat behavior and keeps context mostly as received. This means allowlists primarily decide who can trigger actions, not a universal redaction boundary for every quoted or historical snippet.

Current behavior is channel-specific:

- Some channels already apply sender-based filtering for supplemental context in specific paths (for example Slack thread seeding, Matrix reply/thread lookups).
- Other channels still pass quote/reply/forward context through as received.

Hardening direction (planned):

- `contextVisibility: "all"` (default) keeps current as-received behavior.
- `contextVisibility: "allowlist"` filters supplemental context to allowlisted senders.
- `contextVisibility: "allowlist_quote"` is `allowlist` plus one explicit quote/reply exception.

Until this hardening model is implemented consistently across channels, expect differences by surface.

![Group message flow](/images/groups-flow.svg)

If you want...

| Goal                                         | What to set                                                |
| -------------------------------------------- | ---------------------------------------------------------- |
| Allow all groups but only reply on @mentions | `groups: { "*": { requireMention: true } }`                |
| Disable all group replies                    | `groupPolicy: "disabled"`                                  |
| Only specific groups                         | `groups: { "<group-id>": { ... } }` (no `"*"` key)         |
| Only you can trigger in groups               | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |

## Session keys

- Group sessions use `agent:<agentId>:<channel>:group:<id>` session keys (rooms/channels use `agent:<agentId>:<channel>:channel:<id>`).
- Telegram forum topics add `:topic:<threadId>` to the group id so each topic has its own session.
- Direct chats use the main session (or per-sender if configured).
- Heartbeats are skipped for group sessions.

<a id="pattern-personal-dms-public-groups-single-agent"></a>

## Pattern: personal DMs + public groups (single agent)

Yes — this works well if your “personal” traffic is **DMs** and your “public” traffic is **groups**.

Why: in single-agent mode, DMs typically land in the **main** session key (`agent:main:main`), while groups always use **non-main** session keys (`agent:main:<channel>:group:<id>`). If you enable sandboxing with `mode: "non-main"`, those group sessions run in the configured sandbox backend while your main DM session stays on-host. Docker is the default backend if you do not choose one.

This gives you one agent “brain” (shared workspace + memory), but two execution postures:

- **DMs**: full tools (host)
- **Groups**: sandbox + restricted tools

> If you need truly separate workspaces/personas (“personal” and “public” must never mix), use a second agent + bindings. See [Multi-Agent Routing](/concepts/multi-agent).

Example (DMs on host, groups sandboxed + messaging-only tools):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // groups/channels are non-main -> sandboxed
        scope: "session", // strongest isolation (one container per group/channel)
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // If allow is non-empty, everything else is blocked (deny still wins).
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

Want “groups can only see folder X” instead of “no host access”? Keep `workspaceAccess: "none"` and mount only allowlisted paths into the sandbox:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
        docker: {
          binds: [
            // hostPath:containerPath:mode
            "/home/user/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

Related:

- Configuration keys and defaults: [Gateway configuration](/gateway/config-agents#agentsdefaultssandbox)
- Debugging why a tool is blocked: [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- Bind mounts details: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## Display labels

- UI labels use `displayName` when available, formatted as `<channel>:<token>`.
- `#room` is reserved for rooms/channels; group chats use `g-<slug>` (lowercase, spaces -> `-`, keep `#@+._-`).

## Group policy

Control how group/room messages are handled per channel:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789"], // numeric Telegram user id (wizard can resolve @username)
    },
    signal: {
      groupPolicy: "disabled",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "disabled",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "disabled",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: { channels: { help: { allow: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
    matrix: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["@owner:example.org"],
      groups: {
        "!roomId:example.org": { enabled: true },
        "#alias:example.org": { enabled: true },
      },
    },
  },
}
```

| Policy        | Behavior                                                     |
| ------------- | ------------------------------------------------------------ |
| `"open"`      | Groups bypass allowlists; mention-gating still applies.      |
| `"disabled"`  | Block all group messages entirely.                           |
| `"allowlist"` | Only allow groups/rooms that match the configured allowlist. |

Notes:

- `groupPolicy` is separate from mention-gating (which requires @mentions).
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams/Zalo: use `groupAllowFrom` (fallback: explicit `allowFrom`).
- DM pairing approvals (`*-allowFrom` store entries) apply to DM access only; group sender authorization stays explicit to group allowlists.
- Discord: allowlist uses `channels.discord.guilds.<id>.channels`.
- Slack: allowlist uses `channels.slack.channels`.
- Matrix: allowlist uses `channels.matrix.groups`. Prefer room IDs or aliases; joined-room name lookup is best-effort, and unresolved names are ignored at runtime. Use `channels.matrix.groupAllowFrom` to restrict senders; per-room `users` allowlists are also supported.
- Group DMs are controlled separately (`channels.discord.dm.*`, `channels.slack.dm.*`).
- Telegram allowlist can match user IDs (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) or usernames (`"@alice"` or `"alice"`); prefixes are case-insensitive.
- Default is `groupPolicy: "allowlist"`; if your group allowlist is empty, group messages are blocked.
- Runtime safety: when a provider block is completely missing (`channels.<provider>` absent), group policy falls back to a fail-closed mode (typically `allowlist`) instead of inheriting `channels.defaults.groupPolicy`.

Quick mental model (evaluation order for group messages):

1. `groupPolicy` (open/disabled/allowlist)
2. group allowlists (`*.groups`, `*.groupAllowFrom`, channel-specific allowlist)
3. mention gating (`requireMention`, `/activation`)

## Mention gating (default)

Group messages require a mention unless overridden per group. Defaults live per subsystem under `*.groups."*"`.

Replying to a bot message counts as an implicit mention when the channel
supports reply metadata. Quoting a bot message can also count as an implicit
mention on channels that expose quote metadata. Current built-in cases include
Telegram, WhatsApp, Slack, Discord, Microsoft Teams, and ZaloUser.

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
        "123@g.us": { requireMention: false },
      },
    },
    telegram: {
      groups: {
        "*": { requireMention: true },
        "123456789": { requireMention: false },
      },
    },
    imessage: {
      groups: {
        "*": { requireMention: true },
        "123": { requireMention: false },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@openclaw", "openclaw", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    ],
  },
}
```

Notes:

- `mentionPatterns` are case-insensitive safe regex patterns; invalid patterns and unsafe nested-repetition forms are ignored.
- Surfaces that provide explicit mentions still pass; patterns are a fallback.
- Per-agent override: `agents.list[].groupChat.mentionPatterns` (useful when multiple agents share a group).
- Mention gating is only enforced when mention detection is possible (native mentions or `mentionPatterns` are configured).
- Discord defaults live in `channels.discord.guilds."*"` (overridable per guild/channel).
- Group history context is wrapped uniformly across channels and is **pending-only** (messages skipped due to mention gating); use `messages.groupChat.historyLimit` for the global default and `channels.<channel>.historyLimit` (or `channels.<channel>.accounts.*.historyLimit`) for overrides. Set `0` to disable.

## Group/channel tool restrictions (optional)

Some channel configs support restricting which tools are available **inside a specific group/room/channel**.

- `tools`: allow/deny tools for the whole group.
- `toolsBySender`: per-sender overrides within the group.
  Use explicit key prefixes:
  `id:<senderId>`, `e164:<phone>`, `username:<handle>`, `name:<displayName>`, and `"*"` wildcard.
  Legacy unprefixed keys are still accepted and matched as `id:` only.

Resolution order (most specific wins):

1. group/channel `toolsBySender` match
2. group/channel `tools`
3. default (`"*"`) `toolsBySender` match
4. default (`"*"`) `tools`

Example (Telegram):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "id:123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

Notes:

- Group/channel tool restrictions are applied in addition to global/agent tool policy (deny still wins).
- Some channels use different nesting for rooms/channels (e.g., Discord `guilds.*.channels.*`, Slack `channels.*`, Microsoft Teams `teams.*.channels.*`).

## Group allowlists

When `channels.whatsapp.groups`, `channels.telegram.groups`, or `channels.imessage.groups` is configured, the keys act as a group allowlist. Use `"*"` to allow all groups while still setting default mention behavior.

Common confusion: DM pairing approval is not the same as group authorization.
For channels that support DM pairing, the pairing store unlocks DMs only. Group commands still require explicit group sender authorization from config allowlists such as `groupAllowFrom` or the documented config fallback for that channel.

Common intents (copy/paste):

1. Disable all group replies

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. Allow only specific groups (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "123@g.us": { requireMention: true },
        "456@g.us": { requireMention: false },
      },
    },
  },
}
```

3. Allow all groups but require mention (explicit)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. Only the owner can trigger in groups (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## Activation (owner-only)

Group owners can toggle per-group activation:

- `/activation mention`
- `/activation always`

Owner is determined by `channels.whatsapp.allowFrom` (or the bot’s self E.164 when unset). Send the command as a standalone message. Other surfaces currently ignore `/activation`.

## Context fields

Group inbound payloads set:

- `ChatType=group`
- `GroupSubject` (if known)
- `GroupMembers` (if known)
- `WasMentioned` (mention gating result)
- Telegram forum topics also include `MessageThreadId` and `IsForum`.

Channel specific notes:

- BlueBubbles can optionally enrich unnamed macOS group participants from the local Contacts database before populating `GroupMembers`. This is off by default and only runs after normal group gating passes.

The agent system prompt includes a group intro on the first turn of a new group session. It reminds the model to respond like a human, avoid Markdown tables, minimize empty lines and follow normal chat spacing, and avoid typing literal `\n` sequences. Channel-sourced group names and participant labels are rendered as fenced untrusted metadata, not inline system instructions.

## iMessage specifics

- Prefer `chat_id:<id>` when routing or allowlisting.
- List chats: `imsg chats --limit 20`.
- Group replies always go back to the same `chat_id`.

## WhatsApp system prompts

See [WhatsApp](/channels/whatsapp#system-prompts) for the canonical WhatsApp system prompt rules, including group and direct prompt resolution, wildcard behavior, and account override semantics.

## WhatsApp specifics

See [Group messages](/channels/group-messages) for WhatsApp-only behavior (history injection, mention handling details).

## Related

- [Group messages](/channels/group-messages)
- [Broadcast groups](/channels/broadcast-groups)
- [Channel routing](/channels/channel-routing)
- [Pairing](/channels/pairing)
