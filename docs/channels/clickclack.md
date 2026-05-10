---
summary: "ClickClack bot-token channel setup and target syntax"
read_when:
  - Connecting OpenClaw to a ClickClack workspace
  - Testing ClickClack bot identities
title: "ClickClack"
---

ClickClack connects OpenClaw to a self-hosted ClickClack workspace through first-class ClickClack bot tokens.

Use this when you want an OpenClaw agent to appear as a ClickClack bot user. ClickClack supports independent service bots and user-owned bots; user-owned bots keep an `owner_user_id` and receive only the token scopes you grant.

## Quick setup

Create a bot token in ClickClack:

```bash
clickclack admin bot create \
  --workspace <workspace_id_or_slug> \
  --name "OpenClaw" \
  --handle openclaw \
  --scopes bot:write \
  --plain
```

For a user-owned bot, add `--owner <user_id>`.

Configure OpenClaw:

```json5
{
  plugins: {
    entries: {
      clickclack: {
        llm: {
          allowAgentIdOverride: true,
        },
      },
    },
  },
  channels: {
    clickclack: {
      enabled: true,
      baseUrl: "https://app.clickclack.chat",
      token: { source: "env", provider: "default", id: "CLICKCLACK_BOT_TOKEN" },
      workspace: "default",
      defaultTo: "channel:general",
      agentId: "clickclack-bot",
      replyMode: "model",
    },
  },
}
```

Then run:

```bash
export CLICKCLACK_BOT_TOKEN="ccb_..."
openclaw gateway
```

## Multiple bots

Each account opens its own ClickClack realtime connection and uses its own bot token.

```json5
{
  plugins: {
    entries: {
      clickclack: {
        llm: {
          allowAgentIdOverride: true,
        },
      },
    },
  },
  channels: {
    clickclack: {
      enabled: true,
      baseUrl: "https://app.clickclack.chat",
      defaultAccount: "service",
      accounts: {
        service: {
          token: { source: "env", provider: "default", id: "CLICKCLACK_SERVICE_BOT_TOKEN" },
          workspace: "default",
          defaultTo: "channel:general",
          agentId: "service-bot",
          replyMode: "model",
        },
        peter: {
          token: { source: "env", provider: "default", id: "CLICKCLACK_PETER_BOT_TOKEN" },
          workspace: "default",
          defaultTo: "dm:usr_...",
          agentId: "peter-bot",
          replyMode: "model",
        },
      },
    },
  },
}
```

`replyMode: "model"` uses `api.runtime.llm.complete` directly for short bot replies.
When an account sets `agentId`, OpenClaw requires the explicit
`plugins.entries.clickclack.llm.allowAgentIdOverride` trust bit so the plugin
can run completions for that bot agent. Keep it off if you only use the default
agent route.

## Targets

- `channel:<name-or-id>` sends to a workspace channel. Bare targets default to `channel:`.
- `dm:<user_id>` creates or reuses a direct conversation with that user.
- `thread:<message_id>` replies in an existing thread.

Examples:

```bash
openclaw message send --channel clickclack --target channel:general --message "hello"
openclaw message send --channel clickclack --target dm:usr_123 --message "hello"
openclaw message send --channel clickclack --target thread:msg_123 --message "following up"
```

## Permissions

ClickClack token scopes are enforced by the ClickClack API.

- `bot:read`: read workspace/channel/message/thread/DM/realtime/profile data.
- `bot:write`: `bot:read` plus channel messages, thread replies, DMs, and uploads.
- `bot:admin`: `bot:write` plus channel creation.

OpenClaw only needs `bot:write` for normal agent chat.

## Troubleshooting

- `ClickClack is not configured`: set `channels.clickclack.token` or `CLICKCLACK_BOT_TOKEN`.
- `workspace not found`: set `workspace` to the workspace id or slug returned by ClickClack.
- No inbound replies: confirm the token has realtime read access and the bot is not replying to its own messages.
- Channel sends fail: verify the bot is a member of the workspace and has `bot:write`.
