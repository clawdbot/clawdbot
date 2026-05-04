---
summary: "Slack setup and runtime behavior (Socket Mode + HTTP Request URLs)"
read_when:
  - Setting up Slack or debugging Slack socket/HTTP mode
title: "Slack"
---

Production-ready for DMs and channels via Slack app integrations. Default mode is Socket Mode; HTTP Request URLs are also supported.

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

        Recommended SecretRef setup:

```bash
export SLACK_APP_TOKEN=xapp-...
export SLACK_BOT_TOKEN=xoxb-...
cat > slack.socket.patch.json5 <<'JSON5'
{
  channels: {
    slack: {
      enabled: true,
      mode: "socket",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    },
  },
}
JSON5
openclaw config patch --file ./slack.socket.patch.json5 --dry-run
openclaw config patch --file ./slack.socket.patch.json5
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

        Recommended SecretRef setup:

```bash
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_SIGNING_SECRET=...
cat > slack.http.patch.json5 <<'JSON5'
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      signingSecret: { source: "env", provider: "default", id: "SLACK_SIGNING_SECRET" },
      webhookPath: "/slack/events",
    },
  },
}
JSON5
openclaw config patch --file ./slack.http.patch.json5 --dry-run
openclaw config patch --file ./slack.http.patch.json5
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

## Socket Mode transport tuning

OpenClaw sets the Slack SDK client pong timeout to 15 seconds by default for Socket Mode. Override the transport settings only when you need workspace- or host-specific tuning:

```json5
{
  channels: {
    slack: {
      mode: "socket",
      socketMode: {
        clientPingTimeout: 20000,
        serverPingTimeout: 30000,
        pingPongLoggingEnabled: false,
      },
    },
  },
}
```

Use this only for Socket Mode workspaces that log Slack websocket pong/server-ping timeouts or run on hosts with known event-loop starvation. `clientPingTimeout` is the pong wait after the SDK sends a client ping; `serverPingTimeout` is the wait for Slack server pings. App messages and events remain application state, not transport liveness signals.

## Manifest and scope checklist

The base Slack app manifest is the same for Socket Mode and HTTP Request URLs. Only the `settings` block (and the slash command `url`) differs.

Base manifest (Socket Mode default):

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": { "display_name": "OpenClaw", "always_online": true },
    "app_home": {
      "home_tab_enabled": true,
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
        "usergroups:read",
        "users:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_home_opened",
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

For **HTTP Request URLs mode**, replace `settings` with the HTTP variant and add `url` to each slash command. Public URL required:

```json
{
  "features": {
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false,
        "url": "https://gateway-host.example.com/slack/events"
      }
    ]
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://gateway-host.example.com/slack/events",
      "bot_events": [
        "app_home_opened",
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

### Additional manifest settings

Surface different features that extend the above defaults.

The default manifest enables the Slack App Home **Home** tab and subscribes to `app_home_opened`. When a workspace member opens the Home tab, OpenClaw publishes a safe default Home view with `views.publish`; no conversation payload or private configuration is included. The **Messages** tab remains enabled for Slack DMs.

<AccordionGroup>
  <Accordion title="Optional native slash commands">

    Multiple [native slash commands](#commands-and-slash-behavior) can be used instead of a single configured command with nuance:

    - Use `/agentstatus` instead of `/status` because the `/status` command is reserved.
    - No more than 25 slash commands can be made available at once.

    Replace your existing `features.slash_commands` section with a subset of [available commands](/tools/slash-commands#command-list):

    <Tabs>
      <Tab title="Socket Mode (default)">

```json
{
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
      "description": "List providers/models",
      "usage_hint": "[provider] [page] [limit=<n>|size=<n>|all]"
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
      "command": "/side",
      "description": "Ask a side question without changing session context",
      "usage_hint": "<question>"
    },
    {
      "command": "/usage",
      "description": "Control the usage footer or show cost summary",
      "usage_hint": "off|tokens|full|cost"
    }
  ]
}
```

      </Tab>
      <Tab title="HTTP Request URLs">
        Use the same `slash_commands` list as Socket Mode above, and add `"url": "https://gateway-host.example.com/slack/events"` to every entry. Example:

```json
{
  "slash_commands": [
    {
      "command": "/new",
      "description": "Start a new session",
      "usage_hint": "[model]",
      "url": "https://gateway-host.example.com/slack/events"
    },
    {
      "command": "/help",
      "description": "Show the short help summary",
      "url": "https://gateway-host.example.com/slack/events"
    }
  ]
}
```

        Repeat that `url` value on every command in the list.

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

Current Slack message actions include `send`, `upload-file`, `download-file`, `read`, `edit`, `delete`, `pin`, `unpin`, `list-pins`, `member-info`, and `emoji-list`. `download-file` accepts Slack file IDs shown in inbound file placeholders and returns image previews for images or local file metadata for other file types.

## Access control and routing

<Tabs>
  <Tab title="DM policy">
    `channels.slack.dmPolicy` controls DM access. `channels.slack.allowFrom` is the canonical DM allowlist.

    - `pairing` (default)
    - `allowlist`
    - `open` (requires `channels.slack.allowFrom` to include `"*"`)
    - `disabled`

    DM flags:

    - `dm.enabled` (default true)
    - `channels.slack.allowFrom`
    - `dm.allowFrom` (legacy)
    - `dm.groupEnabled` (group DMs default false)
    - `dm.groupChannels` (optional MPIM allowlist)

    Multi-account precedence:

    - `channels.slack.accounts.default.allowFrom` applies only to the `default` account.
    - Named accounts inherit `channels.slack.allowFrom` when their own `allowFrom` is unset.
    - Named accounts do not inherit `channels.slack.accounts.default.allowFrom`.

    Legacy `channels.slack.dm.policy` and `channels.slack.dm.allowFrom` still read for compatibility. `openclaw doctor --fix` migrates them to `dmPolicy` and `allowFrom` when it can do so without changing access.

    Pairing in DMs uses `openclaw pairing approve slack <code>`.

  </Tab>

  <Tab title="Channel policy">
    `channels.slack.groupPolicy` controls channel handling:

    - `open`
    - `allowlist`
    - `disabled`

    Channel allowlist lives under `channels.slack.channels` and **must use stable Slack channel IDs** (for example `C12345678`) as config keys.

    Runtime note: if `channels.slack` is completely missing (env-only setup), runtime falls back to `groupPolicy="allowlist"` and logs a warning (even if `channels.defaults.groupPolicy` is set).

    Name/ID resolution:

    - channel allowlist entries and DM allowlist entries are resolved at startup when token access allows
    - unresolved channel-name entries are kept as configured but ignored for routing by default
    - inbound authorization and channel routing are ID-first by default; direct username/slug matching requires `channels.slack.dangerouslyAllowNameMatching: true`

    <Warning>
    Name-based keys (`#channel-name` or `channel-name`) do **not** match under `groupPolicy: "allowlist"`. The channel lookup is ID-first by default, so a name-based key will never route successfully and all messages in that channel will be silently blocked. This differs from `groupPolicy: "open"`, where the channel key is not required for routing and a name-based key appears to work.

    Always use the Slack channel ID as the key. To find it: right-click the channel in Slack → **Copy link** — the ID (`C...`) appears at the end of the URL.

    Correct:

    ```json5
    {
      channels: {
        slack: {
          groupPolicy: "allowlist",
          channels: {
            C12345678: { allow: true, requireMention: true },
          },
        },
      },
    }
    ```

    Incorrect (silently blocked under `groupPolicy: "allowlist"`):

    ```json5
    {
      channels: {
        slack: {
          groupPolicy: "allowlist",
          channels: {
            "#eng-my-channel": { allow: true, requireMention: true },
          },
        },
      },
    }
    ```
    </Warning>

  </Tab>

  <Tab title="Mentions and channel users">
    Channel messages are mention-gated by default.

    Mention sources:

    - explicit app mention (`<@botId>`)
    - Slack user-group mention (`<!subteam^S...>`) when the bot user is a member of that user group; requires `usergroups:read`
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

    `allowBots` is conservative for channels and private channels: bot-authored room messages are accepted only when the sending bot is explicitly listed in that room's `users` allowlist, or when at least one explicit Slack owner ID from `channels.slack.allowFrom` is currently a room member. Wildcards and display-name owner entries do not satisfy owner presence. Owner presence uses Slack `conversations.members`; make sure the app has the matching read scope for the room type (`channels:read` for public channels, `groups:read` for private channels). If the member lookup fails, OpenClaw drops the bot-authored room message.

  </Tab>
</Tabs>

## Threading, sessions, and reply tags

- DMs route as `direct`; channels as `channel`; MPIMs as `group`.
- Slack route bindings accept raw peer IDs plus Slack target forms such as `channel:C12345678`, `user:U12345678`, and `<@U12345678>`.
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

<Note>
`replyToMode="off"` disables **all** reply threading in Slack, including explicit `[[reply_to_*]]` tags. This differs from Telegram, where explicit tags are still honored in `"off"` mode. Slack threads hide messages from the channel while Telegram replies stay visible inline.
</Note>

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
- `streaming.preview.commandText` / `streaming.progress.commandText`: set to `status` to keep compact tool-progress lines while hiding raw command/exec text (default: `raw`).

Hide raw command/exec text while keeping compact progress lines:

```json
{
  "channels": {
    "slack": {
      "streaming": {
        "mode": "progress",
        "progress": {
          "toolProgress": true,
          "commandText": "status"
        }
      }
    }
  }
}
```

`channels.slack.streaming.nativeTransport` controls Slack native text streaming when `channels.slack.streaming.mode` is `partial` (default: `true`).

- A reply thread must be available for native text streaming and Slack assistant thread status to appear. Thread selection still follows `replyToMode`.
- Channel, group-chat, and top-level DM roots can still use the normal draft preview when native streaming is unavailable or no reply thread exists.
- Top-level Slack DMs stay off-thread by default, so they do not show Slack's thread-style native stream/status preview; OpenClaw posts and edits a draft preview in the DM instead.
- Media and non-text payloads fall back to normal delivery.
- Media/error finals cancel pending preview edits; eligible text/block finals flush only when they can edit the preview in place.
- If streaming fails mid-reply, OpenClaw falls back to normal delivery for remaining payloads.

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
    Slack file attachments are downloaded from Slack-hosted private URLs (token-authenticated request flow) and written to the media store when fetch succeeds and size limits permit. File placeholders include the Slack `fileId` so agents can fetch the original file with `download-file`.

    Downloads use bounded idle and total timeouts. If Slack file retrieval stalls or fails, OpenClaw keeps processing the message and falls back to the file placeholder.

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

    Text/block-only Slack DMs can post directly to user IDs; file uploads and threaded sends open the DM via Slack conversation APIs first because those paths require a concrete conversation ID.

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

- Message edits/deletes are mapped into system events.
- Thread broadcasts ("Also send to channel" thread replies) are processed as normal user messages.
- Reaction add/remove events are mapped into system events.
- Member join/leave, channel created/renamed, and pin add/remove events are mapped into system events.
- `channel_id_changed` can migrate channel config keys when `configWrites` is enabled.
- Channel topic/purpose metadata is treated as untrusted context and can be injected into routing context.
- Thread starter and initial thread-history context seeding are filtered by configured sender allowlists when applicable.
- Block actions and modal interactions emit structured `Slack interaction: ...` system events with rich payload fields:
  - block actions: selected values, labels, picker values, and `workflow_*` metadata
  - modal `view_submission` and `view_closed` events with routed channel metadata and form inputs

## Configuration reference

Primary reference: [Configuration reference - Slack](/gateway/config-channels#slack).

<Accordion title="High-signal Slack fields">

- mode/auth: `mode`, `botToken`, `appToken`, `signingSecret`, `webhookPath`, `accounts.*`
- DM access: `dm.enabled`, `dmPolicy`, `allowFrom` (legacy: `dm.policy`, `dm.allowFrom`), `dm.groupEnabled`, `dm.groupChannels`
- compatibility toggle: `dangerouslyAllowNameMatching` (break-glass; keep off unless needed)
- channel access: `groupPolicy`, `channels.*`, `channels.*.users`, `channels.*.requireMention`
- threading/history: `replyToMode`, `replyToModeByChatType`, `thread.*`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
- delivery: `textChunkLimit`, `chunkMode`, `mediaMaxMb`, `streaming`, `streaming.nativeTransport`, `streaming.preview.toolProgress`
- ops/features: `configWrites`, `commands.native`, `slashCommand.*`, `actions.*`, `userToken`, `userTokenReadOnly`

</Accordion>

## Troubleshooting

<AccordionGroup>
  <Accordion title="No replies in channels">
    Check, in order:

    - `groupPolicy`
    - channel allowlist (`channels.slack.channels`) — **keys must be channel IDs** (`C12345678`), not names (`#channel-name`). Name-based keys silently fail under `groupPolicy: "allowlist"` because channel routing is ID-first by default. To find an ID: right-click the channel in Slack → **Copy link** — the `C...` value at the end of the URL is the channel ID.
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
    - Slack Assistant DM events: verbose logs mentioning `drop message_changed`
      usually mean Slack sent an edited Assistant-thread event without a
      recoverable human sender in message metadata

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

  </Accordion>

  <Accordion title="Native/slash commands not firing">
    Verify whether you intended:

    - native command mode (`channels.slack.commands.native: true`) with matching slash commands registered in Slack
    - or single slash command mode (`channels.slack.slashCommand.enabled: true`)

    Also check `commands.useAccessGroups` and channel/user allowlists.

  </Accordion>
</AccordionGroup>

## Attachment vision reference

Slack can attach downloaded media to the agent turn when Slack file downloads succeed and size limits permit. Image files can be passed through the media understanding path or directly to a vision-capable reply model; other files are retained as downloadable file context rather than treated as image input.

### Supported media types

| Media type                     | Source               | Current behavior                                                                  | Notes                                                                     |
| ------------------------------ | -------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| JPEG / PNG / GIF / WebP images | Slack file URL       | Downloaded and attached to the turn for vision-capable handling                   | Per-file cap: `channels.slack.mediaMaxMb` (default 20 MB)                 |
| PDF files                      | Slack file URL       | Downloaded and exposed as file context for tools such as `download-file` or `pdf` | Slack inbound does not convert PDFs into image-vision input automatically |
| Other files                    | Slack file URL       | Downloaded when possible and exposed as file context                              | Binary files are not treated as image input                               |
| Thread replies                 | Thread starter files | Root-message files can be hydrated as context when the reply has no direct media  | File-only starters use an attachment placeholder                          |
| Multi-image messages           | Multiple Slack files | Each file is evaluated independently                                              | Slack processing is capped at eight files per message                     |

### Inbound pipeline

When a Slack message with file attachments arrives:

1. OpenClaw downloads the file from Slack's private URL using the bot token (`xoxb-...`).
2. The file is written to the media store on success.
3. Downloaded media paths and content types are added to the inbound context.
4. Image-capable model/tool paths can use image attachments from that context.
5. Non-image files remain available as file metadata or media references for tools that can handle them.

### Thread-root attachment inheritance

When a message arrives in a thread (has a `thread_ts` parent):

- If the reply itself has no direct media and the included root message has files, Slack can hydrate the root files as thread-starter context.
- Direct reply attachments take precedence over root-message attachments.
- A root message that has only files and no text is represented with an attachment placeholder so the fallback can still include its files.

### Multi-attachment handling

When a single Slack message contains multiple file attachments:

- Each attachment is processed independently through the media pipeline.
- Downloaded media references are aggregated into the message context.
- Processing order follows Slack's file order in the event payload.
- A failure in one attachment's download does not block others.

### Size, download, and model limits

- **Size cap**: Default 20 MB per file. Configurable via `channels.slack.mediaMaxMb`.
- **Download failures**: Files that Slack cannot serve, expired URLs, inaccessible files, oversize files, and Slack auth/login HTML responses are skipped instead of being reported as unsupported formats.
- **Vision model**: Image analysis uses the active reply model when it supports vision, or the image model configured at `agents.defaults.imageModel`.

### Known limits

| Scenario                               | Current behavior                                                             | Workaround                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Expired Slack file URL                 | File skipped; no error shown                                                 | Re-upload the file in Slack                                                |
| Vision model not configured            | Image attachments are stored as media references, but not analyzed as images | Configure `agents.defaults.imageModel` or use a vision-capable reply model |
| Very large images (> 20 MB by default) | Skipped per size cap                                                         | Increase `channels.slack.mediaMaxMb` if Slack allows                       |
| Forwarded/shared attachments           | Text and Slack-hosted image/file media are best-effort                       | Re-share directly in the OpenClaw thread                                   |
| PDF attachments                        | Stored as file/media context, not automatically routed through image vision  | Use `download-file` for file metadata or the `pdf` tool for PDF analysis   |

### Related documentation

- [Media understanding pipeline](/nodes/media-understanding)
- [PDF tool](/tools/pdf)
- Epic: [#51349](https://github.com/openclaw/openclaw/issues/51349) — Slack attachment vision enablement
- Regression tests: [#51353](https://github.com/openclaw/openclaw/issues/51353)
- Live verification: [#51354](https://github.com/openclaw/openclaw/issues/51354)

## Related

<CardGroup cols={2}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Pair a Slack user to the gateway.
  </Card>
  <Card title="Groups" icon="users" href="/channels/groups">
    Channel and group DM behavior.
  </Card>
  <Card title="Channel routing" icon="route" href="/channels/channel-routing">
    Route inbound messages to agents.
  </Card>
  <Card title="Security" icon="shield" href="/gateway/security">
    Threat model and hardening.
  </Card>
  <Card title="Configuration" icon="sliders" href="/gateway/configuration">
    Config layout and precedence.
  </Card>
  <Card title="Slash commands" icon="terminal" href="/tools/slash-commands">
    Command catalog and behavior.
  </Card>
</CardGroup>
