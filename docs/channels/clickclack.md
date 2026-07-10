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

Create a bot token on the ClickClack server:

```bash
clickclack admin bot create \
  --workspace <workspace_id> \
  --name "OpenClaw" \
  --handle openclaw \
  --scopes bot:write \
  --plain
```

For a user-owned bot, add `--owner <user_id>`.

Configure OpenClaw:

```json5
{
  channels: {
    clickclack: {
      enabled: true,
      baseUrl: "https://clickclack.example.com",
      token: { source: "env", provider: "default", id: "CLICKCLACK_BOT_TOKEN" },
      workspace: "default",
      defaultTo: "channel:general",
    },
  },
}
```

Then run:

```bash
export CLICKCLACK_BOT_TOKEN="ccb_..."
openclaw gateway
```

An account counts as configured only when `baseUrl`, `token`, and `workspace` are all set. `workspace` accepts a workspace id (`wsp_...`), slug, or name; the gateway resolves it to the id at startup.

### Account config keys

| Key                     | Default             | Notes                                                                                   |
| ----------------------- | ------------------- | --------------------------------------------------------------------------------------- |
| `baseUrl`               | none (required)     | ClickClack server URL.                                                                  |
| `token`                 | none (required)     | Plain string or secret ref (`source: "env" \| "file" \| "exec"`).                       |
| `workspace`             | none (required)     | Workspace id, slug, or name.                                                            |
| `replyMode`             | `"agent"`           | `"agent"` runs the full agent pipeline; `"model"` sends short direct model completions. |
| `defaultTo`             | `"channel:general"` | Target used when an outbound path gives no target.                                      |
| `allowFrom`             | `["*"]`             | User-id allowlist for inbound DMs and channel messages.                                 |
| `botUserId`             | auto-detected       | Resolved from the bot token identity at startup.                                        |
| `agentId`               | route default       | Pin this account's inbound messages to one agent.                                       |
| `toolsAllow`            | none                | Tool allowlist for agent replies from this account.                                     |
| `model`, `systemPrompt` | none                | Used by `replyMode: "model"` completions.                                               |
| `reconnectMs`           | `1500`              | Realtime reconnect delay (100 to 60000).                                                |

If `plugins.allow` is a non-empty restrictive list, explicitly selecting
ClickClack in channel setup or running `openclaw plugins enable clickclack`
appends `clickclack` to that list. Onboarding installation uses the same
explicit-selection behavior. These paths do not override `plugins.deny` or a
global `plugins.enabled: false` setting. Direct
`openclaw plugins install @openclaw/clickclack` follows the normal
plugin-install policy and also records ClickClack in an existing allowlist.

## Multiple bots

Each account opens its own ClickClack realtime connection and uses its own bot token.

```json5
{
  channels: {
    clickclack: {
      enabled: true,
      baseUrl: "https://clickclack.example.com",
      defaultAccount: "service",
      accounts: {
        service: {
          token: { source: "env", provider: "default", id: "CLICKCLACK_SERVICE_BOT_TOKEN" },
          workspace: "default",
          defaultTo: "channel:general",
          agentId: "service-bot",
        },
        support: {
          token: { source: "env", provider: "default", id: "CLICKCLACK_SUPPORT_BOT_TOKEN" },
          workspace: "default",
          defaultTo: "dm:usr_...",
          agentId: "support-bot",
        },
      },
    },
  },
}
```

## Reply modes

- `replyMode: "agent"` (default) dispatches inbound messages through the normal agent pipeline, including session recording and tool policy.
- `replyMode: "model"` skips the agent pipeline and uses the plugin runtime's `llm.complete` for short direct bot replies (optionally shaped by `model` and `systemPrompt`).

Model mode runs completions against the resolved bot agent id, which requires
the explicit `plugins.entries.clickclack.llm.allowAgentIdOverride: true` trust
bit:

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
}
```

Keep the trust bit off if you only use the default `agent` reply mode; it is
not needed there.

Use `agent` mode for cross-service correlation evidence. For an authoritative
ClickClack message id in its canonical `msg_<ulid>` shape, the channel derives
the deterministic OpenClaw run id `clickclack:<message-id>`. Each model call is
then visible in diagnostics as `clickclack:<message-id>:model:<n>`; when that
turn uses ClawRouter, the same model-call id is sent as `X-Request-ID`.
`model` mode bypasses the normal agent run/session diagnostics and is therefore
not suitable for this evidence path.

When a realtime event contains a validated `payload.correlation_id`, the
channel carries it as `X-Correlation-ID` on the authoritative message fetch and
the resulting ClickClack reply requests. Values use ClickClack's safe
128-character set (`A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, and `-`); invalid values
are omitted. These joins contain identifiers only, never message bodies,
prompts, completions, credentials, or tool output.

## Agent activity rows

By default a ClickClack channel shows nothing while an agent turn runs; only the final reply lands. Set `agentActivity: true` on an account to publish durable `agent_commentary` and `agent_tool` message rows while the turn is in progress:

```json5
{
  channels: {
    clickclack: {
      enabled: true,
      token: { source: "env", provider: "default", id: "CLICKCLACK_BOT_TOKEN" },
      workspace: "default",
      agentActivity: true,
    },
  },
}
```

Requirements and behavior:

- **Off by default.** Stock setups and older ClickClack servers are untouched.
- **Requires the `agent_activity:write` token scope.** This scope is separate from `bot:write` and is not inherited by it; create the bot token with `--scopes bot:write,agent_activity:write` (or grant the scope to an existing token) before enabling the option.
- **Best-effort degradation.** If the token lacks `agent_activity:write` or the server rejects activity writes, failures are logged and the final reply still delivers normally; no activity rows appear.
- Rows are grouped per turn (`turn_id`), coalesced so one logical step is one row, and tool rows use the same progress formatting as Discord/Slack/Telegram (tool name plus command detail).
- **Attribution metadata.** Agent-authored posts (activity rows and the final reply) carry `author_model` and `author_thinking` fields resolved from the actual model used for the turn (including after fallback). Servers that do not define these columns ignore the unknown JSON fields; servers that persist them can answer "which model said this line, at which thinking level" per message.

## Targets

- `channel:<name-or-id>` sends to a workspace channel. Bare targets default to `channel:`.
- `dm:<user_id>` creates or reuses a direct conversation with that user.
- `thread:<message_id>` replies in the thread rooted at that message.

Explicit outbound targets may also carry the `clickclack:` or `cc:` provider prefix.

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
- `agent_activity:write`: durable agent activity rows (`agent_commentary` / `agent_tool`). Not inherited by `bot:write` or `bot:admin`; required only when `agentActivity: true` is set.

OpenClaw only needs `bot:write` for normal agent chat. Add `agent_activity:write` when enabling [agent activity rows](#agent-activity-rows).

## Troubleshooting

- `ClickClack is not configured for account "<id>"`: set `baseUrl`, `token` (for example via `CLICKCLACK_BOT_TOKEN`), and `workspace` for that account.
- `ClickClack workspace not found: <value>`: set `workspace` to the workspace id, slug, or name returned by ClickClack.
- No inbound replies: confirm the token has realtime read access and note that the bot ignores its own messages and messages from other bots.
- Channel sends fail: verify the bot is a member of the workspace and has `bot:write`.
