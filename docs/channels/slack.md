---
summary: "Slack setup and runtime behavior (Socket Mode, HTTP Request URLs, and relay mode)"
read_when:
  - Setting up Slack or debugging Slack socket, HTTP, or relay mode
title: "Slack"
---

Slack support covers DMs and channels via Slack app integrations. Default transport is Socket Mode; HTTP Request URLs are also supported. Relay mode is for managed deployments where a trusted router owns Slack ingress.

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

## Choosing a transport

Socket Mode and HTTP Request URLs reach feature parity for messaging, slash commands, App Home, and interactivity. Pick by deployment shape, not features.

| Concern                      | Socket Mode (default)                                                                                                                                | HTTP Request URLs                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Public Gateway URL           | Not required                                                                                                                                         | Required (DNS, TLS, reverse proxy or tunnel)                                                                   |
| Outbound network             | Outbound WSS to `wss-primary.slack.com` must be reachable                                                                                            | No outbound WS; inbound HTTPS only                                                                             |
| Tokens needed                | Bot identity: bot token + App-Level Token with `connections:write`; user identity: user token + App-Level Token                                      | Bot identity: bot token + Signing Secret; user identity: user token + Signing Secret                           |
| Dev laptop / behind firewall | Works as-is                                                                                                                                          | Needs a public tunnel (ngrok, Cloudflare Tunnel, Tailscale Funnel) or staging Gateway                          |
| Horizontal scaling           | One Socket Mode session per app per host; multiple Gateways need separate Slack apps                                                                 | Stateless POST handler; multiple Gateway replicas can share one app behind a load balancer                     |
| Multi-account on one Gateway | Supported; each account opens its own WS                                                                                                             | Supported; each account needs a unique `webhookPath` (default `/slack/events`) so registrations do not collide |
| Slash command transport      | Delivered over the WS connection; `slash_commands[].url` is ignored                                                                                  | Slack POSTs to `slash_commands[].url`; field is required for the command to dispatch                           |
| Request signing              | Not used (auth is the App-Level Token)                                                                                                               | Slack signs every request; OpenClaw verifies with `signingSecret`                                              |
| Recovery on connection drop  | Slack SDK auto-reconnect is enabled; OpenClaw also restarts failed Socket Mode sessions with bounded backoff. Pong-timeout transport tuning applies. | No persistent connection to drop; retries are per-request from Slack                                           |

<Note>
  **Pick Socket Mode** for single-Gateway hosts, dev laptops, and on-prem networks that can reach `*.slack.com` outbound but cannot accept inbound HTTPS.

**Pick HTTP Request URLs** when running multiple Gateway replicas behind a load balancer, when outbound WSS is blocked but inbound HTTPS is allowed, or when you already terminate Slack webhooks at a reverse proxy.
</Note>

<Warning>
  Slack can maintain multiple Socket Mode connections for one app and may deliver each payload to any connection. Separate OpenClaw gateways that share a Slack app therefore need equivalent routing and authorization configuration. Otherwise, use a separate Slack app per gateway, a single relay ingress, or HTTP Request URLs behind a load balancer. See [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode#using-multiple-connections).
</Warning>

### Relay mode

Relay mode separates Slack ingress from the OpenClaw gateway. A trusted router owns the single Slack Socket Mode connection, chooses a destination gateway, and forwards a typed event over an authenticated websocket. The gateway still uses its own bot token for outbound Slack Web API calls.

```json5
{
  channels: {
    slack: {
      mode: "relay",
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      relay: {
        url: "wss://router.example.com/gateway/ws",
        authToken: { source: "env", provider: "default", id: "SLACK_RELAY_AUTH_TOKEN" },
        gatewayId: "team-gateway",
      },
    },
  },
}
```

The relay URL must use `wss://` unless it targets localhost. Treat the bearer token and router route table as part of the Slack authorization boundary: routed events enter the normal Slack message handler as authorized activations. A router-provided `slack_identity` in the websocket `hello` frame can set the default outbound username and icon; an explicit identity supplied by the caller still wins. The relay connection reconnects with the same bounded backoff timing as Socket Mode and clears the router-provided identity whenever it disconnects.

### Enterprise Grid org-wide installs

One Slack account can receive messages from every workspace covered by an
Enterprise Grid org-wide installation. Choose direct Socket Mode or HTTP
Request URLs; relay mode is not supported for enterprise accounts. Both
least-privilege manifests below enable only the V1 `message` and `app_mention`
event path, immediate replies, and listener-owned status reactions.

#### Socket Mode

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": { "display_name": "OpenClaw", "always_online": true }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "channels:history",
        "channels:read",
        "chat:write",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "reactions:write",
        "users:read"
      ]
    }
  },
  "settings": {
    "org_deploy_enabled": true,
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim"
      ]
    }
  }
}
```

Have an Enterprise Grid Org Admin or Org Owner approve the app, install it at
the organization level, and choose the workspaces the installation covers.
Confirm that the app is available in every intended workspace before starting
OpenClaw. Generate an app-level token with `connections:write` for Socket Mode,
then copy the bot token from the org installation. Configure the account that
uses the org-installed bot token:

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "socket",
      enterpriseOrgInstall: true,
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "allowlist",
      channels: {
        C0123456789: { requireMention: true },
      },
    },
  },
}
```

#### HTTP Request URLs

Use HTTP mode when the Gateway has a public HTTPS endpoint and does not open a
Socket Mode connection. Replace the example URL with the Gateway's public
`webhookPath` URL (default `/slack/events`):

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": { "display_name": "OpenClaw", "always_online": true }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "channels:history",
        "channels:read",
        "chat:write",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "reactions:write",
        "users:read"
      ]
    }
  },
  "settings": {
    "org_deploy_enabled": true,
    "event_subscriptions": {
      "request_url": "https://gateway-host.example.com/slack/events",
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim"
      ]
    }
  }
}
```

Have an Enterprise Grid Org Admin or Org Owner approve the app, install it at
the organization level, and choose the workspaces the installation covers.
After Slack verifies the Request URL, copy the org installation's bot token and
the app's **Basic Information -> App Credentials -> Signing Secret**. Configure
the enterprise account with the same Request URL path:

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      enterpriseOrgInstall: true,
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      signingSecret: {
        source: "env",
        provider: "default",
        id: "SLACK_SIGNING_SECRET",
      },
      webhookPath: "/slack/events",
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "allowlist",
      channels: {
        C0123456789: { requireMention: true },
      },
    },
  },
}
```

At startup, OpenClaw verifies `enterpriseOrgInstall` with Slack `auth.test`.
An org-installed token without the flag, or a workspace token with the flag,
fails startup. Slack remains the source of truth for which workspaces have
granted the installation; OpenClaw then applies the configured channel, user,
DM, and mention policies to each delivered event. Enterprise V1 rejects all
bot-authored `message` and `app_mention` events before dispatch, regardless of
`allowBots`, because org installs do not provide a stable workspace-qualified
bot identity for loop prevention.

Enterprise support is intentionally limited to direct Socket Mode or HTTP
`message` and `app_mention` events and their immediate replies. Relay mode,
slash commands, interactions, App Home, reaction event listeners, pins, Slack
action tools, Slack-native approvals, bindings, queued or scheduled delivery,
and proactive sends are unavailable for an enterprise account. Outbound
acknowledgment, typing, and status reactions are supported through the
listener-owned Slack client and require `reactions:write`; inbound reaction
notifications and reaction action tools remain unavailable.

Immediate replies reuse the standard Slack delivery behavior for chunks,
media, metadata, identity fallback, unfurls, and receipts, but only while the
validated listener-owned client remains in the active event turn. The
in-memory send queue and thread-participation records are partitioned by that
event's workspace; the client itself is never serialized or persisted.

Channel policy keys and `dm.groupChannels` entries must use raw stable Slack channel IDs or the
`channel:<id>` form. OpenClaw normalizes either form to the raw channel ID for
runtime matching; `slack:`, `group:`, and `mpim:` prefixes fail startup.
User policy entries must use stable Slack user IDs; names, slugs, display names,
and email addresses fail startup. IDs must use Slack's canonical uppercase
prefix and body (for example, `C0123456789` or `U0123456789`); lowercase and
short lookalikes fail startup. Enterprise accounts cannot enable
`dangerouslyAllowNameMatching`. Enterprise accounts may set the global
`mentionPatterns.mode`, but `mentionPatterns.allowIn` and
`mentionPatterns.denyIn` fail startup because bare Slack channel IDs are not
workspace-qualified and can be reused across workspaces. Workspace installs
retain the existing scoped mention-pattern behavior. Each accepted workspace
gets separate routing, session, transcript, dedupe, history, and cache identity
even when Slack IDs overlap. Within the `message` stream, ordinary user messages
and user-authored `file_share` events are supported; other message subtypes are
rejected before authorization or system-event handling.

Enterprise DMs must either be disabled (`dm.enabled=false` or
`dmPolicy="disabled"`) or explicitly open with `dmPolicy="open"` and
an effective account `allowFrom` containing the literal `"*"`. An empty
allowlist or user-specific IDs without `"*"` fails startup. Pairing and
per-user DM allowlists are rejected because Slack user IDs are not
workspace-qualified in those authorization stores. Channel and sender policy
continues to apply to channel messages.

## Install

```bash
openclaw plugins install @openclaw/slack
```

`plugins install` registers and enables the plugin. It does nothing until you configure the Slack app and channel settings below. See [Plugins](/tools/plugin) for general plugin install rules.

## Quick setup

The manifests in this section create a workspace-scoped installation. For an
Enterprise Grid organization installation, use the dedicated
[org-wide manifest and workflow](#enterprise-grid-org-wide-installs) instead.

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
    "assistant_view": {
      "assistant_description": "OpenClaw connects Slack assistant threads to OpenClaw agents.",
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
        "assistant_thread_context_changed",
        "assistant_thread_started",
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
    "assistant_view": {
      "assistant_description": "OpenClaw connects Slack assistant threads to OpenClaw agents.",
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
        "assistant_thread_context_changed",
        "assistant_thread_started",
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
          **Recommended** matches the Slack plugin's full feature set: App Home, slash commands, files, reactions, pins, group DMs, and emoji/usergroup reads. Pick **Minimal** when workspace policy restricts scopes — it covers DMs, channel/group history, mentions, and slash commands but drops files, reactions, pins, group-DM (`mpim:*`), `emoji:read`, and `usergroups:read`. See [Manifest and scope checklist](#manifest-and-scope-checklist) for per-scope rationale and additive options like extra slash commands.
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

        Env fallback (default account only):

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
    "assistant_view": {
      "assistant_description": "OpenClaw connects Slack assistant threads to OpenClaw agents.",
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
        "assistant_thread_context_changed",
        "assistant_thread_started",
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
    "assistant_view": {
      "assistant_description": "OpenClaw connects Slack assistant threads to OpenClaw agents.",
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
        "assistant_thread_context_changed",
        "assistant_thread_started",
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
          **Recommended** matches the Slack plugin's full feature set; **Minimal** drops files, reactions, pins, group-DM (`mpim:*`), `emoji:read`, and `usergroups:read` for restrictive workspaces. See [Manifest and scope checklist](#manifest-and-scope-checklist) for per-scope rationale.
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
      identity: "user",
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
      identity: "user",
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

Notes:

- `socketMode` is ignored in HTTP Request URL mode.
- Base `channels.slack.socketMode` settings apply to all Slack accounts unless overridden. Per-account overrides use `channels.slack.accounts.<accountId>.socketMode`; because this is an object override, include every socket tuning field you want for that account.
- Only `clientPingTimeout` has an OpenClaw default (`15000`). `serverPingTimeout` and `pingPongLoggingEnabled` are passed to the Slack SDK only when configured.
- Socket Mode restart backoff starts around 2 seconds and caps around 30 seconds. Recoverable start, start-wait, and disconnect failures retry until the channel stops. Permanent account and credential errors such as invalid auth, revoked tokens, or missing scopes fail fast instead of retrying forever.

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
    "assistant_view": {
      "assistant_description": "OpenClaw connects Slack assistant threads to OpenClaw agents.",
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
        "assistant_thread_context_changed",
        "assistant_thread_started",
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
        "assistant_thread_context_changed",
        "assistant_thread_started",
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

The default manifest enables the Slack App Home **Home** tab and subscribes to `app_home_opened`. When a workspace member opens the Home tab, OpenClaw publishes a safe default Home view with `views.publish`; no conversation payload or private configuration is included. When single slash command mode is enabled, the command hint uses `channels.slack.slashCommand.name`; installations using native commands or no slash commands omit that hint. The **Messages** tab remains enabled for Slack DMs. The manifest also enables Slack assistant threads with `features.assistant_view`, `assistant:write`, `assistant_thread_started`, and `assistant_thread_context_changed`; assistant threads route to their own OpenClaw thread sessions and keep Slack-provided thread context available to the agent.

<AccordionGroup>
  <Accordion title="Optional native slash commands">

    Multiple [native slash commands](#commands-and-slash-behavior) can be used instead of a single configured command with nuance:

    - Use `/agentstatus` instead of `/status` because the `/status` command is reserved.
    - No more than 25 slash commands can be registered on a Slack app at once (Slack platform limit).

    OpenClaw registers handlers for enabled native commands, but Slack manifest entries remain administrator-managed and are not synchronized at runtime. Add `/login` to the manifest manually; the example below includes it instead of the optional `/side` alias to remain at 25 commands. `/login` can be surfaced anywhere, but it issues pairing codes only in private chats or the Web UI.

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
      "command": "/approve",
      "description": "Approve or deny pending approval requests",
      "usage_hint": "<id> <decision>"
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
      "command": "/login",
      "description": "Pair Codex login",
      "usage_hint": "[codex|openai]"
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
For bot identity, actions and directory reads can prefer an optional user token; writes continue to use the bot token unless `userTokenReadOnly: false` allows fallback. For `identity: "user"`, reads and writes always use `userToken`.
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
            C12345678: { enabled: true, requireMention: true },
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
            "#eng-my-channel": { enabled: true, requireMention: true },
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
    - replies to the bot's own Slack message (`implicitMentions.replyToBot`)
    - follow-ups in threads where the bot participated (`implicitMentions.threadParticipation`)

    Per-channel controls (`channels.slack.channels.<id>`; names only via startup resolution or `dangerouslyAllowNameMatching`):

    - `requireMention`
    - `ignoreOtherMentions`
    - `replyToMode` (`off|first|all|batched`; overrides account/chat-type reply mode for this channel)
    - `users` (allowlist)
    - `allowBots`
    - `skills`
    - `systemPrompt`
    - `tools`, `toolsBySender`
    - `toolsBySender` key format: `channel:`, `id:`, `e164:`, `username:`, `name:`, or `"*"` wildcard
      (legacy unprefixed keys still map to `id:` only)

    `ignoreOtherMentions` (default `false`) drops channel messages that mention another user or user group but not this bot. DMs and group DMs (MPIMs) are unaffected. The filter requires a resolved bot user ID from `auth.test`; if that identity is unavailable (for example a user-token-only identity), the gate fails open and messages pass through unchanged.

    `allowBots` is conservative for channels and private channels: bot-authored room messages are accepted only when the sending bot is explicitly listed in that room's `users` allowlist, or when at least one explicit Slack owner ID from `channels.slack.allowFrom` is currently a room member. Wildcards and display-name owner entries do not satisfy owner presence. Owner presence uses Slack `conversations.members`; make sure the app has the matching read scope for the room type (`channels:read` for public channels, `groups:read` for private channels). If the member lookup fails, OpenClaw drops the bot-authored room message.

    Accepted bot-authored Slack messages use shared [bot loop protection](/channels/bot-loop-protection). Configure `channels.defaults.botLoopProtection` for the default budget, then override with `channels.slack.botLoopProtection` or `channels.slack.channels.<id>.botLoopProtection` when a workspace or channel needs a different limit.

  </Tab>
</Tabs>

## Threading, sessions, and reply tags

- DMs route as `direct`; channels as `channel`; MPIMs as `group`.
- Slack route bindings accept raw peer IDs plus Slack target forms such as `channel:C12345678`, `user:U12345678`, and `<@U12345678>`.
- With default `session.dmScope=main`, Slack DMs collapse to agent main session.
- Channel sessions: `agent:<agentId>:slack:channel:<channelId>`.
- Ordinary top-level channel messages stay on the per-channel session, even when `replyToMode` is non-`off`.
- Slack thread replies use the parent Slack `thread_ts` for session suffixes (`:thread:<threadTs>`), even when outbound reply threading is disabled with `replyToMode="off"`.
- OpenClaw seeds an eligible top-level channel root into `agent:<agentId>:slack:channel:<channelId>:thread:<rootTs>` when that root is expected to start a visible Slack thread, so the root and later thread replies share one OpenClaw session. This applies to `app_mention` events, explicit bot or configured mention-pattern matches, and `requireMention: false` channels with non-`off` `replyToMode`.
- `channels.slack.thread.historyScope` default is `thread`; `thread.inheritParent` default is `false`.
- `channels.slack.thread.initialHistoryLimit` controls how many existing thread messages are fetched when a new thread session starts (default `20`; set `0` to disable).
- `channels.slack.implicitMentions.replyToBot` controls whether a reply to the bot's own message bypasses mention gating (default `true`).
- `channels.slack.implicitMentions.threadParticipation` controls whether follow-ups in a thread where the bot has replied bypass mention gating (default `true`). Set it to `false` to require a new explicit mention in those follow-ups. `openclaw doctor --fix` migrates the former `channels.slack.thread.requireExplicitMention` key to this positive canonical flag.
- Account overrides live at `channels.slack.accounts.<id>.implicitMentions`; shared defaults live at `channels.defaults.implicitMentions`.

Reply threading controls:

- `channels.slack.channels.<id>.replyToMode`: per-channel override for Slack channel/private-channel messages
- `channels.slack.replyToMode`: `off|first|all|batched` (default `off`)
- `channels.slack.replyToModeByChatType`: per `direct|group|channel`
- legacy fallback for direct chats: `channels.slack.dm.replyToMode`

Manual reply tags are supported:

- `[[reply_to_current]]`
- `[[reply_to:<id>]]`

For explicit Slack thread replies from the `message` tool, set `replyBroadcast: true` with `action: "send"` and `threadId` or `replyTo` to ask Slack to also broadcast the thread reply to the parent channel. This maps to Slack's `chat.postMessage` `reply_broadcast` flag and is only supported for text or Block Kit sends, not media uploads.

When a `message` tool call runs inside a Slack thread and targets the same channel, OpenClaw normally inherits the current Slack thread according to the effective account, chat-type, or per-channel `replyToMode`. Automatic replies and same-channel `send` or `upload-file` calls use the same per-channel override. Set `topLevel: true` on `action: "send"` or `action: "upload-file"` to force a new parent-channel message instead. `threadId: null` is accepted as the same top-level opt-out.

<Note>
`replyToMode="off"` disables outbound Slack reply threading, including explicit `[[reply_to_*]]` tags. It does not flatten inbound Slack thread sessions: messages already posted inside a Slack thread still route to the `:thread:<threadTs>` session. This differs from Telegram, where explicit tags are still honored in `"off"` mode. Slack threads hide messages from the channel while Telegram replies stay visible inline.
</Note>

## Ack reactions

`ackReaction` sends an acknowledgement emoji while OpenClaw is processing an inbound message. `ackReactionScope` decides _when_ that emoji is actually sent.

By default, the acknowledgement stays static while Slack's native assistant thread status shows progress with rotating loading messages. Set `messages.statusReactions.enabled: true` to opt into the queued/thinking/tool/done/error reaction lifecycle instead.

### Emoji (`ackReaction`)

Resolution order:

- `channels.slack.accounts.<accountId>.ackReaction`
- `channels.slack.ackReaction`
- `messages.ackReaction`
- agent identity emoji fallback (`agents.list[].identity.emoji`, else `"eyes"` / 👀)

Notes:

- Slack expects shortcodes (for example `"eyes"`).
- Use `""` to disable the reaction for the Slack account or globally.

### Scope (`messages.ackReactionScope`)

The Slack provider reads scope from `messages.ackReactionScope` (default `"group-mentions"`). There is no Slack-account or Slack-channel-level override today; the value is global to the gateway.

Values:

- `"all"`: react in DMs and groups, including ambient room events.
- `"direct"`: react in DMs only.
- `"group-all"`: react on every group message except ambient room events (no DMs).
- `"group-mentions"` (default): react in groups, but only when the bot is mentioned (or in group mentionables that opted in). **DMs are excluded.**
- `"off"` / `"none"`: never react.

<Note>
The default scope (`"group-mentions"`) does not fire ack reactions in direct messages or ambient room events. To see the configured `ackReaction` (for example `"eyes"`) on inbound Slack DMs and quiet room events, set `messages.ackReactionScope` to `"all"`. `messages.ackReactionScope` is read at Slack provider startup, so a gateway restart is needed for the change to take effect.
</Note>

```json5
{
  messages: {
    ackReaction: "eyes",
    ackReactionScope: "all", // react in DMs and groups
  },
}
```

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

Slack native progress task cards are opt-in for progress mode. Set `channels.slack.streaming.progress.nativeTaskCards` to `true` with `channels.slack.streaming.mode="progress"` to send a Slack-native plan/task card while work is running, then update the same task card at completion. Without this flag, progress mode keeps the portable draft-preview behavior.

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

Opt in to Slack native progress task cards:

```json5
{
  channels: {
    slack: {
      streaming: {
        mode: "progress",
        progress: {
          nativeTaskCards: true,
          render: "rich",
        },
      },
    },
  },
}
```

Legacy keys:

- `channels.slack.streamMode` (`replace | status_final | append`) is a legacy alias for `channels.slack.streaming.mode`.
- boolean `channels.slack.streaming` is a legacy alias for `channels.slack.streaming.mode` and `channels.slack.streaming.nativeTransport`.
- top-level `channels.slack.chunkMode` and `channels.slack.nativeStreaming` are legacy aliases for `channels.slack.streaming.chunkMode` and `channels.slack.streaming.nativeTransport`.
- Legacy aliases are not read at runtime; run `openclaw doctor --fix` to rewrite persisted Slack streaming config to the canonical keys.

## Typing reaction fallback

`typingReaction` adds a temporary reaction to the inbound Slack message while OpenClaw is processing a reply, then removes it when the run finishes. This is most useful outside of thread replies, which use a default "is typing..." status indicator.

Resolution order:

- `channels.slack.accounts.<accountId>.typingReaction`
- `channels.slack.typingReaction`

Notes:

- Slack expects shortcodes (for example `"hourglass_flowing_sand"`).
- The reaction is best-effort and cleanup is attempted automatically after the reply or failure path completes.

## Voice input

To speak to OpenClaw in Slack today, send a Slack audio clip to the OpenClaw app. Slackbot's dictation microphone is a separate Slack-owned feature, not an app API.

- **[Slackbot voice dictation](https://slack.com/help/articles/202026038-How-to-use-Slackbot)** lives inside the user's private Slackbot conversation. Slack turns the recording into a Slackbot prompt but does not emit an audio file, dictation event, prompt, or input-source marker to third-party Slack apps through the Events API. The OpenClaw Slack plugin cannot enable or receive it.
- **[Slack audio clips](https://slack.com/help/articles/4406235165587-Record-audio-and-video-clips-in-Slack)** are stored Slack files that can be posted in an OpenClaw DM, channel, or thread. OpenClaw downloads an accessible clip with the bot token, normalizes Slack's clip MIME metadata, and sends it through the shared [audio transcription pipeline](/nodes/audio). The recommended app manifest includes the required `files:read` scope.

Audio clips and Slackbot dictation have different privacy semantics: clips follow Slack file-retention policy and OpenClaw downloads them for transcription, while Slack says dictation audio is not stored.

In a channel with `requireMention: true`, a captionless audio clip can satisfy the gate by speaking a configured mention pattern (`agents.list[].groupChat.mentionPatterns`, falling back to `messages.groupChat.mentionPatterns`). OpenClaw authorizes the sender before downloading or transcribing the clip, then admits it only when the transcript matches. A failed or nonmatching speculative transcript is discarded with the downloaded clip; it is not retained in channel history. Native Slack `@bot` identity cannot be inferred from speech, so configure a spoken-name pattern or include a typed mention. If transcript echoing is enabled, the echo is sent only after admission.

## Media, chunking, and delivery

<AccordionGroup>
  <Accordion title="Inbound attachments">
    Slack file attachments are downloaded from Slack-hosted private URLs (token-authenticated request flow) and written to the media store when fetch succeeds and size limits permit. File placeholders include the Slack `fileId` so agents can fetch the original file with `download-file`.

    Downloads use bounded idle and total timeouts. If Slack file retrieval stalls or fails, OpenClaw keeps processing the message and falls back to the file placeholder.

    Runtime inbound size cap defaults to `20MB` unless overridden by `channels.slack.mediaMaxMb`.

  </Accordion>

  <Accordion title="Outbound text and files">
    - text chunks use `channels.slack.textChunkLimit` (default `8000`, capped at Slack's own message-length limit)
    - `channels.slack.streaming.chunkMode="newline"` enables paragraph-first splitting
    - file sends use Slack upload APIs and can include thread replies (`thread_ts`)
    - long file captions use the first Slack-safe text chunk as the upload comment and send remaining chunks as follow-up messages
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

Native argument menus render as one of the following, in priority order:

- 3-5 short-enough options: an overflow ("...") menu
- more than 100 options, with async option filtering available: external select
- 1-2 options, or any option whose encoded value is too long for a select: button blocks
- otherwise (6-100 options, or more than 100 without async filtering): static select menu, chunked at 100 options per menu

```txt
/think
```

Slash sessions use isolated keys like `agent:<agentId>:slack:slash:<userId>` and still route command executions to the target conversation session using `CommandTargetSessionKey`.

## Native charts

Slack's public [`data_visualization` Block Kit block](https://docs.slack.dev/reference/block-kit/blocks/data-visualization-block/)
renders line, bar, area, and pie charts in messages. OpenClaw maps the portable
`presentation` `chart` block to that native shape; no additional OAuth scope,
file upload, image renderer, or Slack configuration is required beyond normal
`chat:write` message access.

```json
{
  "blocks": [
    {
      "type": "chart",
      "chartType": "bar",
      "title": "Quarterly revenue",
      "categories": ["Q1", "Q2"],
      "series": [{ "name": "Revenue", "values": [120, 145] }],
      "xLabel": "Quarter"
    }
  ]
}
```

Slack's limits are enforced before native rendering:

- title and optional axis labels: 50 characters
- pie: 1-12 positive segments
- line/bar/area: 1-12 uniquely named series and 1-20 shared categories
- segment, category, and series labels: 20 characters
- every series must contain one finite value for every category; non-pie values
  may be negative

Every native chart also carries a top-level text representation for screen
readers, notifications, session mirroring, and clients that cannot render the
block. Standard presentation sends to other OpenClaw channels receive that same
deterministic chart data as text unless they advertise native chart support. If
Slack rejects the chart with `invalid_blocks` during a phased rollout, OpenClaw
removes the rejected native data blocks, keeps any sibling controls, and sends
the complete chart representation as visible text.

Slack currently accepts up to two `data_visualization` blocks per message. When
a presentation contains more than two valid charts, OpenClaw keeps their order
and continues native rendering in follow-up messages, with no more than two
charts in each message.

Slack's [developer launch](https://docs.slack.dev/changelog/2026/06/16/block-kit-data-visualization-block/)
documents the block as an app-facing Block Kit feature and publishes no paid
plan restriction. The Business+/Enterprise eligibility language applies to
Slackbot's automatic AI chart generation, which is separate from an app sending
an already-structured Block Kit chart. Charts are message-only blocks, not App
Home, modal, or Canvas content.

## Native tables

Slack's current [`data_table` Block Kit block](https://docs.slack.dev/reference/block-kit/blocks/data-table-block/)
renders structured rows and columns in messages. OpenClaw maps an explicit
portable `presentation` `table` block to `data_table`; it does not use Slack's
legacy [`table` block](https://docs.slack.dev/reference/block-kit/blocks/table-block/).
No additional OAuth scope or Slack configuration is required beyond normal
`chat:write` message access.

```json
{
  "blocks": [
    {
      "type": "table",
      "caption": "Open pipeline",
      "headers": ["Account", "Stage", "ARR"],
      "rows": [
        ["Acme", "Won", 125000],
        ["Globex", "Review", 82000]
      ],
      "rowHeaderColumnIndex": 0
    }
  ]
}
```

OpenClaw maps header and string cells to Slack `raw_text` cells. Numeric cells
map to `raw_number`, with the finite numeric value preserved for native sorting
and filtering. `rowHeaderColumnIndex`, when present, marks that zero-based
column as Slack row headers.

Slack's published `data_table` limits are enforced before native rendering:

- 1-20 columns
- 1-100 data rows, plus the header row
- the same number of cells in every row
- at most 10,000 aggregate characters across all table cells in one message

Multiple valid table blocks can render natively while the message remains
within the aggregate character limit. A table that cannot render within the
native envelope becomes complete deterministic text instead of losing rows or
cells. If that text exceeds one Slack message, sends and slash responses use
ordered text chunks. Table edits fail with an explicit size error instead of
silently truncating rows from an existing message.

Every native table produced from portable presentation also carries a top-level
text representation for screen readers, notifications, session mirroring, and
clients that cannot render the block. Raw chart and table values stay literal
in the fallback, so cell data such as `<@U123>` does not become a Slack mention.
If Slack rejects native chart or table blocks with `invalid_blocks`, OpenClaw
removes every native data block in one bounded recovery step, retains valid
sibling blocks such as buttons and selects, and sends complete visible chart
and table text with Slack formatting disabled. Slash-command delivery
tracks Slack's five-call `response_url` budget across the command. Before each
reply batch, it selects a complete plan that fits the remaining calls or fails
before posting that batch.

Only explicit `presentation` table blocks are promoted to native tables.
Markdown pipe tables remain authored text; OpenClaw does not guess at table
structure or cell types. Existing trusted Slack-native producers can continue
to pass raw blocks through `channelData.slack.blocks`; OpenClaw derives fallback
text from valid raw `data_table` cells, while malformed custom blocks may
degrade to their caption or general Block Kit fallback. Portable agent, CLI,
and plugin output should use `presentation`.

## Interactive replies

Slack can render agent-authored interactive reply controls, but this feature is disabled by default.
For new agent, CLI, and plugin output, prefer the shared
`presentation` buttons or select blocks. They use the same Slack interaction
path while also degrading on other channels.

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

When enabled, agents can still emit deprecated Slack-only reply directives:

- `[[slack_buttons: Approve:approve, Reject:reject]]`
- `[[slack_select: Choose a target | Canary:canary, Production:production]]`

These directives compile into Slack Block Kit and route clicks or selections
back through the existing Slack interaction event path. Keep them for old
prompts and Slack-specific escape hatches; use shared presentation for new
portable controls.

The directive compiler APIs are also deprecated for new producer code:

- `compileSlackInteractiveReplies(...)`
- `parseSlackOptionsLine(...)`
- `isSlackInteractiveRepliesEnabled(...)`
- `buildSlackInteractiveBlocks(...)`

Use `presentation` payloads and `buildSlackPresentationBlocks(...)` for new
Slack-rendered controls.

Notes:

- This is Slack-specific legacy UI. Other channels do not translate Slack Block
  Kit directives into their own button systems.
- The interactive callback values are OpenClaw-generated opaque tokens, not raw agent-authored values.
- If generated interactive blocks would exceed Slack Block Kit limits, OpenClaw falls back to the original text reply instead of sending an invalid blocks payload.

### Plugin-owned modal submissions

Slack plugins that register an interactive handler can also receive modal
`view_submission` and `view_closed` lifecycle events before OpenClaw compacts
the payload for the agent-visible system event. Use one of these routing
patterns when opening a Slack modal:

- Set `callback_id` to `openclaw:<namespace>:<payload>`.
- Or keep an existing `callback_id` and put `pluginInteractiveData:
"<namespace>:<payload>"` in the modal `private_metadata`.

The handler receives `ctx.interaction.kind` as `view_submission` or
`view_closed`, normalized `inputs`, and the full raw `stateValues` object from
Slack. Callback-id-only routing is enough to invoke the plugin handler; include
the existing modal `private_metadata` user/session routing fields when the
modal should also produce an agent-visible system event. The agent receives a
compact, redacted `Slack interaction: ...` system event. If the handler returns
`systemEvent.summary`, `systemEvent.reference`, or `systemEvent.data`, those
fields are included in that compact event so the agent can reference
plugin-owned storage without seeing the complete form payload.

## Native approvals in Slack

Slack can act as a native approval client with interactive buttons and interactions, instead of falling back to the Web UI or terminal.

- Exec and plugin approvals can render as Slack-native Block Kit prompts.
- `channels.slack.execApprovals.*` remains the native exec approval client enablement and DM/channel routing config.
- Exec approval DMs use `channels.slack.execApprovals.approvers` or `commands.ownerAllowFrom`.
- Plugin approvals use Slack-native buttons when Slack is enabled as a native approval client for the originating session, or when `approvals.plugin` routes to the originating Slack session or a Slack target.
- Plugin approval DMs use Slack plugin approvers from `channels.slack.allowFrom`, named-account `allowFrom`, or the account default route.
- Approver authorization is still enforced: exec-only approvers cannot approve plugin requests unless they are also plugin approvers.

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
exec approver resolves. Slack can also handle native plugin approvals through this native-client
path when Slack plugin approvers resolve and the request matches the native-client filters. Set
`enabled: false` to disable Slack as a native approval client explicitly. Set `enabled: true` to
force native approvals on when approvers resolve. Disabling Slack exec approvals does not disable
native Slack plugin approval delivery that is enabled through `approvals.plugin`; plugin approval
delivery uses Slack plugin approvers instead.

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
separate; Slack native delivery suppresses that fallback only when Slack can handle the plugin
approval request natively.

Same-chat `/approve` also works in Slack channels and DMs that already support commands. See [Exec approvals](/tools/exec-approvals) for the full approval forwarding model.

## Events and operational behavior

- Message edits/deletes are mapped into system events.
- Thread broadcasts ("Also send to channel" thread replies) are processed as normal user messages.
- Reaction add/remove events are mapped into system events.
- Member join/leave, channel created/renamed, and pin add/remove events are mapped into system events.
- Optional presence polling can map an observed human participant's `away` to `active` transition into the participant's most recently active eligible Slack session. The default is off.
- `channel_id_changed` can migrate channel config keys when `configWrites` is enabled.
- Channel topic/purpose metadata is treated as untrusted context and can be injected into routing context.
- Thread starter and initial thread-history context seeding are filtered by configured sender allowlists when applicable.
- Block actions, shortcuts, and modal interactions emit structured `Slack interaction: ...` system events with rich payload fields:
  - block actions: selected values, labels, picker values, and `workflow_*` metadata
  - global shortcuts: callback and actor metadata, routed to the actor's direct session
  - message shortcuts: callback, actor, channel, thread, and selected-message context
  - modal `view_submission` and `view_closed` events with routed channel metadata and form inputs

Define global or message shortcuts in your Slack app configuration and use any non-empty callback ID. OpenClaw acknowledges matching shortcut payloads, applies the same DM/channel sender policy as other Slack interactions, and queues the sanitized event for the routed agent session. Trigger IDs and response URLs are redacted from agent context.

### Presence events

Slack does not send presence changes through the Events API or Socket Mode. OpenClaw can instead poll [`users.getPresence`](https://docs.slack.dev/reference/methods/users.getPresence/) for human participants whose messages passed normal Slack access and routing checks.

```json5
{
  channels: {
    slack: {
      presenceEvents: { mode: "auto" },
      channels: {
        C0123456789: { presenceEvents: { mode: "on" } },
        C0987654321: { presenceEvents: { mode: "off" } },
      },
    },
  },
}
```

- `off` (default): no presence timer or Slack API calls.
- `auto`: monitor DMs, MPIMs, and Slack threads active in the last 24 hours with at most 8 observed human participants. Top-level channel sessions are excluded.
- `on`: monitor the same conversations without the participant cap and include top-level channel sessions. Use a per-channel override to force or suppress one channel.

OpenClaw polls at most 45 unique users per minute per Slack account, seeds the first result without waking the agent, and only wakes on an observed `away` to `active` transition. A durable 8-hour cooldown applies per Slack account and user, even if that person participates in several threads. The event routes only to that person's most recently active eligible conversation and tells the agent to consult memory/wiki and known timezone context before deciding whether to send one short greeting. The agent may stay silent.

The bot token needs `users:read`, which is already included in the recommended manifest. Presence events are unavailable for Enterprise Grid org-wide installs.

## Configuration reference

Primary reference: [Configuration reference - Slack](/gateway/config-channels#slack).

<Accordion title="High-signal Slack fields">

- mode/auth: `identity`, `mode`, `enterpriseOrgInstall`, `botToken`, `appToken`, `userToken`, `signingSecret`, `webhookPath`, `accounts.*`
- DM access: `dm.enabled`, `dmPolicy`, `allowFrom` (legacy: `dm.policy`, `dm.allowFrom`), `dm.groupEnabled`, `dm.groupChannels`
- compatibility toggle: `dangerouslyAllowNameMatching` (break-glass; keep off unless needed)
- channel access: `groupPolicy`, `channels.*`, `channels.*.users`, `channels.*.requireMention`, `implicitMentions.*`
- threading/history: `replyToMode`, `replyToModeByChatType`, `thread.*`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
- presence wakes: `presenceEvents.mode`, `channels.*.presenceEvents.mode` (`off|auto|on`; default `off`)
- delivery: `textChunkLimit`, `streaming.chunkMode`, `mediaMaxMb`, `streaming`, `streaming.nativeTransport`, `streaming.preview.toolProgress`
- unfurls: `unfurlLinks` (default: `false`), `unfurlMedia` for `chat.postMessage` link/media preview control; set `unfurlLinks: true` to opt back into link previews
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
    - `messages.groupChat.visibleReplies`: normal group/channel requests default to `"automatic"`. If you opted into `"message_tool"` and logs show assistant text with no `message(action=send)` call, the model missed the visible message-tool path. Final text stays private in this mode; inspect the gateway verbose log for suppressed payload metadata, or set it to `"automatic"` if you want every normal assistant final reply posted through the legacy path.
    - `messages.groupChat.unmentionedInbound`: if it is `"room_event"`, unmentioned allowed channel chatter is ambient context and stays silent unless the agent calls the `message` tool. See [Ambient room events](/channels/ambient-room-events).

```json5
{
  messages: {
    groupChat: {
      visibleReplies: "automatic",
    },
  },
}
```

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
    - pairing approvals / allowlist entries (`dmPolicy: "open"` still requires `channels.slack.allowFrom: ["*"]`)
    - group DMs use MPIM handling; enable `channels.slack.dm.groupEnabled` and, if configured, include the MPIM in `channels.slack.dm.groupChannels`
    - Slack Assistant DM events: verbose logs mentioning `drop message_changed`
      usually mean Slack sent an edited Assistant-thread event without a
      recoverable human sender in message metadata

```bash
openclaw pairing list slack
```

  </Accordion>

  <Accordion title="Socket mode not connecting">
    Validate bot + app tokens and Socket Mode enablement in Slack app settings.
    The App-Level Token needs `connections:write`, and the Bot User OAuth Token
    bot token must belong to the same Slack app/workspace as the app token.

    If `openclaw channels status --probe --json` shows `botTokenStatus` or
    `appTokenStatus: "configured_unavailable"`, the Slack account is
    configured but the current runtime could not resolve the SecretRef-backed
    value.

    Logs such as `slack socket mode failed to start; retry ...` are recoverable
    start failures. Missing scopes, revoked tokens, and invalid auth fail fast
    instead. A `slack token mismatch ...` log means the bot token and app token
    appear to belong to different Slack apps; fix the Slack app credentials.

  </Accordion>

  <Accordion title="HTTP mode not receiving events">
    Validate:

    - signing secret
    - webhook path
    - Slack Request URLs (Events + Interactivity + Slash Commands)
    - unique `webhookPath` per HTTP account
    - the public URL terminates TLS and forwards requests to the Gateway path
    - the Slack app `request_url` path exactly matches `channels.slack.webhookPath` (default `/slack/events`)

    If `signingSecretStatus: "configured_unavailable"` appears in account
    snapshots, the HTTP account is configured but the current runtime could not
    resolve the SecretRef-backed signing secret.

    A repeated `slack: webhook path ... already registered` log means two HTTP
    accounts are using the same `webhookPath`; give each account a distinct path.

  </Accordion>

  <Accordion title="Native/slash commands not firing">
    Verify whether you intended:

    - native command mode (`channels.slack.commands.native: true`) with matching slash commands registered in Slack
    - or single slash command mode (`channels.slack.slashCommand.enabled: true`)

    Slack does not create or remove slash commands automatically. `commands.native: "auto"` does not enable Slack native commands; use `true` and create the matching commands in the Slack app. In HTTP mode, every Slack slash command must include the Gateway URL. In Socket Mode, command payloads arrive over the websocket and Slack ignores `slash_commands[].url`.

    Also check `commands.useAccessGroups`, DM authorization, channel allowlists,
    and per-channel `users` allowlists. Slack returns ephemeral errors for
    blocked slash-command senders, including:

    - `This channel is not allowed.`
    - `You are not authorized to use this command here.`

  </Accordion>
</AccordionGroup>

## Attachment media reference

Slack can attach downloaded media to the agent turn when Slack file downloads succeed and size limits permit. Audio clips can be transcribed, image files can pass through the media-understanding path or directly to a vision-capable reply model, and other files remain available as downloadable file context.

### Supported media types

| Media type                     | Source               | Current behavior                                                                  | Notes                                                                     |
| ------------------------------ | -------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Slack audio clips              | Slack file URL       | Downloaded and routed through shared audio transcription                          | Requires `files:read` and a working `tools.media.audio` model or CLI      |
| JPEG / PNG / GIF / WebP images | Slack file URL       | Downloaded and attached to the turn for vision-capable handling                   | Per-file cap: `channels.slack.mediaMaxMb` (default 20 MB)                 |
| PDF files                      | Slack file URL       | Downloaded and exposed as file context for tools such as `download-file` or `pdf` | Slack inbound does not convert PDFs into image-vision input automatically |
| Other files                    | Slack file URL       | Downloaded when possible and exposed as file context                              | Binary files are not treated as image input                               |
| Thread replies                 | Thread starter files | Root-message files can be hydrated as context when the reply has no direct media  | File-only starters use an attachment placeholder                          |
| Multi-file messages            | Multiple Slack files | Each file is evaluated independently                                              | Slack processing is capped at eight files per message                     |

### Inbound pipeline

When a Slack message with file attachments arrives:

1. OpenClaw downloads the file from Slack's private URL using the bot token.
2. The file is written to the media store on success.
3. Downloaded media paths and content types are added to the inbound context.
4. Audio clips are routed to the shared transcription pipeline; image-capable model/tool paths can use image attachments from the same context.
5. Other files remain available as file metadata or media references for tools that can handle them.

### Thread-root attachment inheritance

When a message arrives in a thread (has a `thread_ts` parent):

- If the reply itself has no direct media and the included root message has files, Slack can hydrate the root files as thread-starter context.
- Root files are hydrated only while seeding a new or reset thread session. Later text-only replies reuse the existing session context and do not reattach root files as fresh media.
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
- **Audio transcription cap**: `tools.media.audio.maxBytes` also applies when the downloaded file is sent to a transcription provider or CLI.
- **Download failures**: Files that Slack cannot serve, expired URLs, inaccessible files, oversize files, and Slack auth/login HTML responses are skipped instead of being reported as unsupported formats.
- **Vision model**: Image analysis uses the active reply model when it supports vision, or the image model configured at `agents.defaults.imageModel`.

### Known limits

| Scenario                                      | Current behavior                                                                   | Workaround                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Expired Slack file URL                        | File skipped; no error shown                                                       | Re-upload the file in Slack                                                   |
| Audio transcription unavailable               | Clip remains attached but no transcript is produced                                | Configure `tools.media.audio` or install a supported local transcription CLI  |
| Captionless clip does not pass a mention gate | Dropped after private speculative transcription; transcript and download discarded | Configure a spoken-name mention pattern, add a typed bot mention, or use a DM |
| Vision model not configured                   | Image attachments are stored as media references, but not analyzed as images       | Configure `agents.defaults.imageModel` or use a vision-capable reply model    |
| Very large images (> 20 MB by default)        | Skipped per size cap                                                               | Increase `channels.slack.mediaMaxMb` if Slack allows                          |
| Forwarded/shared attachments                  | Text and Slack-hosted image/file media are best-effort                             | Re-share directly in the OpenClaw thread                                      |
| PDF attachments                               | Stored as file/media context, not automatically routed through image vision        | Use `download-file` for file metadata or the `pdf` tool for PDF analysis      |

### Related documentation

- [Media understanding pipeline](/nodes/media-understanding)
- [Audio and voice notes](/nodes/audio)
- [PDF tool](/tools/pdf)

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
