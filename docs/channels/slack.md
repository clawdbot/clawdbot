---
summary: "Slack setup and runtime behavior (Socket Mode + HTTP Request URLs)"
read_when:
  - Setting up Slack or debugging Slack socket/HTTP mode
title: "Slack"
---

# Slack

Status: production-ready for DMs + channels via Slack app integrations. Default mode is Socket Mode; HTTP Request URLs are also supported.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Slack DMs default to pairing mode.
  </Card>
  <Card title="Slash commands" icon="terminal" href="/tools/slash-commands">
    Native command behavior and command catalog.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Cross-channel diagnostics and repair playbooks.
  </Card>
</CardGroup>

## Quick setup

<Tabs>
  <Tab title="Socket Mode (default)">
    <Steps>
      <Step title="Create a new Slack app">
        In Slack app settings press the **[Create New App](https://api.slack.com/apps/new)** button:

        - choose **from a manifest** and select a workspace for your app
        - paste the [example manifest](#manifest-and-scope-checklist) from below and continue to create
        - generate an **App-Level Token** (`xapp-...`) with `connections:write`
        - install app and copy the **Bot Token** (`xoxb-...`) shown
      </Step>

      <Step title="Configure OpenClaw">

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "socket",
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

        Env fallback (default account only):

```bash
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
```

      </Step>

      <Step title="Start gateway">

```bash
openclaw gateway
```

      </Step>
    </Steps>

  </Tab>

  <Tab title="HTTP Request URLs">
    <Steps>
      <Step title="Create a new Slack app">
        In Slack app settings press the **[Create New App](https://api.slack.com/apps/new)** button:

        - choose **from a manifest** and select a workspace for your app
        - paste the [example manifest](#manifest-and-scope-checklist) and update the URLs before create
        - save the **Signing Secret** for request verification
        - install app and copy the **Bot Token** (`xoxb-...`) shown

      </Step>

      <Step title="Configure OpenClaw">

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

        <Note>
        Use unique webhook paths for multi-account HTTP

        Give each account a distinct `webhookPath` (default `/slack/events`) so registrations do not collide.
        </Note>

      </Step>

      <Step title="Start gateway">

```bash
openclaw gateway
```

      </Step>
    </Steps>

  </Tab>
</Tabs>

## Manifest and scope checklist

<Tabs>
  <Tab title="Socket Mode (default)">

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": true
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "assistant:write",
        "channels:history",
        "channels:read",
        "chat:write",
        "commands",
        "emoji:read",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "pins:read",
        "pins:write",
        "reactions:read",
        "reactions:write",
        "users:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "channel_rename",
        "member_joined_channel",
        "member_left_channel",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "pin_added",
        "pin_removed",
        "reaction_added",
        "reaction_removed"
      ]
    }
  }
}
```

  </Tab>

  <Tab title="HTTP Request URLs">

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": true
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false,
        "url": "https://gateway-host.example.com/slack/events"
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "assistant:write",
        "channels:history",
        "channels:read",
        "chat:write",
        "commands",
        "emoji:read",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "pins:read",
        "pins:write",
        "reactions:read",
        "reactions:write",
        "users:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://gateway-host.example.com/slack/events",
      "bot_events": [
        "app_mention",
        "channel_rename",
        "member_joined_channel",
        "member_left_channel",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "pin_added",
        "pin_removed",
        "reaction_added",
        "reaction_removed"
      ]
    },
    "interactivity": {
      "is_enabled": true,
      "request_url": "https://gateway-host.example.com/slack/events",
      "message_menu_options_url": "https://gateway-host.example.com/slack/events"
    }
  }
}
```

  </Tab>
</Tabs>

### Additional manifest settings

Surface different features that extend the above defaults.

<AccordionGroup>
  <Accordion title="Optional native slash commands">

    Multiple [native slash commands](#commands-and-slash-behavior) can be used instead of a single configured command with nuance:

    - Use `/agentstatus` instead of `/status` because the `/status` command is reserved.
    - No more than 25 slash commands can be made available at once.

    Replace your existing `features.slash_commands` section with a subset of [available commands](/tools/slash-commands#command-list):

    <Tabs>
      <Tab title="Socket Mode (default)">

```json
    "slash_commands": [
      {
        "command": "/new",
        "description": "Start a new session",
        "usage_hint": "[model]"
      },
      {
        "command": "/reset",
        "description": "Reset the current session"
      },
      {
        "command": "/compact",
        "description": "Compact the session context",
        "usage_hint": "[instructions]"
      },
      {
        "command": "/stop",
        "description": "Stop the current run"
      },
      {
        "command": "/session",
        "description": "Manage thread-binding expiry",
        "usage_hint": "idle <duration|off> or max-age <duration|off>"
      },
      {
        "command": "/think",
        "description": "Set the thinking level",
        "usage_hint": "<level>"
      },
      {
        "command": "/verbose",
        "description": "Toggle verbose output",
        "usage_hint": "on|off|full"
      },
      {
        "command": "/fast",
        "description": "Show or set fast mode",
        "usage_hint": "[status|on|off]"
      },
      {
        "command": "/reasoning",
        "description": "Toggle reasoning visibility",
        "usage_hint": "[on|off|stream]"
      },
      {
        "command": "/elevated",
        "description": "Toggle elevated mode",
        "usage_hint": "[on|off|ask|full]"
      },
      {
        "command": "/exec",
        "description": "Show or set exec defaults",
        "usage_hint": "host=<auto|sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>"
      },
      {
        "command": "/model",
        "description": "Show or set the model",
        "usage_hint": "[name|#|status]"
      },
      {
        "command": "/models",
        "description": "List providers/models or add a model",
        "usage_hint": "[provider] [page] [limit=<n>|size=<n>|all] | add <provider> <modelId>"
      },
      {
        "command": "/help",
        "description": "Show the short help summary"
      },
      {
        "command": "/commands",
        "description": "Show the generated command catalog"
      },
      {
        "command": "/tools",
        "description": "Show what the current agent can use right now",
        "usage_hint": "[compact|verbose]"
      },
      {
        "command": "/agentstatus",
        "description": "Show runtime status, including provider usage/quota when available"
      },
      {
        "command": "/tasks",
        "description": "List active/recent background tasks for the current session"
      },
      {
        "command": "/context",
        "description": "Explain how context is assembled",
        "usage_hint": "[list|detail|json]"
      },
      {
        "command": "/whoami",
        "description": "Show your sender identity"
      },
      {
        "command": "/skill",
        "description": "Run a skill by name",
        "usage_hint": "<name> [input]"
      },
      {
        "command": "/btw",
        "description": "Ask a side question without changing session context",
        "usage_hint": "<question>"
      },
      {
        "command": "/usage",
        "description": "Control the usage footer or show cost summary",
        "usage_hint": "off|tokens|full|cost"
      }
    ]
```

      </Tab>
      <Tab title="HTTP Request URLs">

```json
    "slash_commands": [
      {
        "command": "/new",
        "description": "Start a new session",
        "usage_hint": "[model]",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/reset",
        "description": "Reset the current session",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/compact",
        "description": "Compact the session context",
        "usage_hint": "[instructions]",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/stop",
        "description": "Stop the current run",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/session",
        "description": "Manage thread-binding expiry",
        "usage_hint": "idle <duration|off> or max-age <duration|off>",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/think",
        "description": "Set the thinking level",
        "usage_hint": "<level>",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/verbose",
        "description": "Toggle verbose output",
        "usage_hint": "on|off|full",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/fast",
        "description": "Show or set fast mode",
        "usage_hint": "[status|on|off]",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/reasoning",
        "description": "Toggle reasoning visibility",
        "usage_hint": "[on|off|stream]",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/elevated",
        "description": "Toggle elevated mode",
        "usage_hint": "[on|off|ask|full]",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/exec",
        "description": "Show or set exec defaults",
        "usage_hint": "host=<auto|sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/model",
        "description": "Show or set the model",
        "usage_hint": "[name|#|status]",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/models",
        "description": "List providers or models for a provider",
        "usage_hint": "[provider] [page] [limit=<n>|size=<n>|all]",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/help",
        "description": "Show the short help summary",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/commands",
        "description": "Show the generated command catalog",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/tools",
        "description": "Show what the current agent can use right now",
        "usage_hint": "[compact|verbose]",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/agentstatus",
        "description": "Show runtime status, including provider usage/quota when available",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/tasks",
        "description": "List active/recent background tasks for the current session",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/context",
        "description": "Explain how context is assembled",
        "usage_hint": "[list|detail|json]",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/whoami",
        "description": "Show your sender identity",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/skill",
        "description": "Run a skill by name",
        "usage_hint": "<name> [input]",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/btw",
        "description": "Ask a side question without changing session context",
        "usage_hint": "<question>",
        "url": "https://gateway-host.example.com/slack/events"
      },
      {
        "command": "/usage",
        "description": "Control the usage footer or show cost summary",
        "usage_hint": "off|tokens|full|cost",
        "url": "https://gateway-host.example.com/slack/events"
      }
    ]
```

      </Tab>
    </Tabs>

  </Accordion>
  <Accordion title="Optional authorship scopes (write operations)">
    Add the `chat:write.customize` bot scope if you want outgoing messages to use the active agent identity (custom username and icon) instead of the default Slack app identity.

    If you use an emoji icon, Slack expects `:emoji_name:` syntax.

  </Accordion>
  <Accordion title="Optional user-token scopes (read operations)">
    If you configure `channels.slack.userToken`, typical read scopes are:

    - `channels:history`, `groups:history`, `im:history`, `mpim:history`
    - `channels:read`, `groups:read`, `im:read`, `mpim:read`
    - `users:read`
    - `reactions:read`
    - `pins:read`
    - `emoji:read`
    - `search:read` (if you depend on Slack search reads)

  </Accordion>
</AccordionGroup>

## Token model

- `botToken` + `appToken` are required for Socket Mode.
- HTTP mode requires `botToken` + `signingSecret`.
- `botToken`, `appToken`, `signingSecret`, and `userToken` accept plaintext
  strings or SecretRef objects.
- Config tokens override env fallback.
- `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` env fallback applies only to the default account.
- `userToken` (`xoxp-...`) is config-only (no env fallback) and defaults to read-only behavior (`userTokenReadOnly: true`).

Status snapshot behavior:

- Slack account inspection tracks per-credential `*Source` and `*Status`
  fields (`botToken`, `appToken`, `signingSecret`, `userToken`).
- Status is `available`, `configured_unavailable`, or `missing`.
- `configured_unavailable` means the account is configured through SecretRef
  or another non-inline secret source, but the current command/runtime path
  could not resolve the actual value.
- In HTTP mode, `signingSecretStatus` is included; in Socket Mode, the
  required pair is `botTokenStatus` + `appTokenStatus`.

<Tip>
For actions/directory reads, user token can be preferred when configured. For writes, bot token remains preferred; user-token writes are only allowed when `userTokenReadOnly: false` and bot token is unavailable.
</Tip>

## Actions and gates

Slack actions are controlled by `channels.slack.actions.*`.

Available action groups in current Slack tooling:

| Group      | Default |
| ---------- | ------- |
| messages   | enabled |
| reactions  | enabled |
| pins       | enabled |
| memberInfo | enabled |
| emojiList  | enabled |

Current Slack message actions include `send`, `upload-file`, `download-file`, `read`, `edit`, `delete`, `pin`, `unpin`, `list-pins`, `member-info`, and `emoji-list`.

## Access control and routing

<Tabs>
  <Tab title="DM policy">
    `channels.slack.dmPolicy` controls DM access (legacy: `channels.slack.dm.policy`):

    - `pairing` (default)
    - `allowlist`
    - `open` (requires `channels.slack.allowFrom` to include `"*"`; legacy: `channels.slack.dm.allowFrom`)
    - `disabled`

    DM flags:

    - `dm.enabled` (default true)
    - `channels.slack.allowFrom` (preferred)
    - `dm.allowFrom` (legacy)
    - `dm.groupEnabled` (group DMs default false)
    - `dm.groupChannels` (optional MPIM allowlist)

    Multi-account precedence:

    - `channels.slack.accounts.default.allowFrom` applies only to the `default` account.
    - Named accounts inherit `channels.slack.allowFrom` when their own `allowFrom` is unset.
    - Named accounts do not inherit `channels.slack.accounts.default.allowFrom`.

    Pairing in DMs uses `openclaw pairing approve slack <code>`.

  </Tab>

  <Tab title="Channel policy">
    `channels.slack.groupPolicy` controls channel handling:

    - `open`
    - `allowlist`
    - `disabled`

    Channel allowlist lives under `channels.slack.channels` and should use stable channel IDs.

    Runtime note: if `channels.slack` is completely missing (env-only setup), runtime falls back to `groupPolicy="allowlist"` and logs a warning (even if `channels.defaults.groupPolicy` is set).

    Name/ID resolution:

    - channel allowlist entries and DM allowlist entries are resolved at startup when token access allows
    - unresolved channel-name entries are kept as configured but ignored for routing by default
    - inbound authorization and channel routing are ID-first by default; direct username/slug matching requires `channels.slack.dangerouslyAllowNameMatching: true`

  </Tab>

  <Tab title="Mentions and channel users">
    Channel messages are mention-gated by default.

    Mention sources:

    - explicit app mention (`<@botId>`)
    - mention regex patterns (`agents.list[].groupChat.mentionPatterns`, fallback `messages.groupChat.mentionPatterns`)
    - implicit reply-to-bot thread behavior (disabled when `thread.requireExplicitMention` is `true`)

    Per-channel controls (`channels.slack.channels.<id>`; names only via startup resolution or `dangerouslyAllowNameMatching`):

    - `requireMention`
    - `users` (allowlist)
    - `allowBots`
    - `skills`
    - `systemPrompt`
    - `tools`, `toolsBySender`
    - `toolsBySender` key format: `id:`, `e164:`, `username:`, `name:`, or `"*"` wildcard
      (legacy unprefixed keys still map to `id:` only)

  </Tab>
</Tabs>

## Threading, sessions, and reply tags

- DMs route as `direct`; channels as `channel`; MPIMs as `group`.
- With default `session.dmScope=main`, Slack DMs collapse to agent main session.
- Channel sessions: `agent:<agentId>:slack:channel:<channelId>`.
- Thread replies can create thread session suffixes (`:thread:<threadTs>`) when applicable.
- `channels.slack.thread.historyScope` default is `thread`; `thread.inheritParent` default is `false`.
- `channels.slack.thread.initialHistoryLimit` controls how many existing thread messages are fetched when a new thread session starts (default `20`; set `0` to disable).
- `channels.slack.thread.requireExplicitMention` (default `false`): when `true`, suppress implicit thread mentions so the bot only responds to explicit `@bot` mentions inside threads, even when the bot already participated in the thread. Without this, replies in a bot-participated thread bypass `requireMention` gating.

Reply threading controls:

- `channels.slack.replyToMode`: `off|first|all|batched` (default `off`)
- `channels.slack.replyToModeByChatType`: per `direct|group|channel`
- legacy fallback for direct chats: `channels.slack.dm.replyToMode`

Manual reply tags are supported:

- `[[reply_to_current]]`
- `[[reply_to:<id>]]`

Note: `replyToMode="off"` disables **all** reply threading in Slack, including explicit `[[reply_to_*]]` tags. This differs from Telegram, where explicit tags are still honored in `"off"` mode. The difference reflects the platform threading models: Slack threads hide messages from the channel, while Telegram replies remain visible in the main chat flow.

Focused Slack thread replies route through their bound ACP session when one exists, instead of preparing the reply against the default agent shell. That keeps `/focus` and `/acp spawn ... --bind here` bindings intact for follow-up messages in the thread.

## Ack reactions

`ackReaction` sends an acknowledgement emoji while OpenClaw is processing an inbound message.

Resolution order:

- `channels.slack.accounts.<accountId>.ackReaction`
- `channels.slack.ackReaction`
- `messages.ackReaction`
- agent identity emoji fallback (`agents.list[].identity.emoji`, else "👀")

Notes:

- Slack expects shortcodes (for example `"eyes"`).
- Use `""` to disable the reaction for the Slack account or globally.

## Text streaming

`channels.slack.streaming` controls live preview behavior:

- `off`: disable live preview streaming.
- `partial` (default): replace preview text with the latest partial output.
- `block`: append chunked preview updates.
- `progress`: show progress status text while generating, then send final text.
- `streaming.preview.toolProgress`: when draft preview is active, route tool/progress updates into the same edited preview message (default: `true`). Set `false` to keep separate tool/progress messages.

`channels.slack.streaming.nativeTransport` controls Slack native text streaming when `channels.slack.streaming.mode` is `partial` (default: `true`).

- A reply thread must be available for native text streaming and Slack assistant thread status to appear. Thread selection still follows `replyToMode`.
- Channel and group-chat roots can still use the normal draft preview when native streaming is unavailable.
- Top-level Slack DMs stay off-thread by default, so they do not show the thread-style preview; use thread replies or `typingReaction` if you want visible progress there.
- Media and non-text payloads fall back to normal delivery.
- Media/error finals cancel pending preview edits without flushing a temporary draft; eligible text/block finals flush only when they can edit the preview in place.
- If streaming fails mid-reply, OpenClaw falls back to normal delivery for remaining payloads.
- Slack Connect channels that reject a stream before the SDK flushes its local buffer fall back to normal Slack replies, so short replies are not silently dropped or reported as delivered before Slack acknowledges them.

Use draft preview instead of Slack native text streaming:

```json5
{
  channels: {
    slack: {
      streaming: {
        mode: "partial",
        nativeTransport: false,
      },
    },
  },
}
```

Legacy keys:

- `channels.slack.streamMode` (`replace | status_final | append`) is auto-migrated to `channels.slack.streaming.mode`.
- boolean `channels.slack.streaming` is auto-migrated to `channels.slack.streaming.mode` and `channels.slack.streaming.nativeTransport`.
- legacy `channels.slack.nativeStreaming` is auto-migrated to `channels.slack.streaming.nativeTransport`.

## Typing reaction fallback

`typingReaction` adds a temporary reaction to the inbound Slack message while OpenClaw is processing a reply, then removes it when the run finishes. This is most useful outside of thread replies, which use a default "is typing..." status indicator.

Resolution order:

- `channels.slack.accounts.<accountId>.typingReaction`
- `channels.slack.typingReaction`

Notes:

- Slack expects shortcodes (for example `"hourglass_flowing_sand"`).
- The reaction is best-effort and cleanup is attempted automatically after the reply or failure path completes.

## Media, chunking, and delivery

<AccordionGroup>
  <Accordion title="Inbound attachments">
    Slack file attachments are downloaded from Slack-hosted private URLs (token-authenticated request flow) and written to the media store when fetch succeeds and size limits permit.

    Runtime inbound size cap defaults to `20MB` unless overridden by `channels.slack.mediaMaxMb`.

  </Accordion>

  <Accordion title="Outbound text and files">
    - text chunks use `channels.slack.textChunkLimit` (default 4000)
    - `channels.slack.chunkMode="newline"` enables paragraph-first splitting
    - file sends use Slack upload APIs and can include thread replies (`thread_ts`)
    - outbound media cap follows `channels.slack.mediaMaxMb` when configured; otherwise channel sends use MIME-kind defaults from media pipeline
  </Accordion>

  <Accordion title="Delivery targets">
    Preferred explicit targets:

    - `user:<id>` for DMs
    - `channel:<id>` for channels

    Slack DMs are opened via Slack conversation APIs when sending to user targets.

  </Accordion>
</AccordionGroup>

## Commands and slash behavior

Slash commands appear in Slack as either a single configured command or multiple native commands. Configure `channels.slack.slashCommand` to change command defaults:

- `enabled: false`
- `name: "openclaw"`
- `sessionPrefix: "slack:slash"`
- `ephemeral: true`

```txt
/openclaw /help
```

Native commands require [additional manifest settings](#additional-manifest-settings) in your Slack app and are enabled with `channels.slack.commands.native: true` or `commands.native: true` in global configurations instead.

- Native command auto-mode is **off** for Slack so `commands.native: "auto"` does not enable Slack native commands.

```txt
/help
```

Native argument menus use an adaptive rendering strategy that shows a confirmation modal before dispatching a selected option value:

- up to 5 options: button blocks
- 6-100 options: static select menu
- more than 100 options: external select with async option filtering when interactivity options handlers are available
- exceeded Slack limits: encoded option values fall back to buttons

```txt
/think
```

Slash sessions use isolated keys like `agent:<agentId>:slack:slash:<userId>` and still route command executions to the target conversation session using `CommandTargetSessionKey`.

## Interactive replies

Slack can render agent-authored interactive reply controls, but this feature is disabled by default.

Enable it globally:

```json5
{
  channels: {
    slack: {
      capabilities: {
        interactiveReplies: true,
      },
    },
  },
}
```

Or enable it for one Slack account only:

```json5
{
  channels: {
    slack: {
      accounts: {
        ops: {
          capabilities: {
            interactiveReplies: true,
          },
        },
      },
    },
  },
}
```

When enabled, agents can emit Slack-only reply directives:

- `[[slack_buttons: Approve:approve, Reject:reject]]`
- `[[slack_select: Choose a target | Canary:canary, Production:production]]`

These directives compile into Slack Block Kit and route clicks or selections back through the existing Slack interaction event path.

Notes:

- This is Slack-specific UI. Other channels do not translate Slack Block Kit directives into their own button systems.
- The interactive callback values are OpenClaw-generated opaque tokens, not raw agent-authored values.
- If generated interactive blocks would exceed Slack Block Kit limits, OpenClaw falls back to the original text reply instead of sending an invalid blocks payload.

## Exec approvals in Slack

Slack can act as a native approval client with interactive buttons and interactions, instead of falling back to the Web UI or terminal.

- Exec approvals use `channels.slack.execApprovals.*` for native DM/channel routing.
- Plugin approvals can still resolve through the same Slack-native button surface when the request already lands in Slack and the approval id kind is `plugin:`.
- Approver authorization is still enforced: only users identified as approvers can approve or deny requests through Slack.

This uses the same shared approval button surface as other channels. When `interactivity` is enabled in your Slack app settings, approval prompts render as Block Kit buttons directly in the conversation.
When those buttons are present, they are the primary approval UX; OpenClaw
should only include a manual `/approve` command when the tool result says chat
approvals are unavailable or manual approval is the only path.

Config path:

- `channels.slack.execApprovals.enabled`
- `channels.slack.execApprovals.approvers` (optional; falls back to `commands.ownerAllowFrom` when possible)
- `channels.slack.execApprovals.target` (`dm` | `channel` | `both`, default: `dm`)
- `agentFilter`, `sessionFilter`

Slack auto-enables native exec approvals when `enabled` is unset or `"auto"` and at least one
approver resolves. Set `enabled: false` to disable Slack as a native approval client explicitly.
Set `enabled: true` to force native approvals on when approvers resolve.

Default behavior with no explicit Slack exec approval config:

```json5
{
  commands: {
    ownerAllowFrom: ["slack:U12345678"],
  },
}
```

Explicit Slack-native config is only needed when you want to override approvers, add filters, or
opt into origin-chat delivery:

```json5
{
  channels: {
    slack: {
      execApprovals: {
        enabled: true,
        approvers: ["U12345678"],
        target: "both",
      },
    },
  },
}
```

Shared `approvals.exec` forwarding is separate. Use it only when exec approval prompts must also
route to other chats or explicit out-of-band targets. Shared `approvals.plugin` forwarding is also
separate; Slack-native buttons can still resolve plugin approvals when those requests already land
in Slack.

Same-chat `/approve` also works in Slack channels and DMs that already support commands. See [Exec approvals](/tools/exec-approvals) for the full approval forwarding model.

## Events and operational behavior

- Message edits/deletes/thread broadcasts are mapped into system events.
- Reaction add/remove events are mapped into system events.
- Member join/leave, channel created/renamed, and pin add/remove events are mapped into system events.
- `channel_id_changed` can migrate channel config keys when `configWrites` is enabled.
- Channel topic/purpose metadata is treated as untrusted context and can be injected into routing context.
- Thread starter and initial thread-history context seeding are filtered by configured sender allowlists when applicable.
- Block actions and modal interactions emit structured `Slack interaction: ...` system events with rich payload fields:
  - block actions: selected values, labels, picker values, and `workflow_*` metadata
  - modal `view_submission` and `view_closed` events with routed channel metadata and form inputs

## Configuration reference pointers

Primary reference:

- [Configuration reference - Slack](/gateway/configuration-reference#slack)

  High-signal Slack fields:
  - mode/auth: `mode`, `botToken`, `appToken`, `signingSecret`, `webhookPath`, `accounts.*`
  - DM access: `dm.enabled`, `dmPolicy`, `allowFrom` (legacy: `dm.policy`, `dm.allowFrom`), `dm.groupEnabled`, `dm.groupChannels`
  - compatibility toggle: `dangerouslyAllowNameMatching` (break-glass; keep off unless needed)
  - channel access: `groupPolicy`, `channels.*`, `channels.*.users`, `channels.*.requireMention`
  - threading/history: `replyToMode`, `replyToModeByChatType`, `thread.*`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
  - delivery: `textChunkLimit`, `chunkMode`, `mediaMaxMb`, `streaming`, `streaming.nativeTransport`, `streaming.preview.toolProgress`
  - ops/features: `configWrites`, `commands.native`, `slashCommand.*`, `actions.*`, `userToken`, `userTokenReadOnly`

## Troubleshooting

<AccordionGroup>
  <Accordion title="No replies in channels">
    Check, in order:

    - `groupPolicy`
    - channel allowlist (`channels.slack.channels`)
    - `requireMention`
    - per-channel `users` allowlist

    Useful commands:

```bash
openclaw channels status --probe
openclaw logs --follow
openclaw doctor
```

  </Accordion>

  <Accordion title="DM messages ignored">
    Check:

    - `channels.slack.dm.enabled`
    - `channels.slack.dmPolicy` (or legacy `channels.slack.dm.policy`)
    - pairing approvals / allowlist entries

```bash
openclaw pairing list slack
```

  </Accordion>

  <Accordion title="Socket mode not connecting">
    Validate bot + app tokens and Socket Mode enablement in Slack app settings.

    If `openclaw channels status --probe --json` shows `botTokenStatus` or
    `appTokenStatus: "configured_unavailable"`, the Slack account is
    configured but the current runtime could not resolve the SecretRef-backed
    value.

  </Accordion>

  <Accordion title="HTTP mode not receiving events">
    Validate:

    - signing secret
    - webhook path
    - Slack Request URLs (Events + Interactivity + Slash Commands)
    - unique `webhookPath` per HTTP account

    If `signingSecretStatus: "configured_unavailable"` appears in account
    snapshots, the HTTP account is configured but the current runtime could not
    resolve the SecretRef-backed signing secret.

    Registered Request URL webhooks are dispatched through the same shared handler registry used by Slack monitor setup, so HTTP-mode Slack events keep routing through the registered path instead of 404ing after successful route registration.

  </Accordion>

  <Accordion title="File downloads with custom bot tokens">
    The `downloadFile` helper resolves its bot token from the runtime config when a caller passes `cfg` without an explicit `token` or prebuilt client, preserving cfg-only file downloads outside the action runtime path.
  </Accordion>

  <Accordion title="Native/slash commands not firing">
    Verify whether you intended:

    - native command mode (`channels.slack.commands.native: true`) with matching slash commands registered in Slack
    - or single slash command mode (`channels.slack.slashCommand.enabled: true`)

    Also check `commands.useAccessGroups` and channel/user allowlists.

  </Accordion>
</AccordionGroup>

## Related

- [Pairing](/channels/pairing)
- [Groups](/channels/groups)
- [Security](/gateway/security)
- [Channel routing](/channels/channel-routing)
- [Troubleshooting](/channels/troubleshooting)
- [Configuration](/gateway/configuration)
- [Slash commands](/tools/slash-commands)
