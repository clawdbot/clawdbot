---
summary: "Group chat behavior across surfaces (Discord/iMessage/Matrix/Microsoft Teams/QQBot/Signal/Slack/Telegram/WhatsApp/Zalo)"
read_when:
  - Changing group chat behavior or mention gating
  - Scoping mentionPatterns to specific group conversations
title: "Groups"
sidebarTitle: "Groups"
---

OpenClaw applies the same group rules across group-capable channels, including Discord, iMessage, Matrix, Microsoft Teams, QQBot, Signal, Slack, Telegram, WhatsApp, and Zalo.

For always-on rooms that should provide quiet context unless the agent explicitly sends a visible message, see [Ambient room events](/channels/ambient-room-events).

## Beginner intro (2 minutes)

OpenClaw "lives" on your own messaging accounts. There is no separate WhatsApp bot user: if **you** are in a group, OpenClaw can see that group and respond there.

Default behavior:

- Groups are restricted (`groupPolicy: "allowlist"`); group senders are blocked until allowlisted.
- Replies require a mention unless you disable mention gating for a group.
- Final reply text posts to the room automatically (`visibleReplies: "automatic"`).

Translation: allowlisted senders can trigger OpenClaw by mentioning it.

<Note>
**TL;DR**

- **DM access** is controlled by `*.allowFrom`.
- **Group access** is controlled by `*.groupPolicy` + allowlists (`*.groups`, `*.groupAllowFrom`).
- **Reply triggering** is controlled by mention gating (`requireMention`, `/activation`).

</Note>

Quick flow (what happens to a group message):

```text
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
mention/reply/command/DM -> user request
always-on group chatter -> user request, or room event when configured
```

## Visible replies

For normal group/channel requests, OpenClaw defaults to `messages.groupChat.visibleReplies: "automatic"`: the final assistant text posts to the room as the visible reply.

Use `messages.groupChat.visibleReplies: "message_tool"` when a shared room should let the agent decide when to speak by calling `message(action=send)`. This works best with tool-reliable models (for example GPT-5.6 Sol). If the model misses the tool and returns substantive final text, OpenClaw keeps that text private instead of posting it to the room.

Use `"automatic"` for models or runtimes that do not reliably follow tool-only delivery: normal text finals post directly to the room, and the agent may still call `message(action=send)` for files, images, or other attachments that cannot ride along with the final text.

If the message tool is unavailable under the active tool policy, OpenClaw falls back to automatic visible replies instead of silently suppressing the response. `openclaw doctor` warns about this mismatch.

For direct chats and any other source event, `messages.visibleReplies: "message_tool"` applies the same tool-only behavior globally; `messages.groupChat.visibleReplies` remains the more specific override for group/channel rooms. Internal WebChat direct turns default to automatic final-reply delivery so Pi and Codex receive the same visible-reply contract.

Tool-only mode replaces the old pattern of forcing the model to answer `NO_REPLY` for most lurk-mode turns. In tool-only mode the prompt does not define a `NO_REPLY` contract; doing nothing visible simply means not calling the message tool.

Plugin-owned conversation bindings are the exception. Once a plugin binds a thread and claims the inbound turn, the plugin's returned reply is the visible binding response; it does not need `message(action=send)`. That reply is plugin runtime output, not private model final text.

Typing indicators are still sent for direct group requests. Ambient always-on room events, when enabled, stay strict and quiet unless the agent calls the message tool.

Sessions suppress verbose tool/progress summaries by default. Use `/verbose on` (or `/verbose full`) to show them for the current session while debugging, and `/verbose off` to return to final-reply-only behavior. Verbose state is per session and works the same in direct chats, groups, channels, and forum topics.

To submit unmentioned always-on group chatter as quiet room context instead of user requests, use [Ambient room events](/channels/ambient-room-events):

```json5
{
  messages: {
    groupChat: {
      unmentionedInbound: "room_event",
    },
  },
}
```

The default is `unmentionedInbound: "user_request"`. Mentioned messages, commands, abort requests, and DMs stay user requests.

To require visible output to go through the message tool for group/channel requests:

```json5
{
  messages: {
    groupChat: {
      visibleReplies: "message_tool",
    },
  },
}
```

To require it for every source chat:

```json5
{
  messages: {
    visibleReplies: "message_tool",
  },
}
```

The gateway picks up `messages` config changes without a restart after the file is saved. Restart only when config reload is disabled (`gateway.reload.mode: "off"`).

Command turns bypass `visibleReplies: "message_tool"` and always reply visibly: native slash commands (Discord, Telegram, and other surfaces with native command support) and authorized text `/...` commands both post their response to the source chat. Unauthorized text `/...` turns in groups stay message-tool-only; ordinary chat turns follow the configured default.

## Context visibility and allowlists

Two different controls are involved in group safety:

- **Trigger authorization**: who can trigger the agent (`groupPolicy`, `groups`, `groupAllowFrom`, channel-specific allowlists).
- **Context visibility**: what supplemental context is injected into the model (reply/quote text, thread history, forwarded metadata).

By default OpenClaw keeps context as received: allowlists decide who can trigger actions, not what quoted or historical snippets the model sees. To also filter supplemental context, set `contextVisibility`:

| Mode                | Behavior                                                                         |
| ------------------- | -------------------------------------------------------------------------------- |
| `"all"` (default)   | Keep supplemental context as received.                                           |
| `"allowlist"`       | Only inject history/thread/quote/forwarded context from allowlisted senders.     |
| `"allowlist_quote"` | `allowlist`, plus keep the explicitly quoted/replied-to message from any sender. |

Set it per channel (`channels.<channel>.contextVisibility`), per account (`channels.<channel>.accounts.<accountId>.contextVisibility`), or globally (`channels.defaults.contextVisibility`). Channels that fetch supplemental context (Discord, Feishu, iMessage, Matrix, Microsoft Teams, Signal, Slack, Telegram, WhatsApp) apply the policy when building inbound context; unknown policy combinations fail closed and omit the context.

![Group message flow](/images/groups-flow.svg)

If you want...

| Goal                                         | What to set                                                |
| -------------------------------------------- | ---------------------------------------------------------- |
| Allow all groups but only reply on @mentions | `groups: { "*": { requireMention: true } }`                |
| Disable all group replies                    | `groupPolicy: "disabled"`                                  |
| Only specific groups                         | `groups: { "<group-id>": { ... } }` (no `"*"` key)         |
| Only you can trigger in groups               | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |
| Reuse one trusted sender set across channels | `groupAllowFrom: ["accessGroup:operators"]`                |

For reusable sender allowlists, see [Access groups](/channels/access-groups).

## Session keys

- Group sessions use `agent:<agentId>:<channel>:group:<id>` session keys (rooms/channels use `agent:<agentId>:<channel>:channel:<id>`).
- Telegram forum topics add `:topic:<threadId>` to the group id so each topic has its own session.
- Direct chats use the main session (or per-sender sessions if `session.dmScope` is configured).
- Heartbeats run in the configured heartbeat session (default: the agent main session); group sessions do not run their own heartbeats.

<a id="pattern-personal-dms-public-groups-single-agent"></a>

## Pattern: personal DMs + public groups (single agent)

Yes — this works well if your "personal" traffic is **DMs** and your "public" traffic is **groups**.

Why: in single-agent mode, DMs typically land in the **main** session key (`agent:main:main`), while groups always use **non-main** session keys (`agent:main:<channel>:group:<id>`). If you enable sandboxing with `mode: "non-main"`, those group sessions run in the configured sandbox backend while your main DM session stays on-host. Docker is the default backend if you do not choose one.

This gives you one agent "brain" (shared workspace + memory), but two execution postures:

- **DMs**: full tools (host)
- **Groups**: sandbox + restricted tools

<Note>
If you need truly separate workspaces/personas ("personal" and "public" must never mix), use a second agent + bindings. See [Multi-Agent Routing](/concepts/multi-agent).
</Note>

<Tabs>
  <Tab title="DMs on host, groups sandboxed">
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
  </Tab>
  <Tab title="Groups see only an allowlisted folder">
    Want "groups can only see folder X" instead of "no host access"? Keep `workspaceAccess: "none"` and mount only allowlisted paths into the sandbox:

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

  </Tab>
</Tabs>

Related:

- Configuration keys and defaults: [Gateway configuration](/gateway/config-agents#agentsdefaultssandbox)
- Debugging why a tool is blocked: [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- Bind mounts details: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## Display labels

- UI labels use `displayName` when available, formatted as `<channel>:<token>`.
- `#room` is reserved for rooms/channels; group chats use `g-<slug>` (lowercase, spaces -> `-`, keep `#@+._-`). Very long opaque ids are shortened into a stable token instead of leaking full route ids into the UI.

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
      groupAllowFrom: ["123456789"], // numeric Telegram user id (setup resolves @username)
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
        GUILD_ID: { channels: { help: { enabled: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { enabled: true } },
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

<AccordionGroup>
  <Accordion title="Per-channel notes">
    - `groupPolicy` is separate from mention-gating (which requires @mentions).
    - WhatsApp/Telegram/Signal/iMessage/Microsoft Teams/Zalo: use `groupAllowFrom` (fallback: explicit `allowFrom`).
    - Signal: `groupAllowFrom` can match either the inbound Signal group id or the sender phone/UUID.
    - DM pairing approvals (`*-allowFrom` store entries) apply to DM access only; group sender authorization stays explicit to group allowlists.
    - Discord: allowlist uses `channels.discord.guilds.<id>.channels`.
    - Slack: allowlist uses `channels.slack.channels`.
    - Matrix: allowlist uses `channels.matrix.groups`. Use room IDs (`!room:server`) or aliases (`#alias:server`); room-name keys match only with `channels.matrix.dangerouslyAllowNameMatching: true`, and unresolved entries are ignored at runtime. Use `channels.matrix.groupAllowFrom` to restrict senders; per-room `users` allowlists are also supported.
    - Group DMs are controlled separately (`channels.discord.dm.*`, `channels.slack.dm.*`: `groupEnabled`, `groupChannels`).
    - Telegram: sender allowlists accept numeric user IDs only (`"123456789"`; `telegram:`/`tg:` prefixes are stripped case-insensitively). `@username` entries do not match at runtime and log a warning; setup resolves `@username` to IDs. Negative chat IDs belong under `channels.telegram.groups`, not sender allowlists.
    - Default is `groupPolicy: "allowlist"`; if your group allowlist is empty, group messages are blocked.
    - Runtime safety: when a provider block is completely missing (`channels.<provider>` absent), group policy fails closed to `allowlist` instead of inheriting `channels.defaults.groupPolicy`, and the gateway logs the fallback once per account.

  </Accordion>
</AccordionGroup>

Quick mental model (evaluation order for group messages):

<Steps>
  <Step title="groupPolicy">
    `groupPolicy` (open/disabled/allowlist).
  </Step>
  <Step title="Group allowlists">
    Group allowlists (`*.groups`, `*.groupAllowFrom`, channel-specific allowlist).
  </Step>
  <Step title="Mention gating">
    Mention gating (`requireMention`, `/activation`).
  </Step>
</Steps>

## Mention gating (default)

Group messages require a mention unless overridden per group. Defaults live per subsystem under `*.groups."*"`.

Supported implicit mention facts are channel-specific:

| Fact                  | Current built-in producers                       |
| --------------------- | ------------------------------------------------ |
| Reply to the bot      | Discord, Microsoft Teams, QQBot, Slack, Telegram |
| Quote of the bot      | WhatsApp, Zalo personal                          |
| Bot joined the thread | Mattermost, Slack, Tlon                          |

Each fact defaults to enabled when the channel produces it. Set the corresponding `implicitMentions` flag to `false` to stop that fact from bypassing mention gating; native explicit mentions remain unaffected. A flag has no effect on channels that do not produce that fact.

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
    entries: {
      main: {
        groupChat: {
          mentionPatterns: ["@openclaw", "openclaw", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    },
  },
}
```

## Scope configured mention patterns

Configured `mentionPatterns` are regex fallback triggers. Use them when the
platform does not expose a native bot mention, or when you want plain text such
as `openclaw:` to count as a mention. Native platform mentions are separate:
when Discord, Slack, Telegram, Matrix, Signal, or another channel can prove the message
explicitly mentioned the bot, that native mention still triggers even if
configured regex patterns are denied.

By default, configured mention patterns apply everywhere the channel passes provider and conversation facts into mention detection. To keep broad patterns from waking the agent in every group, scope them per channel with `channels.<channel>.mentionPatterns`.

Use `mode: "deny"` when regex mention patterns should be off by default for a channel, then opt in specific rooms with `allowIn`:

```json5
{
  messages: {
    groupChat: {
      mentionPatterns: ["\\bopenclaw\\b", "\\bops bot\\b"],
    },
  },
  channels: {
    slack: {
      mentionPatterns: {
        mode: "deny",
        allowIn: ["C0123OPS"],
      },
    },
  },
}
```

Use the default `mode: "allow"` (or omit `mode`) when regex mention patterns should apply broadly, then turn them off in noisy rooms with `denyIn`:

```json5
{
  messages: {
    groupChat: {
      mentionPatterns: ["\\bopenclaw\\b"],
    },
  },
  channels: {
    telegram: {
      mentionPatterns: {
        denyIn: ["-1001234567890", "-1001234567890:topic:42"],
      },
    },
  },
}
```

Policy resolution:

| Field           | Effect                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `mode: "allow"` | Regex mention patterns are enabled unless the conversation ID is in `denyIn`. This is the default.                    |
| `mode: "deny"`  | Regex mention patterns are disabled unless the conversation ID is in `allowIn`.                                       |
| `allowIn`       | Conversation IDs where regex mention patterns are enabled in deny mode.                                               |
| `denyIn`        | Conversation IDs where regex mention patterns are disabled. `denyIn` wins over `allowIn` if both include the same ID. |

Supported scoped regex policy today:

| Channel  | IDs used in `allowIn` / `denyIn`                             |
| -------- | ------------------------------------------------------------ |
| Discord  | Discord channel IDs.                                         |
| Matrix   | Matrix room IDs.                                             |
| Slack    | Slack channel IDs.                                           |
| Telegram | Group chat IDs, or `chatId:topic:threadId` for forum topics. |
| WhatsApp | WhatsApp conversation IDs such as `123@g.us`.                |

Account-level channel configs can set the same policy under `channels.<channel>.accounts.<accountId>.mentionPatterns` when that channel supports multiple accounts. Account policy takes precedence over the top-level channel policy for that account.

<AccordionGroup>
  <Accordion title="Mention gating notes">
    - `mentionPatterns` are case-insensitive safe regex patterns; invalid patterns and unsafe nested-repetition forms are ignored (with a warning).
    - Pattern precedence: `agents.entries.*.groupChat.mentionPatterns` (useful when multiple agents share a group) overrides `messages.groupChat.mentionPatterns`; when neither is set, patterns are derived from the agent identity name/emoji.
    - Mention gating is only enforced when mention detection is possible (native mentions or `mentionPatterns` are configured).
    - Allowlisting a group or sender does not disable mention gating; set that group's `requireMention` to `false` when all messages should trigger.
    - Automatic group chat prompt context carries the resolved silent-reply instruction every turn; workspace files should not duplicate `NO_REPLY` mechanics.
    - Groups where automatic silent replies are allowed treat clean empty or reasoning-only model turns as silent, equivalent to `NO_REPLY`. Direct chats never receive `NO_REPLY` guidance, and message-tool-only group replies stay quiet by not calling `message(action=send)`.
    - Ambient always-on group chatter uses user-request semantics by default. Set `messages.groupChat.unmentionedInbound: "room_event"` to submit it as quiet context instead. See [Ambient room events](/channels/ambient-room-events) for setup examples.
    - Room events are not stored as fake user requests, and private assistant text from no-message-tool room events is not replayed as chat history.
    - Discord defaults live in `channels.discord.guilds."*"` (overridable per guild/channel).
    - Group history context is wrapped uniformly across channels. Mention-gated groups keep pending skipped messages; always-on groups may also retain recent processed room messages when the channel supports it. Use `messages.groupChat.historyLimit` for the global default and `channels.<channel>.historyLimit` (or `channels.<channel>.accounts.*.historyLimit`) for overrides. Set `0` to disable.

  </Accordion>
</AccordionGroup>

## Group/channel tool restrictions (optional)

Some channel configs support restricting which tools are available **inside a specific group/room/channel**.

- `tools`: allow/deny tools for the whole group (`allow`, `alsoAllow`, `deny`; deny wins).
- `toolsBySender`: per-sender overrides within the group. Use explicit key prefixes: `channel:<channelId>:<senderId>`, `id:<senderId>`, `e164:<phone>`, `username:<handle>`, `name:<displayName>`, and `"*"` wildcard. Channel ids use canonical OpenClaw channel ids; aliases such as `teams` normalize to `msteams`. Legacy unprefixed keys are still accepted, matched as `id:` only, and log a deprecation warning.

Resolution order (most specific wins):

<Steps>
  <Step title="Group toolsBySender">
    Group/channel `toolsBySender` match.
  </Step>
  <Step title="Group tools">
    Group/channel `tools`.
  </Step>
  <Step title="Default toolsBySender">
    Default (`"*"`) `toolsBySender` match.
  </Step>
  <Step title="Default tools">
    Default (`"*"`) `tools`.
  </Step>
</Steps>

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

<Note>
Group/channel tool restrictions are applied in addition to global/agent tool policy (deny still wins). Some channels use different nesting for rooms/channels (e.g., Discord `guilds.*.channels.*`, Slack `channels.*`, Microsoft Teams `teams.*.channels.*`).
</Note>

## Group allowlists

When `channels.whatsapp.groups`, `channels.telegram.groups`, or `channels.imessage.groups` is configured, the keys act as a group allowlist. Use `"*"` to allow all groups while still setting default mention behavior.

<Warning>
Common confusion: DM pairing approval is not the same as group authorization. For channels that support DM pairing, the pairing store unlocks DMs only. Group commands still require explicit group sender authorization from config allowlists such as `groupAllowFrom` or the documented config fallback for that channel.
</Warning>

Common intents (copy/paste):

<Tabs>
  <Tab title="Disable all group replies">
    ```json5
    {
      channels: { whatsapp: { groupPolicy: "disabled" } },
    }
    ```
  </Tab>
  <Tab title="Allow only specific groups (WhatsApp)">
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
  </Tab>
  <Tab title="Allow all groups but require mention">
    ```json5
    {
      channels: {
        whatsapp: {
          groups: { "*": { requireMention: true } },
        },
      },
    }
    ```
  </Tab>
  <Tab title="Owner-only triggers (WhatsApp)">
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
  </Tab>
</Tabs>

## Activation (owner-only)

Group owners can toggle per-group activation with a standalone message:

- `/activation mention`
- `/activation always`

`/activation` is a core owner-gated command and only applies in group chats. Owner means the sender matches `commands.ownerAllowFrom`; channel `allowFrom` lists only control ordinary channel and command access. The stored mode overrides that group's `requireMention` on channels that consult it (Google Chat, QQBot, Telegram, WhatsApp), and the group system-prompt intro reflects the active mode everywhere.

## Context fields

Group inbound payloads set:

- `ChatType=group`
- `GroupSubject` (if known)
- `GroupMembers` (if known)
- `WasMentioned` (mention gating result)
- Telegram forum topics also include `MessageThreadId` and `IsForum`.

The agent system prompt includes a group intro on the first turn of a new group session (and after `/activation` changes). It reminds the model to respond like a human, minimize empty lines and follow normal chat spacing, and avoid typing literal `\n` sequences. Channels whose declared table mode does not preserve native or raw tables also discourage Markdown tables. Channel-sourced group names and participant labels are rendered as fenced untrusted metadata, not inline system instructions.

## iMessage specifics

- Prefer `chat_id:<id>` when routing or allowlisting.
- List chats: `imsg chats --limit 20`.
- Group replies always go back to the same `chat_id`.

## WhatsApp system prompts

See [WhatsApp](/channels/whatsapp#system-prompts) for the canonical WhatsApp system prompt rules, including group and direct prompt resolution, wildcard behavior, and account override semantics.

## WhatsApp specifics

See [Group messages](/channels/group-messages) for WhatsApp-only behavior (history injection, mention handling details).

## Related

- [Broadcast groups](/channels/broadcast-groups)
- [Channel routing](/channels/channel-routing)
- [Group messages](/channels/group-messages)
- [Pairing](/channels/pairing)
