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

In ClickClack, open **Workspace settings → Integrations → OpenClaw**, create a
bot, and copy its token. Then configure the channel:

```bash
openclaw channels add clickclack --base-url https://clickclack.example.com --token ccb_... --workspace default
```

`workspace` accepts a workspace id (`wsp_...`), slug, or display name.
`channels add` verifies the server, token, and workspace after saving, then
reports whether the running gateway picked up the new account. If OpenClaw is
already running, ClickClack connects automatically and no second command is
needed. Otherwise, start it with:

```bash
openclaw gateway
```

For guided setup, run:

```bash
openclaw onboard
```

Select ClickClack, then enter the server URL, bot token, and workspace when
prompted. Guided setup checks the server, token, and workspace after saving; a
failed check does not discard the configuration.

### Alternative: env-based token

The default account can read `CLICKCLACK_BOT_TOKEN` instead of storing a token
in config:

```bash
export CLICKCLACK_BOT_TOKEN="ccb_..."
openclaw channels add clickclack --base-url https://clickclack.example.com --workspace default --use-env
openclaw gateway
```

Named accounts must use a configured token or token file; the shared env
variable is intentionally limited to the default account.

### JSON5 reference

The equivalent config shape is:

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

An account counts as configured only when `baseUrl`, a token source, and
`workspace` are all set. A token source can be `token`, `tokenFile`, or
`CLICKCLACK_BOT_TOKEN` for the default account. `workspace` accepts a workspace
id (`wsp_...`), slug, or name; the gateway resolves it to the id at startup.

### Account config keys

| Key                     | Default             | Notes                                                                                   |
| ----------------------- | ------------------- | --------------------------------------------------------------------------------------- |
| `baseUrl`               | none (required)     | ClickClack server URL.                                                                  |
| `token`                 | none                | Bot token as a plain string or secret ref (`source: "env" \| "file" \| "exec"`).        |
| `tokenFile`             | none                | Path to a bot-token file; takes precedence over `token`.                                |
| `workspace`             | none (required)     | Workspace id, slug, or name.                                                            |
| `replyMode`             | `"agent"`           | `"agent"` runs the full agent pipeline; `"model"` sends short direct model completions. |
| `defaultTo`             | `"channel:general"` | Target used when an outbound path gives no target.                                      |
| `allowFrom`             | `["*"]`             | User-id allowlist for inbound DMs and channel messages.                                 |
| `botUserId`             | auto-detected       | Resolved from the bot token identity at startup.                                        |
| `agentId`               | route default       | Pin this account's inbound messages to one agent.                                       |
| `toolsAllow`            | none                | Tool allowlist for agent replies from this account.                                     |
| `model`, `systemPrompt` | none                | Used by `replyMode: "model"` completions.                                               |
| `commandMenu`           | `true`              | Publish native commands to ClickClack composer autocomplete.                            |
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
- `replyMode: "model"` skips the agent pipeline and uses the plugin runtime's `llm.complete` for direct bot replies, optionally shaped by `model` and `systemPrompt`. The selected provider and model own the completion budget.

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

## Command menu

At gateway startup, each configured account publishes OpenClaw's native
commands to ClickClack. They appear in composer autocomplete labeled with the
bot's handle. The published set is replaced wholesale on each startup,
including clearing a stale menu when the native command catalog is empty.

Command-menu sync is enabled by default. Set `commandMenu: false` on an account
to opt out:

```json5
{
  channels: {
    clickclack: {
      enabled: true,
      token: { source: "env", provider: "default", id: "CLICKCLACK_BOT_TOKEN" },
      workspace: "default",
      commandMenu: false,
    },
  },
}
```

The token needs `commands:write`. Current ClickClack `bot:write` and
`bot:admin` bundles include that scope, and it can also be granted
individually. Tokens created before command menus were introduced may need the
scope added or a replacement token.

Sync is best effort and runs once per gateway start. A missing scope or network
failure logs a warning; an older ClickClack server without the endpoint logs at
debug level. None of these failures block realtime startup. Menus remain
available while the agent is offline and are removed when the bot leaves the
workspace.

This release publishes native command specs only. Aliases and
skill-, plugin-, or custom-command catalogs are not added to the menu. If a
name is also registered as an HTTP slash command, ClickClack dispatches that
registration first; other menu commands continue through normal message
delivery.

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

## Durable media delivery

Agent replies containing media use required durable delivery. OpenClaw assigns
stable per-part message and upload nonces before the first ClickClack write, so
a retry reuses the same upload and message instead of consuming storage quota
or publishing duplicates. If an upload already exists after a restart,
OpenClaw does not reread the original local path or remote media URL.

This recovery contract requires a ClickClack server that supports:

- `GET /api/uploads/by-nonce` with
  `X-ClickClack-Upload-Nonce: supported` on found and missing results.
- `GET /api/messages/by-nonce` with
  `X-ClickClack-Message-Nonce: supported` on found and missing results.
- Idempotent message creation and attachment association for the same
  owner-scoped nonce and upload.

An older server's generic 404 is not treated as proof that a send is absent.
OpenClaw leaves the delivery unresolved rather than risking a duplicate; update
ClickClack before enabling media-producing agent replies.

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

Outbound media uses ClickClack's upload API and then attaches the durable upload
to the created channel message, thread reply, or DM. Local files and supported
remote media URLs follow OpenClaw's normal media-access policy, with a 64 MiB
per-file limit. Durable queued sends use separate owner-scoped nonces for each
upload and message part, then retry attachment association with those same
objects. See [Durable media delivery](#durable-media-delivery) for the server
contract and recovery behavior.

Examples:

```bash
openclaw message send --channel clickclack --target channel:general --message "hello"
openclaw message send --channel clickclack --target dm:usr_123 --message "hello"
openclaw message send --channel clickclack --target thread:msg_123 --message "following up"
```

## Permissions

ClickClack token scopes are enforced by the ClickClack API.

- `bot:read`: read workspace/channel/message/thread/DM/realtime/profile data.
- `bot:write`: `bot:read` plus channel messages, thread replies, DMs, uploads, and command-menu publishing.
- `bot:admin`: `bot:write` plus channel creation.
- `commands:write`: publish the bot's command menu. Included in current `bot:write` and `bot:admin` bundles and grantable individually.
- `agent_activity:write`: durable agent activity rows (`agent_commentary` / `agent_tool`). Not inherited by `bot:write` or `bot:admin`; required only when `agentActivity: true` is set.

OpenClaw only needs current `bot:write` for normal agent chat and command-menu sync. Add `agent_activity:write` when enabling [agent activity rows](#agent-activity-rows).

## Troubleshooting

- `ClickClack is not configured for account "<id>"`: set `baseUrl`, `token` (for example via `CLICKCLACK_BOT_TOKEN`), and `workspace` for that account.
- `ClickClack workspace not found: <value>`: set `workspace` to the workspace id, slug, or name returned by ClickClack.
- No inbound replies: confirm the token has realtime read access and note that the bot ignores its own messages and messages from other bots.
- Channel sends fail: verify the bot is a member of the workspace and has `bot:write`.
- No command menu: confirm `commandMenu` is not `false`, the ClickClack server supports `PUT /api/bots/self/commands`, and the token has `commands:write`.
