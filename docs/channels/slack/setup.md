---
summary: "Install the Slack plugin, create the app, and configure tokens"
read_when:
  - Installing the Slack plugin for the first time
  - Creating the Slack app and pasting a manifest
  - Choosing between bot identity and user identity
title: "Slack setup"
sidebarTitle: "Setup"
---

Install the plugin, create the Slack app, and give OpenClaw the tokens it needs.

## Install

```bash
openclaw plugins install @openclaw/slack
```

`plugins install` registers and enables the plugin. It does nothing until you configure the Slack app and channel settings below. See [Plugins](/tools/plugin) for general plugin install rules.

## Quick setup

The manifests in this section create a workspace-scoped installation. For an
Enterprise Grid organization installation, use the dedicated
[org-wide manifest and workflow](/channels/slack/enterprise-grid#enterprise-grid-org-wide-installs) instead.

<Tabs>
  <Tab title="Socket Mode (default)">
    <Steps>
      <Step title="Create a new Slack app">
        Open [api.slack.com/apps](https://api.slack.com/apps/new) → **Create New App** → **From a manifest** → select your workspace → paste one of the manifests below → **Next** → **Create**.

        <CodeGroup>

```json Recommended
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
    "agent_view": {
      "agent_description": "OpenClaw connects Slack Agent View conversations to OpenClaw agents.",
      "suggested_prompts": [
        { "title": "What can you do?", "message": "What can you help me with?" },
        {
          "title": "Summarize this channel",
          "message": "Summarize the recent activity in this channel."
        },
        { "title": "Draft a reply", "message": "Help me draft a reply." }
      ]
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
        "app_context_changed",
        "agent_session_stopped",
        "agent_session_title_changed",
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

```json Minimal
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
    "agent_view": {
      "agent_description": "OpenClaw connects Slack Agent View conversations to OpenClaw agents.",
      "suggested_prompts": [
        { "title": "What can you do?", "message": "What can you help me with?" },
        {
          "title": "Summarize this channel",
          "message": "Summarize the recent activity in this channel."
        },
        { "title": "Draft a reply", "message": "Help me draft a reply." }
      ]
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
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
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
        "app_context_changed",
        "agent_session_stopped",
        "agent_session_title_changed",
        "message.channels",
        "message.groups",
        "message.im"
      ]
    }
  }
}
```

        </CodeGroup>

        <Note>
          **Recommended** matches the Slack plugin's full feature set: App Home, slash commands, files, reactions, pins, group DMs, and emoji/usergroup reads. Pick **Minimal** when workspace policy restricts scopes — it covers DMs, channel/group history, mentions, and slash commands but drops files, reactions, pins, group-DM (`mpim:*`), `emoji:read`, and `usergroups:read`. See [Manifest and scope checklist](/channels/slack/manifest-and-scopes#manifest-and-scope-checklist) for per-scope rationale and additive options like extra slash commands.
        </Note>

        After Slack creates the app:

        - **Basic Information -> App-Level Tokens -> Generate Token and Scopes**: add `connections:write`, save, copy the App-Level Token.
        - **Install App -> Install to Workspace**: copy the Bot User OAuth Token.

      </Step>

      <Step title="Configure OpenClaw">

        Recommended SecretRef setup:

```bash
export SLACK_APP_TOKEN=slack-app-token-example
export SLACK_BOT_TOKEN=slack-bot-token-example
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

        Default-account credential fallback after `channels.slack` is configured:

```bash
SLACK_APP_TOKEN=slack-app-token-example
SLACK_BOT_TOKEN=slack-bot-token-example
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
        Open [api.slack.com/apps](https://api.slack.com/apps/new) → **Create New App** → **From a manifest** → select your workspace → paste one of the manifests below → replace `https://gateway-host.example.com/slack/events` with your public Gateway URL → **Next** → **Create**.

        <CodeGroup>

```json Recommended
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
    "agent_view": {
      "agent_description": "OpenClaw connects Slack Agent View conversations to OpenClaw agents.",
      "suggested_prompts": [
        { "title": "What can you do?", "message": "What can you help me with?" },
        {
          "title": "Summarize this channel",
          "message": "Summarize the recent activity in this channel."
        },
        { "title": "Draft a reply", "message": "Help me draft a reply." }
      ]
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
        "usergroups:read",
        "users:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://gateway-host.example.com/slack/events",
      "bot_events": [
        "app_home_opened",
        "app_mention",
        "app_context_changed",
        "agent_session_stopped",
        "agent_session_title_changed",
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

```json Minimal
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
    "agent_view": {
      "agent_description": "OpenClaw connects Slack Agent View conversations to OpenClaw agents.",
      "suggested_prompts": [
        { "title": "What can you do?", "message": "What can you help me with?" },
        {
          "title": "Summarize this channel",
          "message": "Summarize the recent activity in this channel."
        },
        { "title": "Draft a reply", "message": "Help me draft a reply." }
      ]
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
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "users:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://gateway-host.example.com/slack/events",
      "bot_events": [
        "app_home_opened",
        "app_mention",
        "app_context_changed",
        "agent_session_stopped",
        "agent_session_title_changed",
        "message.channels",
        "message.groups",
        "message.im"
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

        </CodeGroup>

        <Note>
          **Recommended** matches the Slack plugin's full feature set; **Minimal** drops files, reactions, pins, group-DM (`mpim:*`), `emoji:read`, and `usergroups:read` for restrictive workspaces. See [Manifest and scope checklist](/channels/slack/manifest-and-scopes#manifest-and-scope-checklist) for per-scope rationale.
        </Note>

        <Info>
          The three URL fields (`slash_commands[].url`, `event_subscriptions.request_url`, and `interactivity.request_url` / `message_menu_options_url`) all point at the same OpenClaw endpoint. Slack's manifest schema requires them named separately, but OpenClaw routes by payload type so a single `webhookPath` (default `/slack/events`) is enough. Slash commands without `slash_commands[].url` silently no-op in HTTP mode.
        </Info>

        After Slack creates the app:

        - **Basic Information → App Credentials**: copy the **Signing Secret** for request verification.
        - **Install App -> Install to Workspace**: copy the Bot User OAuth Token.

      </Step>

      <Step title="Configure OpenClaw">

        Recommended SecretRef setup:

```bash
export SLACK_BOT_TOKEN=slack-bot-token-example
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

## User identity (post as a real person)

User identity lets OpenClaw read and post as the human who authorizes the Slack app. The `userToken` is the acting identity; a companion Slack app carries Events API traffic over Socket Mode or an HTTP Request URL. The companion app does not need a bot user or bot token.

Set up the companion app as follows:

1. Under **OAuth & Permissions -> User Token Scopes**, add these user-scoped permissions:

   - history: `channels:history`, `groups:history`, `im:history`, `mpim:history`
   - conversation lookup: `channels:read`, `groups:read`, `im:read`, `mpim:read`
   - people: `users:read`
   - posting: `chat:write` (messages are posted as the authorizing user)
   - opening DMs: `im:write`, `mpim:write`

2. Under **Event Subscriptions -> Subscribe to events on behalf of users**, add these user events. Do not add them only to the bot-events list:

   - `message.channels`
   - `message.groups`
   - `message.im`
   - `message.mpim`

3. Choose one event transport:

   - **Socket Mode:** enable Socket Mode and create an app-level token with `connections:write`. Configure it as `appToken`.
   - **HTTP Request URL:** point Event Subscriptions at the public OpenClaw Slack endpoint and copy **Basic Information -> App Credentials -> Signing Secret**. Configure it as `signingSecret`.

4. Install or reinstall the app, authorize it as the intended human, and copy the resulting user OAuth token into `userToken`.

Socket Mode configuration:

```json5
{
  channels: {
    slack: {
      postAs: "user",
      userToken: "<xoxp>",
      appToken: "<xapp>",
    },
  },
}
```

HTTP Request URL configuration:

```json5
{
  channels: {
    slack: {
      postAs: "user",
      mode: "http",
      userToken: "<xoxp>",
      signingSecret: "<signing-secret>",
      webhookPath: "/slack/events",
    },
  },
}
```

<Warning>
  DMs and group DMs work only through the user-scope event subscription above. A bot cannot join a human 1:1 DM or be inserted into an existing group DM. The companion app is invisible plumbing: other Slack members see messages from the authorizing human, not from an OpenClaw bot.
</Warning>

OpenClaw automatically drops user-scope message events authored by the resolved human identity, so messages it sends do not trigger self-replies.

## Token model

- Bot identity (default) requires `botToken` + `appToken` for Socket Mode, or `botToken` + `signingSecret` for HTTP mode.
- User identity requires `userToken` + `appToken` for Socket Mode, or `userToken` + `signingSecret` for HTTP mode. It does not use a bot token.
- Relay mode requires `botToken` plus `relay.url`, `relay.authToken`, and `relay.gatewayId`; it does not use an app token or signing secret.
- `botToken`, `appToken`, `signingSecret`, `relay.authToken`, and `userToken` accept plaintext
  strings or SecretRef objects.
- Config tokens override env fallback.
- `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_USER_TOKEN` env fallback each apply only to the default account.
- `userToken` defaults to read-only behavior (`userTokenReadOnly: true`).

Status snapshot behavior:

- Slack account inspection tracks per-credential `*Source` and `*Status`
  fields (`botToken`, `appToken`, `signingSecret`, `userToken`).
- Status is `available`, `configured_unavailable`, or `missing`.
- `configured_unavailable` means the account is configured through SecretRef
  or another non-inline secret source, but the current command/runtime path
  could not resolve the actual value.
- In HTTP mode, `signingSecretStatus` is included. Socket Mode uses
  `botTokenStatus` + `appTokenStatus` for bot identity and
  `userTokenStatus` + `appTokenStatus` for user identity.

<Tip>
For bot identity, actions and directory reads can prefer an optional user token; writes continue to use the bot token unless `userTokenReadOnly: false` allows fallback. For `postAs: "user"`, reads and writes always use `userToken`.
</Tip>
