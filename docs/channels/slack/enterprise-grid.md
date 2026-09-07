---
summary: "Org-wide Slack installs across every workspace in a Grid organization"
read_when:
  - Installing OpenClaw at the Enterprise Grid organization level
  - Writing workspace-qualified channel and user policy keys
  - Checking which features an enterprise account supports
title: "Slack Enterprise Grid"
sidebarTitle: "Enterprise Grid"
---

Install once at the organization level, then set workspace-qualified policy keys.

## Enterprise Grid org-wide installs

One Slack account can receive messages and interactions from every workspace
covered by an Enterprise Grid org-wide installation. Choose direct Socket Mode
or HTTP Request URLs; relay mode is not supported for enterprise accounts. Both
least-privilege manifests below enable the Enterprise message, mention,
reaction, pin, channel-created, and channel-renamed event paths, immediate
replies, listener-owned status reactions, Slack interactivity for Block Kit
actions and modal submissions, and the single `/openclaw` slash command.

### Socket Mode

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": { "display_name": "OpenClaw", "always_online": true },
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
        "channels:history",
        "channels:read",
        "chat:write",
        "commands",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "pins:read",
        "reactions:read",
        "reactions:write",
        "users:read"
      ]
    }
  },
  "settings": {
    "org_deploy_enabled": true,
    "socket_mode_enabled": true,
    "interactivity": { "is_enabled": true },
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "channel_created",
        "channel_rename",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "member_joined_channel",
        "member_left_channel",
        "pin_added",
        "pin_removed",
        "reaction_added",
        "reaction_removed"
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
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      slashCommand: { enabled: true, name: "openclaw" },
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

### HTTP Request URLs

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
    "bot_user": { "display_name": "OpenClaw", "always_online": true },
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
        "channels:history",
        "channels:read",
        "chat:write",
        "commands",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "pins:read",
        "reactions:read",
        "reactions:write",
        "users:read"
      ]
    }
  },
  "settings": {
    "org_deploy_enabled": true,
    "interactivity": {
      "is_enabled": true,
      "request_url": "https://gateway-host.example.com/slack/events"
    },
    "event_subscriptions": {
      "request_url": "https://gateway-host.example.com/slack/events",
      "bot_events": [
        "app_mention",
        "channel_created",
        "channel_rename",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "member_joined_channel",
        "member_left_channel",
        "pin_added",
        "pin_removed",
        "reaction_added",
        "reaction_removed"
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
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      signingSecret: {
        source: "env",
        provider: "default",
        id: "SLACK_SIGNING_SECRET",
      },
      slashCommand: { enabled: true, name: "openclaw" },
      webhookPath: "/slack/events",
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "allowlist",
      channels: {
        "team:T0123456789:channel:C0123456789": { requireMention: true },
      },
    },
  },
}
```

For each selected workspace, open it in Slack's web app and copy the `T...`
workspace ID from `https://app.slack.com/client/T.../...`. Use that workspace ID
with the channel's `C...` ID in every qualified policy key, as shown above.

At startup, OpenClaw uses Slack `auth.test` to detect whether the token belongs
to a workspace installation or an Enterprise Grid org-wide installation. No
installation-mode setting is required. Slack remains the source of truth for
which workspaces have granted the installation; OpenClaw then applies the
configured channel, user, DM, and mention policies to each delivered event.
Enterprise installs reject bot-authored `message` and `app_mention` events by
default. Set `allowBots` on the account or channel to admit them under the same
loop-prevention rules used by workspace installs. OpenClaw retains the org
installation's `auth.test` `user_id` and `bot_id` for that check.

Enterprise support accepts direct Socket Mode or HTTP message, mention,
membership, reaction, pin, channel-created, channel-renamed, Block Kit action,
modal, and configured shortcut and slash-command payloads plus
workspace-qualified outbound messages and presence polling. Add any shortcuts to the app manifest's
`features.shortcuts` list; OpenClaw accepts their callback IDs through the same
interaction path. The manifest examples register the single `/openclaw`
command; native command mode still requires the administrator-managed command
entries described in
[Optional native slash commands](/channels/slack/manifest-and-scopes#optional-native-slash-commands).
Relay mode, channel-ID-change events, App Home, Agent
and Assistant lifecycle events, configured ACP bindings, and runtime
current-conversation bindings remain unavailable for an enterprise account.
Static agent route bindings are supported when a binding without a peer
specifies `match.teamId`, or a peer ID uses
`team:<team-id>:channel:<channel-id>` or
`team:<team-id>:user:<user-id>`.
Slack-native approvals that originate from a delivered, workspace-qualified
Slack turn are supported; approval buttons use the same listener-owned,
workspace-scoped interaction path. Slack action tools are supported for
enterprise accounts across every group listed in
[Actions and gates](/channels/slack/access-control#actions-and-gates); the configured
`channels.slack.actions.*` gates and OAuth scopes still apply. Inbound
membership, reaction, pin, channel-created, and channel-renamed notifications
use validated listener-owned, workspace-scoped event routing. Outbound
acknowledgment, typing, and status reactions are also supported through that
client and require `reactions:write`.

OpenClaw records Enterprise Grid destinations as
`team:<team-id>:channel:<channel-id>` or `team:<team-id>:user:<user-id>`.
Current-conversation Slack tool actions inherit that workspace. Heartbeat owner
routing can resolve a bare user ID by verifying the recipient's membership against
the sending bot's installed workspaces, then selecting one shared workspace.
An explicit workspace-qualified owner target is preserved. If that verification
fails, the detached-send guard remains in effect. Other detached or
proactive calls must provide a workspace-qualified target; bare channel and
user IDs fail closed because those IDs can be reused by different workspaces.
Actions without a destination parameter, such as `member-info` and
`emoji-list`, require trusted current Slack conversation context.

Immediate replies reuse the standard Slack delivery behavior for chunks,
media, metadata, identity fallback, unfurls, and receipts, but only while the
validated listener-owned client remains in the active event turn. The
in-memory send queue and thread-participation records are partitioned by that
event's workspace; the client itself is never serialized or persisted.

Enterprise channel policy keys must use
`team:<team-id>:channel:<channel-id>` or the `"*"` wildcard.
`dm.groupChannels` requires the workspace-qualified form and does not accept
`"*"`. A delivered Enterprise event never falls back from its qualified
workspace and channel identity to a bare channel ID. Workspace installations
retain raw stable channel IDs and `channel:<id>` compatibility. The channel
prefixes `slack:`, `group:`, and `mpim:` fail startup.

Enterprise user policy entries in `allowFrom`, `reactionAllowlist`, and
per-channel `users` accept raw stable Slack user IDs, `slack:<user-id>`,
`user:<user-id>`, `team:<team-id>:user:<user-id>`, or `"*"`. Unqualified
entries compare only the user ID and can match an org-wide user in any
workspace. Qualified entries compare both the workspace and user ID.
Enterprise `toolsBySender` keys accept raw stable user IDs, `id:<user-id>`,
`channel:slack:<user-id>`, or `"*"`. Names, slugs, display names, and email
addresses fail startup. IDs must use Slack's canonical uppercase prefix and body
(for example, `C0123456789` or `U0123456789`); lowercase and short lookalikes
fail startup. Enterprise accounts cannot enable
`dangerouslyAllowNameMatching`. Enterprise accounts may set the global
`mentionPatterns.mode`. Enterprise `mentionPatterns.allowIn` and
`mentionPatterns.denyIn` entries use
`team:<team-id>:channel:<channel-id>`; bare channel IDs fail startup because
they can be reused across workspaces. Workspace installs retain the existing
bare-channel scoped mention-pattern behavior. Each accepted workspace
gets separate routing, session, transcript, dedupe, history, and cache identity
even when Slack IDs overlap. Within the `message` stream, ordinary user messages
and user-authored `file_share` events are supported; other message subtypes are
rejected before authorization or system-event handling.

Enterprise DMs support the same `disabled`, `open`, `allowlist`, and `pairing`
policies as workspace installs. Pairing approvals are stored as
`team:<team-id>:user:<user-id>` and are applied only to events from that
workspace. Explicit account `allowFrom` entries can omit the workspace for an
org-wide user ID or include it to limit access to one workspace; channel and
sender policy continues to apply to channel messages.
