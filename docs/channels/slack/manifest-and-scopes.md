---
summary: "Base app manifest, OAuth scopes, and optional manifest settings"
read_when:
  - Deciding which OAuth scopes a Slack app needs
  - Registering native slash commands in the Slack app
  - Enabling App Home or Agent View on an existing app
title: "Slack manifest and scopes"
sidebarTitle: "Manifest and scopes"
---

The Slack app manifest OpenClaw expects, scope by scope, plus the optional settings that extend it.

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

### Additional manifest settings

Surface different features that extend the above defaults.

The default manifest enables the Slack App Home **Home** tab and subscribes to `app_home_opened`. When a workspace member opens the Home tab, OpenClaw publishes a safe default Home view with `views.publish`; no conversation payload or private configuration is included. When single slash command mode is enabled, the command hint uses `channels.slack.slashCommand.name`; installations using native commands or no slash commands omit that hint. The **Messages** tab remains enabled for Slack DMs. New apps use Slack Agent View through `features.agent_view`, `assistant:write`, and `app_context_changed`. See [Agent View DMs](/channels/slack/threads-and-sessions#agent-view-dms) for how OpenClaw detects the experience and routes each visible root to its own session.

OpenClaw drives Slack session status: `processing` while a turn runs, `suspended` while a native approval waits, and `active` when done. The native **Stop** button requires the `agent_session_stopped` event subscription and aborts the run like `/stop`, with the same authorization checks. Session titles follow the OpenClaw session display name; the `agent_session_title_changed` subscription lets user renames flow back to OpenClaw.

Existing apps that already use `features.assistant_view` can keep that feature setting. OpenClaw continues to handle `assistant_thread_started` and `assistant_thread_context_changed` for those installs; add the same session event subscriptions for Stop and title synchronization. Slack makes migration from Assistant View to Agent View irreversible and requires users to hard refresh afterward, so do not replace `assistant_view` on an existing app until you intend to migrate the whole workspace.

<AccordionGroup>
  <Accordion title="Optional native slash commands">

    Multiple [native slash commands](/channels/slack/messaging#commands-and-slash-behavior) can be used instead of a single configured command with nuance:

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
