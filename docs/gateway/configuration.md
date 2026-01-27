---
summary: "All configuration options for ~/.clawdbot/moltbot.json with examples"
read_when:
  - Adding or modifying config fields
---
# Configuration 🔧

Moltbot reads an optional **JSON5** config from `~/.clawdbot/moltbot.json` (comments + trailing commas allowed).

If the file is missing, Moltbot uses safe-ish defaults (embedded Pi agent + per-sender sessions + workspace `~/clawd`). You usually only need a config to:
- restrict who can trigger the bot (`channels.whatsapp.allowFrom`, `channels.telegram.allowFrom`, etc.)
- control group allowlists + mention behavior (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.discord.guilds`, `agents.list[].groupChat`)
- customize message prefixes (`messages`)
- set the agent's workspace (`agents.defaults.workspace` or `agents.list[].workspace`)
- tune the embedded agent defaults (`agents.defaults`) and session behavior (`session`)
- set per-agent identity (`agents.list[].identity`)

> **New to configuration?** Check out the [Configuration Examples](/gateway/configuration-examples) guide for complete examples with detailed explanations!

## Strict config validation

Moltbot only accepts configurations that fully match the schema.
Unknown keys, malformed types, or invalid values cause the Gateway to **refuse to start** for safety.

When validation fails:
- The Gateway does not boot.
- Only diagnostic commands are allowed (for example: `moltbot doctor`, `moltbot logs`, `moltbot health`, `moltbot status`, `moltbot service`, `moltbot help`).
- Run `moltbot doctor` to see the exact issues.
- Run `moltbot doctor --fix` (or `--yes`) to apply migrations/repairs.

Doctor never writes changes unless you explicitly opt into `--fix`/`--yes`.

## Schema + UI hints

The Gateway exposes a JSON Schema representation of the config via `config.schema` for UI editors.
The Control UI renders a form from this schema, with a **Raw JSON** editor as an escape hatch.

Channel plugins and extensions can register schema + UI hints for their config, so channel settings
stay schema-driven across apps without hard-coded forms.

Hints (labels, grouping, sensitive fields) ship alongside the schema so clients can render
better forms without hard-coding config knowledge.

## Apply + restart (RPC)

Use `config.apply` to validate + write the full config and restart the Gateway in one step.
It writes a restart sentinel and pings the last active session after the Gateway comes back.

Warning: `config.apply` replaces the **entire config**. If you want to change only a few keys,
use `config.patch` or `moltbot config set`. Keep a backup of `~/.clawdbot/moltbot.json`.

Params:
- `raw` (string) — JSON5 payload for the entire config
- `baseHash` (optional) — config hash from `config.get` (required when a config already exists)
- `sessionKey` (optional) — last active session key for the wake-up ping
- `note` (optional) — note to include in the restart sentinel
- `restartDelayMs` (optional) — delay before restart (default 2000)

Example (via `gateway call`):

```bash
moltbot gateway call config.get --params '{}' # capture payload.hash
moltbot gateway call config.apply --params '{
  "raw": "{\\n  agents: { defaults: { workspace: \\"~/clawd\\" } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## Partial updates (RPC)

Use `config.patch` to merge a partial update into the existing config without clobbering
unrelated keys. It applies JSON merge patch semantics:
- objects merge recursively
- `null` deletes a key
- arrays replace
Like `config.apply`, it validates, writes the config, stores a restart sentinel, and schedules
the Gateway restart (with an optional wake when `sessionKey` is provided).

Params:
- `raw` (string) — JSON5 payload containing just the keys to change
- `baseHash` (required) — config hash from `config.get`
- `sessionKey` (optional) — last active session key for the wake-up ping
- `note` (optional) — note to include in the restart sentinel
- `restartDelayMs` (optional) — delay before restart (default 2000)

Example:

```bash
moltbot gateway call config.get --params '{}' # capture payload.hash
moltbot gateway call config.patch --params '{
  "raw": "{\\n  channels: { telegram: { groups: { \\"*\\": { requireMention: false } } } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## Minimal config (recommended starting point)

```json5
{
  agents: { defaults: { workspace: "~/clawd" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } }
}
```

Build the default image once with:
```bash
scripts/sandbox-setup.sh
```

## Self-chat mode (recommended for group control)

To prevent the bot from responding to WhatsApp @-mentions in groups (only respond to specific text triggers):

```json5
{
  agents: {
    defaults: { workspace: "~/clawd" },
    list: [
      {
        id: "main",
        groupChat: { mentionPatterns: ["@clawd", "reisponde"] }
      }
    ]
  },
  channels: {
    whatsapp: {
      // Allowlist is DMs only; including your own number enables self-chat mode.
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } }
    }
  }
}
```

## Config Includes (`$include`)

Split your config into multiple files using the `$include` directive. This is useful for:
- Organizing large configs (e.g., per-client agent definitions)
- Sharing common settings across environments
- Keeping sensitive configs separate

### Basic usage

```json5
// ~/.clawdbot/moltbot.json
{
  gateway: { port: 18789 },
  
  // Include a single file (replaces the key's value)
  agents: { "$include": "./agents.json5" },
  
  // Include multiple files (deep-merged in order)
  broadcast: { 
    "$include": [
      "./clients/mueller.json5",
      "./clients/schmidt.json5"
    ]
  }
}
```

```json5
// ~/.clawdbot/agents.json5
{
  defaults: { sandbox: { mode: "all", scope: "session" } },
  list: [
    { id: "main", workspace: "~/clawd" }
  ]
}
```

### Merge behavior

- **Single file**: Replaces the object containing `$include`
- **Array of files**: Deep-merges files in order (later files override earlier ones)
- **With sibling keys**: Sibling keys are merged after includes (override included values)
- **Sibling keys + arrays/primitives**: Not supported (included content must be an object)

```json5
// Sibling keys override included values
{
  "$include": "./base.json5",   // { a: 1, b: 2 }
  b: 99                          // Result: { a: 1, b: 99 }
}
```

### Nested includes

Included files can themselves contain `$include` directives (up to 10 levels deep):

```json5
// clients/mueller.json5
{
  agents: { "$include": "./mueller/agents.json5" },
  broadcast: { "$include": "./mueller/broadcast.json5" }
}
```

### Path resolution

- **Relative paths**: Resolved relative to the including file
- **Absolute paths**: Used as-is
- **Parent directories**: `../` references work as expected

```json5
{ "$include": "./sub/config.json5" }      // relative
{ "$include": "/etc/moltbot/base.json5" } // absolute
{ "$include": "../shared/common.json5" }   // parent dir
```

### Error handling

- **Missing file**: Clear error with resolved path
- **Parse error**: Shows which included file failed
- **Circular includes**: Detected and reported with include chain

### Example: Multi-client legal setup

```json5
// ~/.clawdbot/moltbot.json
{
  gateway: { port: 18789, auth: { token: "secret" } },
  
  // Common agent defaults
  agents: {
    defaults: {
      sandbox: { mode: "all", scope: "session" }
    },
    // Merge agent lists from all clients
    list: { "$include": [
      "./clients/mueller/agents.json5",
      "./clients/schmidt/agents.json5"
    ]}
  },
  
  // Merge broadcast configs
  broadcast: { "$include": [
    "./clients/mueller/broadcast.json5",
    "./clients/schmidt/broadcast.json5"
  ]},
  
  channels: { whatsapp: { groupPolicy: "allowlist" } }
}
```

```json5
// ~/.clawdbot/clients/mueller/agents.json5
[
  { id: "mueller-transcribe", workspace: "~/clients/mueller/transcribe" },
  { id: "mueller-docs", workspace: "~/clients/mueller/docs" }
]
```

```json5
// ~/.clawdbot/clients/mueller/broadcast.json5
{
  "120363403215116621@g.us": ["mueller-transcribe", "mueller-docs"]
}
```

## Common options

### Env vars + `.env`

Moltbot reads env vars from the parent process (shell, launchd/systemd, CI, etc.).

Additionally, it loads:
- `.env` from the current working directory (if present)
- a global fallback `.env` from `~/.clawdbot/.env` (aka `$CLAWDBOT_STATE_DIR/.env`)

Neither `.env` file overrides existing env vars.

You can also provide inline env vars in config. These are only applied if the
process env is missing the key (same non-overriding rule):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-..."
    }
  }
}
```

See [/environment](/environment) for full precedence and sources.

### `env.shellEnv` (optional)

Opt-in convenience: if enabled and none of the expected keys are set yet, Moltbot runs your login shell and imports only the missing expected keys (never overrides).
This effectively sources your shell profile.

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000
    }
  }
}
```

Env var equivalent:
- `CLAWDBOT_LOAD_SHELL_ENV=1`
- `CLAWDBOT_SHELL_ENV_TIMEOUT_MS=15000`

### Env var substitution in config

You can reference environment variables directly in any config string value using
`${VAR_NAME}` syntax. Variables are substituted at config load time, before validation.

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}"
      }
    }
  },
  gateway: {
    auth: {
      token: "${CLAWDBOT_GATEWAY_TOKEN}"
    }
  }
}
```

**Rules:**
- Only uppercase env var names are matched: `[A-Z_][A-Z0-9_]*`
- Missing or empty env vars throw an error at config load
- Escape with `$${VAR}` to output a literal `${VAR}`
- Works with `$include` (included files also get substitution)

**Inline substitution:**

```json5
{
  models: {
    providers: {
      custom: {
        baseUrl: "${CUSTOM_API_BASE}/v1"  // → "https://api.example.com/v1"
      }
    }
  }
}
```

### Auth storage (OAuth + API keys)

Moltbot stores **per-agent** auth profiles (OAuth + API keys) in:
- `<agentDir>/auth-profiles.json` (default: `~/.clawdbot/agents/<agentId>/agent/auth-profiles.json`)

See also: [/concepts/oauth](/concepts/oauth)

Legacy OAuth imports:
- `~/.clawdbot/credentials/oauth.json` (or `$CLAWDBOT_STATE_DIR/credentials/oauth.json`)

The embedded Pi agent maintains a runtime cache at:
- `<agentDir>/auth.json` (managed automatically; don’t edit manually)

Legacy agent dir (pre multi-agent):
- `~/.clawdbot/agent/*` (migrated by `moltbot doctor` into `~/.clawdbot/agents/<defaultAgentId>/agent/*`)

Overrides:
- OAuth dir (legacy import only): `CLAWDBOT_OAUTH_DIR`
- Agent dir (default agent root override): `CLAWDBOT_AGENT_DIR` (preferred), `PI_CODING_AGENT_DIR` (legacy)

On first use, Moltbot imports `oauth.json` entries into `auth-profiles.json`.

### `auth`

Optional metadata for auth profiles. This does **not** store secrets; it maps
profile IDs to a provider + mode (and optional email) and defines the provider
rotation order used for failover.

```json5
{
  auth: {
    profiles: {
      "anthropic:me@example.com": { provider: "anthropic", mode: "oauth", email: "me@example.com" },
      "anthropic:work": { provider: "anthropic", mode: "api_key" }
    },
    order: {
      anthropic: ["anthropic:me@example.com", "anthropic:work"]
    }
  }
}
```

### `agents.list[].identity`

Optional per-agent identity used for defaults and UX. This is written by the macOS onboarding assistant.

If set, Moltbot derives defaults (only when you haven’t set them explicitly):
- `messages.ackReaction` from the **active agent**’s `identity.emoji` (falls back to 👀)
- `agents.list[].groupChat.mentionPatterns` from the agent’s `identity.name`/`identity.emoji` (so “@Samantha” works in groups across Telegram/Slack/Discord/Google Chat/iMessage/WhatsApp)
- `identity.avatar` accepts a workspace-relative image path or a remote URL/data URL. Local files must live inside the agent workspace.

`identity.avatar` accepts:
- Workspace-relative path (must stay within the agent workspace)
- `http(s)` URL
- `data:` URI

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "Samantha",
          theme: "helpful sloth",
          emoji: "🦥",
          avatar: "avatars/samantha.png"
        }
      }
    ]
  }
}
```

### `wizard`

Metadata written by CLI wizards (`onboard`, `configure`, `doctor`).

```json5
{
  wizard: {
    lastRunAt: "2026-01-01T00:00:00.000Z",
    lastRunVersion: "2026.1.4",
    lastRunCommit: "abc1234",
    lastRunCommand: "configure",
    lastRunMode: "local"
  }
}
```

### `logging`

- Default log file: `/tmp/moltbot/moltbot-YYYY-MM-DD.log`
- If you want a stable path, set `logging.file` to `/tmp/moltbot/moltbot.log`.
- Console output can be tuned separately via:
  - `logging.consoleLevel` (defaults to `info`, bumps to `debug` when `--verbose`)
  - `logging.consoleStyle` (`pretty` | `compact` | `json`)
- Tool summaries can be redacted to avoid leaking secrets:
  - `logging.redactSensitive` (`off` | `tools`, default: `tools`)
  - `logging.redactPatterns` (array of regex strings; overrides defaults)

```json5
{
  logging: {
    level: "info",
    file: "/tmp/moltbot/moltbot.log",
    consoleLevel: "info",
    consoleStyle: "pretty",
    redactSensitive: "tools",
    redactPatterns: [
      // Example: override defaults with your own rules.
      "\\bTOKEN\\b\\s*[=:]\\s*([\"']?)([^\\s\"']+)\\1",
      "/\\bsk-[A-Za-z0-9_-]{8,}\\b/gi"
    ]
  }
}
```

### `channels.whatsapp.dmPolicy`

Controls how WhatsApp direct chats (DMs) are handled:
- `"pairing"` (default): unknown senders get a pairing code; owner must approve
- `"allowlist"`: only allow senders in `channels.whatsapp.allowFrom` (or paired allow store)
- `"open"`: allow all inbound DMs (**requires** `channels.whatsapp.allowFrom` to include `"*"`)
- `"disabled"`: ignore all inbound DMs

Pairing codes expire after 1 hour; the bot only sends a pairing code when a new request is created. Pending DM pairing requests are capped at **3 per channel** by default.

Pairing approvals:
- `moltbot pairing list whatsapp`
- `moltbot pairing approve whatsapp <code>`

### `channels.whatsapp.allowFrom`

Allowlist of E.164 phone numbers that may trigger WhatsApp auto-replies (**DMs only**).
If empty and `channels.whatsapp.dmPolicy="pairing"`, unknown senders will receive a pairing code.
For groups, use `channels.whatsapp.groupPolicy` + `channels.whatsapp.groupAllowFrom`.

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "+447700900123"],
      textChunkLimit: 4000, // optional outbound chunk size (chars)
      chunkMode: "length", // optional chunking mode (length | newline)
      mediaMaxMb: 50 // optional inbound media cap (MB)
    }
  }
}
```

### `channels.whatsapp.sendReadReceipts`

Controls whether inbound WhatsApp messages are marked as read (blue ticks). Default: `true`.

Self-chat mode always skips read receipts, even when enabled.

Per-account override: `channels.whatsapp.accounts.<id>.sendReadReceipts`.

```json5
{
  channels: {
    whatsapp: { sendReadReceipts: false }
  }
}
```

### `channels.whatsapp.accounts` (multi-account)

Run multiple WhatsApp accounts in one gateway:

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        default: {}, // optional; keeps the default id stable
        personal: {},
        biz: {
          // Optional override. Default: ~/.clawdbot/credentials/whatsapp/biz
          // authDir: "~/.clawdbot/credentials/whatsapp/biz",
        }
      }
    }
  }
}
```

Notes:
- Outbound commands default to account `default` if present; otherwise the first configured account id (sorted).
- The legacy single-account Baileys auth dir is migrated by `moltbot doctor` into `whatsapp/default`.

### `channels.telegram.accounts` / `channels.discord.accounts` / `channels.googlechat.accounts` / `channels.slack.accounts` / `channels.mattermost.accounts` / `channels.signal.accounts` / `channels.imessage.accounts`

Run multiple accounts per channel (each account has its own `accountId` and optional `name`):

```json5
{
  channels: {
    telegram: {
      accounts: {
        default: {
          name: "Primary bot",
          botToken: "123456:ABC..."
        },
        alerts: {
          name: "Alerts bot",
          botToken: "987654:XYZ..."
        }
      }
    }
  }
}
```

Notes:
- `default` is used when `accountId` is omitted (CLI + routing).
- Env tokens only apply to the **default** account.
- Base channel settings (group policy, mention gating, etc.) apply to all accounts unless overridden per account.
- Use `bindings[].match.accountId` to route each account to a different agents.defaults.

### Group chat mention gating (`agents.list[].groupChat` + `messages.groupChat`)

Group messages default to **require mention** (either metadata mention or regex patterns). Applies to WhatsApp, Telegram, Discord, Google Chat, and iMessage group chats.

**Mention types:**
- **Metadata mentions**: Native platform @-mentions (e.g., WhatsApp tap-to-mention). Ignored in WhatsApp self-chat mode (see `channels.whatsapp.allowFrom`).
- **Text patterns**: Regex patterns defined in `agents.list[].groupChat.mentionPatterns`. Always checked regardless of self-chat mode.
- Mention gating is enforced only when mention detection is possible (native mentions or at least one `mentionPattern`).

```json5
{
  messages: {
    groupChat: { historyLimit: 50 }
  },
  agents: {
    list: [
      { id: "main", groupChat: { mentionPatterns: ["@clawd", "moltbot", "clawd"] } }
    ]
  }
}
```

`messages.groupChat.historyLimit` sets the global default for group history context. Channels can override with `channels.<channel>.historyLimit` (or `channels.<channel>.accounts.*.historyLimit` for multi-account). Set `0` to disable history wrapping.

#### DM history limits

DM conversations use session-based history managed by the agent. You can limit the number of user turns retained per DM session:

```json5
{
  channels: {
    telegram: {
      dmHistoryLimit: 30,  // limit DM sessions to 30 user turns
      dms: {
        "123456789": { historyLimit: 50 }  // per-user override (user ID)
      }
    }
  }
}
```

Resolution order:
1. Per-DM override: `channels.<provider>.dms[userId].historyLimit`
2. Provider default: `channels.<provider>.dmHistoryLimit`
3. No limit (all history retained)

Supported providers: `telegram`, `whatsapp`, `discord`, `slack`, `signal`, `imessage`, `msteams`.

Per-agent override (takes precedence when set, even `[]`):
```json5
{
  agents: {
    list: [
      { id: "work", groupChat: { mentionPatterns: ["@workbot", "\\+15555550123"] } },
      { id: "personal", groupChat: { mentionPatterns: ["@homebot", "\\+15555550999"] } }
    ]
  }
}
```

Mention gating defaults live per channel (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.imessage.groups`, `channels.discord.guilds`). When `*.groups` is set, it also acts as a group allowlist; include `"*"` to allow all groups.

To respond **only** to specific text triggers (ignoring native @-mentions):
```json5
{
  channels: {
    whatsapp: {
      // Include your own number to enable self-chat mode (ignore native @-mentions).
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } }
    }
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          // Only these text patterns will trigger responses
          mentionPatterns: ["reisponde", "@clawd"]
        }
      }
    ]
  }
}
```

### Group policy (per channel)

Use `channels.*.groupPolicy` to control whether group/room messages are accepted at all:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"]
    },
    telegram: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["tg:123456789", "@alice"]
    },
    signal: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"]
    },
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["chat_id:123"]
    },
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"]
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        "GUILD_ID": {
          channels: { help: { allow: true } }
        }
      }
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } }
    }
  }
}
```

Notes:
- `"open"`: groups bypass allowlists; mention-gating still applies.
- `"disabled"`: block all group/room messages.
- `"allowlist"`: only allow groups/rooms that match the configured allowlist.
- `channels.defaults.groupPolicy` sets the default when a provider’s `groupPolicy` is unset.
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams use `groupAllowFrom` (fallback: explicit `allowFrom`).
- Discord/Slack use channel allowlists (`channels.discord.guilds.*.channels`, `channels.slack.channels`).
- Group DMs (Discord/Slack) are still controlled by `dm.groupEnabled` + `dm.groupChannels`.
- Default is `groupPolicy: "allowlist"` (unless overridden by `channels.defaults.groupPolicy`); if no allowlist is configured, group messages are blocked.

### Multi-agent routing (`agents.list` + `bindings`)

Run multiple isolated agents (separate workspace, `agentDir`, sessions) inside one Gateway.
Inbound messages are routed to an agent via bindings.

- `agents.list[]`: per-agent overrides.
  - `id`: stable agent id (required).
  - `default`: optional; when multiple are set, the first wins and a warning is logged.
    If none are set, the **first entry** in the list is the default agent.
  - `name`: display name for the agent.
  - `workspace`: default `~/clawd-<agentId>` (for `main`, falls back to `agents.defaults.workspace`).
  - `agentDir`: default `~/.clawdbot/agents/<agentId>/agent`.
  - `model`: per-agent default model, overrides `agents.defaults.model` for that agent.
    - string form: `"provider/model"`, overrides only `agents.defaults.model.primary`
    - object form: `{ primary, fallbacks }` (fallbacks override `agents.defaults.model.fallbacks`; `[]` disables global fallbacks for that agent)
  - `identity`: per-agent name/theme/emoji (used for mention patterns + ack reactions).
  - `groupChat`: per-agent mention-gating (`mentionPatterns`).
  - `sandbox`: per-agent sandbox config (overrides `agents.defaults.sandbox`).
    - `mode`: `"off"` | `"non-main"` | `"all"`
    - `workspaceAccess`: `"none"` | `"ro"` | `"rw"`
    - `scope`: `"session"` | `"agent"` | `"shared"`
    - `workspaceRoot`: custom sandbox workspace root
    - `docker`: per-agent docker overrides (e.g. `image`, `network`, `env`, `setupCommand`, limits; ignored when `scope: "shared"`)
    - `browser`: per-agent sandboxed browser overrides (ignored when `scope: "shared"`)
    - `prune`: per-agent sandbox pruning overrides (ignored when `scope: "shared"`)
  - `subagents`: per-agent sub-agent defaults.
    - `allowAgents`: allowlist of agent ids for `sessions_spawn` from this agent (`["*"]` = allow any; default: only same agent)
  - `tools`: per-agent tool restrictions (applied before sandbox tool policy).
    - `profile`: base tool profile (applied before allow/deny)
    - `allow`: array of allowed tool names
    - `deny`: array of denied tool names (deny wins)
- `agents.defaults`: shared agent defaults (model, workspace, sandbox, etc.).
- `bindings[]`: routes inbound messages to an `agentId`.
  - `match.channel` (required)
  - `match.accountId` (optional; `*` = any account; omitted = default account)
  - `match.peer` (optional; `{ kind: dm|group|channel, id }`)
  - `match.guildId` / `match.teamId` (optional; channel-specific)

Deterministic match order:
1) `match.peer`
2) `match.guildId`
3) `match.teamId`
4) `match.accountId` (exact, no peer/guild/team)
5) `match.accountId: "*"` (channel-wide, no peer/guild/team)
6) default agent (`agents.list[].default`, else first list entry, else `"main"`)

Within each match tier, the first matching entry in `bindings` wins.

#### Per-agent access profiles (multi-agent)

Each agent can carry its own sandbox + tool policy. Use this to mix access
levels in one gateway:
- **Full access** (personal agent)
- **Read-only** tools + workspace
- **No filesystem access** (messaging/session tools only)

See [Multi-Agent Sandbox & Tools](/multi-agent-sandbox-tools) for precedence and
additional examples.

Full access (no sandbox):
```json5
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/clawd-personal",
        sandbox: { mode: "off" }
      }
    ]
  }
}
```

Read-only tools + read-only workspace:
```json5
{
  agents: {
    list: [
      {
        id: "family",
        workspace: "~/clawd-family",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "ro"
        },
        tools: {
          allow: ["read", "sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "session_status"],
          deny: ["write", "edit", "apply_patch", "exec", "process", "browser"]
        }
      }
    ]
  }
}
```

No filesystem access (messaging/session tools enabled):
```json5
{
  agents: {
    list: [
      {
        id: "public",
        workspace: "~/clawd-public",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "none"
        },
        tools: {
          allow: ["sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "session_status", "whatsapp", "telegram", "slack", "discord", "gateway"],
          deny: ["read", "write", "edit", "apply_patch", "exec", "process", "browser", "canvas", "nodes", "cron", "gateway", "image"]
        }
      }
    ]
  }
}
```

Example: two WhatsApp accounts → two agents:

```json5
{
  agents: {
    list: [
      { id: "home", default: true, workspace: "~/clawd-home" },
      { id: "work", workspace: "~/clawd-work" }
    ]
  },
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } }
  ],
  channels: {
    whatsapp: {
      accounts: {
        personal: {},
        biz: {},
      }
    }
  }
}
```

### `tools.agentToAgent` (optional)

Agent-to-agent messaging is opt-in:

```json5
{
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"]
    }
  }
}
```

### `messages.queue`

Controls how inbound messages behave when an agent run is already active.

```json5
{
  messages: {
    queue: {
      mode: "collect", // steer | followup | collect | steer-backlog (steer+backlog ok) | interrupt (queue=steer legacy)
      debounceMs: 1000,
      cap: 20,
      drop: "summarize", // old | new | summarize
      byChannel: {
        whatsapp: "collect",
        telegram: "collect",
        discord: "collect",
        imessage: "collect",
        webchat: "collect"
      }
    }
  }
}
```

### `messages.inbound`

Debounce rapid inbound messages from the **same sender** so multiple back-to-back
messages become a single agent turn. Debouncing is scoped per channel + conversation
and uses the most recent message for reply threading/IDs.

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000, // 0 disables
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500
      }
    }
  }
}
```

Notes:
- Debounce batches **text-only** messages; media/attachments flush immediately.
- Control commands (e.g. `/queue`, `/new`) bypass debouncing so they stay standalone.

### `commands` (chat command handling)

Controls how chat commands are enabled across connectors.

```json5
{
  commands: {
    native: "auto",         // register native commands when supported (auto)
    text: true,             // parse slash commands in chat messages
    bash: false,            // allow ! (alias: /bash) (host-only; requires tools.elevated allowlists)
    bashForegroundMs: 2000, // bash foreground window (0 backgrounds immediately)
    config: false,          // allow /config (writes to disk)
    debug: false,           // allow /debug (runtime-only overrides)
    restart: false,         // allow /restart + gateway restart tool
    useAccessGroups: true   // enforce access-group allowlists/policies for commands
  }
}
```

Notes:
- Text commands must be sent as a **standalone** message and use the leading `/` (no plain-text aliases).
- `commands.text: false` disables parsing chat messages for commands.
- `commands.native: "auto"` (default) turns on native commands for Discord/Telegram and leaves Slack off; unsupported channels stay text-only.
- Set `commands.native: true|false` to force all, or override per channel with `channels.discord.commands.native`, `channels.telegram.commands.native`, `channels.slack.commands.native` (bool or `"auto"`). `false` clears previously registered commands on Discord/Telegram at startup; Slack commands are managed in the Slack app.
- `channels.telegram.customCommands` adds extra Telegram bot menu entries. Names are normalized; conflicts with native commands are ignored.
- `commands.bash: true` enables `! <cmd>` to run host shell commands (`/bash <cmd>` also works as an alias). Requires `tools.elevated.enabled` and allowlisting the sender in `tools.elevated.allowFrom.<channel>`.
- `commands.bashForegroundMs` controls how long bash waits before backgrounding. While a bash job is running, new `! <cmd>` requests are rejected (one at a time).
- `commands.config: true` enables `/config` (reads/writes `moltbot.json`).
- `channels.<provider>.configWrites` gates config mutations initiated by that channel (default: true). This applies to `/config set|unset` plus provider-specific auto-migrations (Telegram supergroup ID changes, Slack channel ID changes).
- `commands.debug: true` enables `/debug` (runtime-only overrides).
- `commands.restart: true` enables `/restart` and the gateway tool restart action.
- `commands.useAccessGroups: false` allows commands to bypass access-group allowlists/policies.
- Slash commands and directives are only honored for **authorized senders**. Authorization is derived from
  channel allowlists/pairing plus `commands.useAccessGroups`.

### `web` (WhatsApp web channel runtime)

WhatsApp runs through the gateway’s web channel (Baileys Web). It starts automatically when a linked session exists.
Set `web.enabled: false` to keep it off by default.

```json5
{
  web: {
    enabled: true,
    heartbeatSeconds: 60,
    reconnect: {
      initialMs: 2000,
      maxMs: 120000,
      factor: 1.4,
      jitter: 0.2,
      maxAttempts: 0
    }
  }
}
```

### `channels.telegram` (bot transport)

Moltbot starts Telegram only when a `channels.telegram` config section exists. The bot token is resolved from `channels.telegram.botToken` (or `channels.telegram.tokenFile`), with `TELEGRAM_BOT_TOKEN` as a fallback for the default account.
Set `channels.telegram.enabled: false` to disable automatic startup.
Multi-account support lives under `channels.telegram.accounts` (see the multi-account section above). Env tokens only apply to the default account.
Set `channels.telegram.configWrites: false` to block Telegram-initiated config writes (including supergroup ID migrations and `/config set|unset`).

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "your-bot-token",
      dmPolicy: "pairing",                 // pairing | allowlist | open | disabled
      allowFrom: ["tg:123456789"],         // optional; "open" requires ["*"]
      groups: {
        "*": { requireMention: true },
        "-1001234567890": {
          allowFrom: ["@admin"],
          systemPrompt: "Keep answers brief.",
          topics: {
            "99": {
              requireMention: false,
              skills: ["search"],
              systemPrompt: "Stay on topic."
            }
          }
        }
      },
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" }
      ],
      historyLimit: 50,                     // include last N group messages as context (0 disables)
      replyToMode: "first",                 // off | first | all
      linkPreview: true,                   // toggle outbound link previews
      streamMode: "partial",               // off | partial | block (draft streaming; separate from block streaming)
      draftChunk: {                        // optional; only for streamMode=block
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph"       // paragraph | newline | sentence
      },
      actions: { reactions: true, sendMessage: true }, // tool action gates (false disables)
      reactionNotifications: "own",   // off | own | all
      mediaMaxMb: 5,
      retry: {                             // outbound retry policy
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1
      },
      network: {                           // transport overrides
        autoSelectFamily: false
      },
      proxy: "socks5://localhost:9050",
      webhookUrl: "https://example.com/telegram-webhook",
      webhookSecret: "secret",
      webhookPath: "/telegram-webhook"
    }
  }
}
```

Draft streaming notes:
- Uses Telegram `sendMessageDraft` (draft bubble, not a real message).
- Requires **private chat topics** (message_thread_id in DMs; bot has topics enabled).
- `/reasoning stream` streams reasoning into the draft, then sends the final answer.
Retry policy defaults and behavior are documented in [Retry policy](/concepts/retry).

### `channels.discord` (bot transport)

Configure the Discord bot by setting the bot token and optional gating:
Multi-account support lives under `channels.discord.accounts` (see the multi-account section above). Env tokens only apply to the default account.

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "your-bot-token",
      mediaMaxMb: 8,                          // clamp inbound media size
      allowBots: false,                       // allow bot-authored messages
      actions: {                              // tool action gates (false disables)
        reactions: true,
        stickers: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        voiceStatus: true,
        events: true,
        moderation: false
      },
      replyToMode: "off",                     // off | first | all
      dm: {
        enabled: true,                        // disable all DMs when false
        policy: "pairing",                    // pairing | allowlist | open | disabled
        allowFrom: ["1234567890", "steipete"], // optional DM allowlist ("open" requires ["*"])
        groupEnabled: false,                 // enable group DMs
        groupChannels: ["clawd-dm"]          // optional group DM allowlist
      },
      guilds: {
        "123456789012345678": {               // guild id (preferred) or slug
          slug: "friends-of-clawd",
          requireMention: false,              // per-guild default
          reactionNotifications: "own",       // off | own | all | allowlist
          users: ["987654321098765432"],      // optional per-guild user allowlist
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["docs"],
              systemPrompt: "Short answers only."
            }
          }
        }
      },
      historyLimit: 20,                       // include last N guild messages as context
      textChunkLimit: 2000,                   // optional outbound text chunk size (chars)
      chunkMode: "length",                    // optional chunking mode (length | newline)
      maxLinesPerMessage: 17,                 // soft max lines per message (Discord UI clipping)
      retry: {                                // outbound retry policy
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1
      }
    }
  }
}
```

Moltbot starts Discord only when a `channels.discord` config section exists. The token is resolved from `channels.discord.token`, with `DISCORD_BOT_TOKEN` as a fallback for the default account (unless `channels.discord.enabled` is `false`). Use `user:<id>` (DM) or `channel:<id>` (guild channel) when specifying delivery targets for cron/CLI commands; bare numeric IDs are ambiguous and rejected.
Guild slugs are lowercase with spaces replaced by `-`; channel keys use the slugged channel name (no leading `#`). Prefer guild ids as keys to avoid rename ambiguity.
Bot-authored messages are ignored by default. Enable with `channels.discord.allowBots` (own messages are still filtered to prevent self-reply loops).
Reaction notification modes:
- `off`: no reaction events.
- `own`: reactions on the bot's own messages (default).
- `all`: all reactions on all messages.
- `allowlist`: reactions from `guilds.<id>.users` on all messages (empty list disables).
Outbound text is chunked by `channels.discord.textChunkLimit` (default 2000). Set `channels.discord.chunkMode="newline"` to split on blank lines (paragraph boundaries) before length chunking. Discord clients can clip very tall messages, so `channels.discord.maxLinesPerMessage` (default 17) splits long multi-line replies even when under 2000 chars.
Retry policy defaults and behavior are documented in [Retry policy](/concepts/retry).

### `channels.googlechat` (Chat API webhook)

Google Chat runs over HTTP webhooks with app-level auth (service account).
Multi-account support lives under `channels.googlechat.accounts` (see the multi-account section above). Env vars only apply to the default account.

```json5
{
  channels: {
    "googlechat": {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url",             // app-url | project-number
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890",        // optional; improves mention detection
      dm: {
        enabled: true,
        policy: "pairing",                // pairing | allowlist | open | disabled
        allowFrom: ["users/1234567890"]   // optional; "open" requires ["*"]
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": { allow: true, requireMention: true }
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20
    }
  }
}
```

Notes:
- Service account JSON can be inline (`serviceAccount`) or file-based (`serviceAccountFile`).
- Env fallbacks for the default account: `GOOGLE_CHAT_SERVICE_ACCOUNT` or `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`.
- `audienceType` + `audience` must match the Chat app’s webhook auth config.
- Use `spaces/<spaceId>` or `users/<userId|email>` when setting delivery targets.

### `channels.slack` (socket mode)

Slack runs in Socket Mode and requires both a bot token and app token:

```json5
{
  channels: {
    slack: {
      enabled: true,
      botToken: "xoxb-...",
      appToken: "xapp-...",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["U123", "U456", "*"], // optional; "open" requires ["*"]
        groupEnabled: false,
        groupChannels: ["G123"]
      },
      channels: {
        C123: { allow: true, requireMention: true, allowBots: false },
        "#general": {
          allow: true,
          requireMention: true,
          allowBots: false,
          users: ["U123"],
          skills: ["docs"],
          systemPrompt: "Short answers only."
        }
      },
      historyLimit: 50,          // include last N channel/group messages as context (0 disables)
      allowBots: false,
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["U123"],
      replyToMode: "off",           // off | first | all
      thread: {
        historyScope: "thread",     // thread | channel
        inheritParent: false
      },
      actions: {
        reactions: true,
        messages: true,
        pins: true,
        memberInfo: true,
        emojiList: true
      },
      slashCommand: {
        enabled: true,
        name: "clawd",
        sessionPrefix: "slack:slash",
        ephemeral: true
      },
      textChunkLimit: 4000,
      chunkMode: "length",
      mediaMaxMb: 20
    }
  }
}
```

Multi-account support lives under `channels.slack.accounts` (see the multi-account section above). Env tokens only apply to the default account.

Moltbot starts Slack when the provider is enabled and both tokens are set (via config or `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`). Use `user:<id>` (DM) or `channel:<id>` when specifying delivery targets for cron/CLI commands.
Set `channels.slack.configWrites: false` to block Slack-initiated config writes (including channel ID migrations and `/config set|unset`).

Bot-authored messages are ignored by default. Enable with `channels.slack.allowBots` or `channels.slack.channels.<id>.allowBots`.

Reaction notification modes:
- `off`: no reaction events.
- `own`: reactions on the bot's own messages (default).
- `all`: all reactions on all messages.
- `allowlist`: reactions from `channels.slack.reactionAllowlist` on all messages (empty list disables).

Thread session isolation:
- `channels.slack.thread.historyScope` controls whether thread history is per-thread (`thread`, default) or shared across the channel (`channel`).
- `channels.slack.thread.inheritParent` controls whether new thread sessions inherit the parent channel transcript (default: false).

Slack action groups (gate `slack` tool actions):
| Action group | Default | Notes |
| --- | --- | --- |
| reactions | enabled | React + list reactions |
| messages | enabled | Read/send/edit/delete |
| pins | enabled | Pin/unpin/list |
| memberInfo | enabled | Member info |
| emojiList | enabled | Custom emoji list |

### `channels.mattermost` (bot token)

Mattermost ships as a plugin and is not bundled with the core install.
Install it first: `moltbot plugins install @moltbot/mattermost` (or `./extensions/mattermost` from a git checkout).

Mattermost requires a bot token plus the base URL for your server:

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
      chatmode: "oncall", // oncall | onmessage | onchar
      oncharPrefixes: [">", "!"],
      textChunkLimit: 4000,
      chunkMode: "length"
    }
  }
}
```

Moltbot starts Mattermost when the account is configured (bot token + base URL) and enabled. The token + base URL are resolved from `channels.mattermost.botToken` + `channels.mattermost.baseUrl` or `MATTERMOST_BOT_TOKEN` + `MATTERMOST_URL` for the default account (unless `channels.mattermost.enabled` is `false`).

Chat modes:
- `oncall` (default): respond to channel messages only when @mentioned.
- `onmessage`: respond to every channel message.
- `onchar`: respond when a message starts with a trigger prefix (`channels.mattermost.oncharPrefixes`, default `[">", "!"]`).

Access control:
- Default DMs: `channels.mattermost.dmPolicy="pairing"` (unknown senders get a pairing code).
- Public DMs: `channels.mattermost.dmPolicy="open"` plus `channels.mattermost.allowFrom=["*"]`.
- Groups: `channels.mattermost.groupPolicy="allowlist"` by default (mention-gated). Use `channels.mattermost.groupAllowFrom` to restrict senders.

Multi-account support lives under `channels.mattermost.accounts` (see the multi-account section above). Env vars only apply to the default account.
Use `channel:<id>` or `user:<id>` (or `@username`) when specifying delivery targets; bare ids are treated as channel ids.

### `channels.signal` (signal-cli)

Signal reactions can emit system events (shared reaction tooling):

```json5
{
  channels: {
    signal: {
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000"],
      historyLimit: 50 // include last N group messages as context (0 disables)
    }
  }
}
```

Reaction notification modes:
- `off`: no reaction events.
- `own`: reactions on the bot's own messages (default).
- `all`: all reactions on all messages.
- `allowlist`: reactions from `channels.signal.reactionAllowlist` on all messages (empty list disables).

### `channels.imessage` (imsg CLI)

Moltbot spawns `imsg rpc` (JSON-RPC over stdio). No daemon or port required.

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "imsg",
      dbPath: "~/Library/Messages/chat.db",
      remoteHost: "user@gateway-host", // SCP for remote attachments when using SSH wrapper
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "user@example.com", "chat_id:123"],
      historyLimit: 50,    // include last N group messages as context (0 disables)
      includeAttachments: false,
      mediaMaxMb: 16,
      service: "auto",
      region: "US"
    }
  }
}
```

Multi-account support lives under `channels.imessage.accounts` (see the multi-account section above).

Notes:
- Requires Full Disk Access to the Messages DB.
- The first send will prompt for Messages automation permission.
- Prefer `chat_id:<id>` targets. Use `imsg chats --limit 20` to list chats.
- `channels.imessage.cliPath` can point to a wrapper script (e.g. `ssh` to another Mac that runs `imsg rpc`); use SSH keys to avoid password prompts.
- For remote SSH wrappers, set `channels.imessage.remoteHost` to fetch attachments via SCP when `includeAttachments` is enabled.

Example wrapper:
```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

### `agents.defaults.workspace`

Sets the **single global workspace directory** used by the agent for file operations.

Default: `~/clawd`.

```json5
{
  agents: { defaults: { workspace: "~/clawd" } }
}
```

If `agents.defaults.sandbox` is enabled, non-main sessions can override this with their
own per-scope workspaces under `agents.defaults.sandbox.workspaceRoot`.

### `agents.defaults.repoRoot`

Optional repository root to show in the system prompt’s Runtime line. If unset, Moltbot
tries to detect a `.git` directory by walking upward from the workspace (and current
working directory). The path must exist to be used.

```json5
{
  agents: { defaults: { repoRoot: "~/Projects/moltbot" } }
}
```

### `agents.defaults.skipBootstrap`

Disables automatic creation of the workspace bootstrap files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, and `BOOTSTRAP.md`).

Use this for pre-seeded deployments where your workspace files come from a repo.

```json5
{
  agents: { defaults: { skipBootstrap: true } }
}
```

### `agents.defaults.bootstrapMaxChars`

Max characters of each workspace bootstrap file injected into the system prompt
before truncation. Default: `20000`.

When a file exceeds this limit, Moltbot logs a warning and injects a truncated
head/tail with a marker.

```json5
{
  agents: { defaults: { bootstrapMaxChars: 20000 } }
}
```

### `agents.defaults.userTimezone`

Sets the user’s timezone for **system prompt context** (not for timestamps in
message envelopes). If unset, Moltbot uses the host timezone at runtime.

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } }
}
```

### `agents.defaults.timeFormat`

Controls the **time format** shown in the system prompt’s Current Date & Time section.
Default: `auto` (OS preference).

```json5
{
  agents: { defaults: { timeFormat: "auto" } } // auto | 12 | 24
}
```

### `messages`

Controls inbound/outbound prefixes and optional ack reactions.
See [Messages](/concepts/messages) for queueing, sessions, and streaming context.

```json5
{
  messages: {
    responsePrefix: "🦞", // or "auto"
    ackReaction: "👀",
    ackReactionScope: "group-mentions",
    removeAckAfterReply: false
  }
}
```

`responsePrefix` is applied to **all outbound replies** (tool summaries, block
streaming, final replies) across channels unless already present.

If `messages.responsePrefix` is unset, no prefix is applied by default. WhatsApp self-chat
replies are the exception: they default to `[{identity.name}]` when set, otherwise
`[moltbot]`, so same-phone conversations stay legible.
Set it to `"auto"` to derive `[{identity.name}]` for the routed agent (when set).

#### Template variables

The `responsePrefix` string can include template variables that resolve dynamically:

| Variable | Description | Example |
|----------|-------------|---------|
| `{model}` | Short model name | `claude-opus-4-5`, `gpt-4o` |
| `{modelFull}` | Full model identifier | `anthropic/claude-opus-4-5` |
| `{provider}` | Provider name | `anthropic`, `openai` |
| `{thinkingLevel}` | Current thinking level | `high`, `low`, `off` |
| `{identity.name}` | Agent identity name | (same as `"auto"` mode) |

Variables are case-insensitive (`{MODEL}` = `{model}`). `{think}` is an alias for `{thinkingLevel}`.
Unresolved variables remain as literal text.

```json5
{
  messages: {
    responsePrefix: "[{model} | think:{thinkingLevel}]"
  }
}
```

Example output: `[claude-opus-4-5 | think:high] Here's my response...`

WhatsApp inbound prefix is configured via `channels.whatsapp.messagePrefix` (deprecated:
`messages.messagePrefix`). Default stays **unchanged**: `"[moltbot]"` when
`channels.whatsapp.allowFrom` is empty, otherwise `""` (no prefix). When using
`"[moltbot]"`, Moltbot will instead use `[{identity.name}]` when the routed
agent has `identity.name` set.

`ackReaction` sends a best-effort emoji reaction to acknowledge inbound messages
on channels that support reactions (Slack/Discord/Telegram/Google Chat). Defaults to the
active agent’s `identity.emoji` when set, otherwise `"👀"`. Set it to `""` to disable.

`ackReactionScope` controls when reactions fire:
- `group-mentions` (default): only when a group/room requires mentions **and** the bot was mentioned
- `group-all`: all group/room messages
- `direct`: direct messages only
- `all`: all messages

`removeAckAfterReply` removes the bot’s ack reaction after a reply is sent
(Slack/Discord/Telegram/Google Chat only). Default: `false`.

#### `messages.tts`

Enable text-to-speech for outbound replies. When on, Moltbot generates audio
using ElevenLabs or OpenAI and attaches it to responses. Telegram uses Opus
voice notes; other channels send MP3 audio.

```json5
{
  messages: {
    tts: {
      auto: "always", // off | always | inbound | tagged
      mode: "final", // final | all (include tool/block replies)
      provider: "elevenlabs",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true
      },
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.clawdbot/settings/tts.json",
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.0,
          useSpeakerBoost: true,
          speed: 1.0
        }
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        voice: "alloy"
      }
    }
  }
}
```

Notes:
- `messages.tts.auto` controls auto‑TTS (`off`, `always`, `inbound`, `tagged`).
- `/tts off|always|inbound|tagged` sets the per‑session auto mode (overrides config).
- `messages.tts.enabled` is legacy; doctor migrates it to `messages.tts.auto`.
- `prefsPath` stores local overrides (provider/limit/summarize).
- `maxTextLength` is a hard cap for TTS input; summaries are truncated to fit.
- `summaryModel` overrides `agents.defaults.model.primary` for auto-summary.
  - Accepts `provider/model` or an alias from `agents.defaults.models`.
- `modelOverrides` enables model-driven overrides like `[[tts:...]]` tags (on by default).
- `/tts limit` and `/tts summary` control per-user summarization settings.
- `apiKey` values fall back to `ELEVENLABS_API_KEY`/`XI_API_KEY` and `OPENAI_API_KEY`.
- `elevenlabs.baseUrl` overrides the ElevenLabs API base URL.
- `elevenlabs.voiceSettings` supports `stability`/`similarityBoost`/`style` (0..1),
  `useSpeakerBoost`, and `speed` (0.5..2.0).

### `talk`

Defaults for Talk mode (macOS/iOS/Android). Voice IDs fall back to `ELEVENLABS_VOICE_ID` or `SAG_VOICE_ID` when unset.
`apiKey` falls back to `ELEVENLABS_API_KEY` (or the gateway’s shell profile) when unset.
`voiceAliases` lets Talk directives use friendly names (e.g. `"voice":"Clawd"`).

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    voiceAliases: {
      Clawd: "EXAVITQu4vr4xnSDxMaL",
      Roger: "CwhRBWXzGAHq8TQ4Fs17"
    },
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true
  }
}
```

### `agents.defaults`

Controls the embedded agent runtime (model/thinking/verbose/timeouts).
`agents.defaults.models` defines the configured model catalog (and acts as the allowlist for `/model`).
`agents.defaults.model.primary` sets the default model; `agents.defaults.model.fallbacks` are global failovers.
`agents.defaults.imageModel` is optional and is **only used if the primary model lacks image input**.
Each `agents.defaults.models` entry can include:
- `alias` (optional model shortcut, e.g. `/opus`).
- `params` (optional provider-specific API params passed through to the model request).

`params` is also applied to streaming runs (embedded agent + compaction). Supported keys today: `temperature`, `maxTokens`. These merge with call-time options; caller-supplied values win. `temperature` is an advanced knob—leave unset unless you know the model’s defaults and need a change.

Example:

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-sonnet-4-5-20250929": {
          params: { temperature: 0.6 }
        },
        "openai/gpt-5.2": {
          params: { maxTokens: 8192 }
        }
      }
    }
  }
}
```

Z.AI GLM-4.x models automatically enable thinking mode unless you:
- set `--thinking off`, or
- define `agents.defaults.models["zai/<model>"].params.thinking` yourself.

Moltbot also ships a few built-in alias shorthands. Defaults only apply when the model
is already present in `agents.defaults.models`:

- `opus` -> `anthropic/claude-opus-4-5`
- `sonnet` -> `anthropic/claude-sonnet-4-5`
- `gpt` -> `openai/gpt-5.2`
- `gpt-mini` -> `openai/gpt-5-mini`
- `gemini` -> `google/gemini-3-pro-preview`
- `gemini-flash` -> `google/gemini-3-flash-preview`

If you configure the same alias name (case-insensitive) yourself, your value wins (defaults never override).

Example: Opus 4.5 primary with MiniMax M2.1 fallback (hosted MiniMax):

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-5": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" }
      },
      model: {
        primary: "anthropic/claude-opus-4-5",
        fallbacks: ["minimax/MiniMax-M2.1"]
      }
    }
  }
}
```

MiniMax auth: set `MINIMAX_API_KEY` (env) or configure `models.providers.minimax`.

#### `agents.defaults.cliBackends` (CLI fallback)

Optional CLI backends for text-only fallback runs (no tool calls). These are useful as a
backup path when API providers fail. Image pass-through is supported when you configure
an `imageArg` that accepts file paths.

Notes:
- CLI backends are **text-first**; tools are always disabled.
- Sessions are supported when `sessionArg` is set; session ids are persisted per backend.
- For `claude-cli`, defaults are wired in. Override the command path if PATH is minimal
  (launchd/systemd).

Example:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude"
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          modelArg: "--model",
          sessionArg: "--session",
          sessionMode: "existing",
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat"
        }
      }
    }
  }
}
```

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-5": { alias: "Opus" },
        "anthropic/claude-sonnet-4-1": { alias: "Sonnet" },
        "openrouter/deepseek/deepseek-r1:free": {},
        "zai/glm-4.7": {
          alias: "GLM",
          params: {
            thinking: {
              type: "enabled",
              clear_thinking: false
            }
          }
        }
      },
      model: {
        primary: "anthropic/claude-opus-4-5",
        fallbacks: [
          "openrouter/deepseek/deepseek-r1:free",
          "openrouter/meta-llama/llama-3.3-70b-instruct:free"
        ]
      },
      imageModel: {
        primary: "openrouter/qwen/qwen-2.5-vl-72b-instruct:free",
        fallbacks: [
          "openrouter/google/gemini-2.0-flash-vision:free"
        ]
      },
      thinkingDefault: "low",
      verboseDefault: "off",
      elevatedDefault: "on",
      timeoutSeconds: 600,
      mediaMaxMb: 5,
      heartbeat: {
        every: "30m",
        target: "last"
      },
      maxConcurrent: 3,
      subagents: {
        model: "minimax/MiniMax-M2.1",
        maxConcurrent: 1,
        archiveAfterMinutes: 60
      },
      exec: {
        backgroundMs: 10000,
        timeoutSec: 1800,
        cleanupMs: 1800000
      },
      contextTokens: 200000
    }
  }
}
```

#### `agents.defaults.contextPruning` (tool-result pruning)

`agents.defaults.contextPruning` prunes **old tool results** from the in-memory context right before a request is sent to the LLM.
It does **not** modify the session history on disk (`*.jsonl` remains complete).

This is intended to reduce token usage for chatty agents that accumulate large tool outputs over time.

High level:
- Never touches user/assistant messages.
- Protects the last `keepLastAssistants` assistant messages (no tool results after that point are pruned).
- Protects the bootstrap prefix (nothing before the first user message is pruned).
- Modes:
  - `adaptive`: soft-trims oversized tool results (keep head/tail) when the estimated context ratio crosses `softTrimRatio`.
    Then hard-clears the oldest eligible tool results when the estimated context ratio crosses `hardClearRatio` **and**
    there’s enough prunable tool-result bulk (`minPrunableToolChars`).
  - `aggressive`: always replaces eligible tool results before the cutoff with the `hardClear.placeholder` (no ratio checks).

Soft vs hard pruning (what changes in the context sent to the LLM):
- **Soft-trim**: only for *oversized* tool results. Keeps the beginning + end and inserts `...` in the middle.
  - Before: `toolResult("…very long output…")`
  - After: `toolResult("HEAD…\n...\n…TAIL\n\n[Tool result trimmed: …]")`
- **Hard-clear**: replaces the entire tool result with the placeholder.
  - Before: `toolResult("…very long output…")`
  - After: `toolResult("[Old tool result content cleared]")`

Notes / current limitations:
- Tool results containing **image blocks are skipped** (never trimmed/cleared) right now.
- The estimated “context ratio” is based on **characters** (approximate), not exact tokens.
- If the session doesn’t contain at least `keepLastAssistants` assistant messages yet, pruning is skipped.
- In `aggressive` mode, `hardClear.enabled` is ignored (eligible tool results are always replaced with `hardClear.placeholder`).

Default (adaptive):
```json5
{
  agents: { defaults: { contextPruning: { mode: "adaptive" } } }
}
```

To disable:
```json5
{
  agents: { defaults: { contextPruning: { mode: "off" } } }
}
```

Defaults (when `mode` is `"adaptive"` or `"aggressive"`):
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3` (adaptive only)
- `hardClearRatio`: `0.5` (adaptive only)
- `minPrunableToolChars`: `50000` (adaptive only)
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }` (adaptive only)
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

Example (aggressive, minimal):
```json5
{
  agents: { defaults: { contextPruning: { mode: "aggressive" } } }
}
```

Example (adaptive tuned):
```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "adaptive",
        keepLastAssistants: 3,
        softTrimRatio: 0.3,
        hardClearRatio: 0.5,
        minPrunableToolChars: 50000,
        softTrim: { maxChars: 4000, headChars: 1500, tailChars: 1500 },
        hardClear: { enabled: true, placeholder: "[Old tool result content cleared]" },
        // Optional: restrict pruning to specific tools (deny wins; supports "*" wildcards)
        tools: { deny: ["browser", "canvas"] },
      }
    }
  }
}
```

See [/concepts/session-pruning](/concepts/session-pruning) for behavior details.

#### `agents.defaults.compaction` (reserve headroom + memory flush)

`agents.defaults.compaction.mode` selects the compaction summarization strategy. Defaults to `default`; set `safeguard` to enable chunked summarization for very long histories. See [/concepts/compaction](/concepts/compaction).

`agents.defaults.compaction.reserveTokensFloor` enforces a minimum `reserveTokens`
value for Pi compaction (default: `20000`). Set it to `0` to disable the floor.

`agents.defaults.compaction.memoryFlush` runs a **silent** agentic turn before
auto-compaction, instructing the model to store durable memories on disk (e.g.
`memory/YYYY-MM-DD.md`). It triggers when the session token estimate crosses a
soft threshold below the compaction limit.

Legacy defaults:
- `memoryFlush.enabled`: `true`
- `memoryFlush.softThresholdTokens`: `4000`
- `memoryFlush.prompt` / `memoryFlush.systemPrompt`: built-in defaults with `NO_REPLY`
- Note: memory flush is skipped when the session workspace is read-only
  (`agents.defaults.sandbox.workspaceAccess: "ro"` or `"none"`).

Example (tuned):
```json5
{
  agents: {
    defaults: {
      compaction: {
        mode: "safeguard",
        reserveTokensFloor: 24000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 6000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store."
        }
      }
    }
  }
}
```

Block streaming:
- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (default off).
- Channel overrides: `*.blockStreaming` (and per-account variants) to force block streaming on/off.
  Non-Telegram channels require an explicit `*.blockStreaming: true` to enable block replies.
- `agents.defaults.blockStreamingBreak`: `"text_end"` or `"message_end"` (default: text_end).
- `agents.defaults.blockStreamingChunk`: soft chunking for streamed blocks. Defaults to
  800–1200 chars, prefers paragraph breaks (`\n\n`), then newlines, then sentences.
  Example:
  ```json5
  {
    agents: { defaults: { blockStreamingChunk: { minChars: 800, maxChars: 1200 } } }
  }
  ```
- `agents.defaults.blockStreamingCoalesce`: merge streamed blocks before sending.
  Defaults to `{ idleMs: 1000 }` and inherits `minChars` from `blockStreamingChunk`
  with `maxChars` capped to the channel text limit. Signal/Slack/Discord/Google Chat default
  to `minChars: 1500` unless overridden.
  Channel overrides: `channels.whatsapp.blockStreamingCoalesce`, `channels.telegram.blockStreamingCoalesce`,
  `channels.discord.blockStreamingCoalesce`, `channels.slack.blockStreamingCoalesce`, `channels.mattermost.blockStreamingCoalesce`,
  `channels.signal.blockStreamingCoalesce`, `channels.imessage.blockStreamingCoalesce`, `channels.msteams.blockStreamingCoalesce`,
  `channels.googlechat.blockStreamingCoalesce`
  (and per-account variants).
- `agents.defaults.humanDelay`: randomized pause between **block replies** after the first.
  Modes: `off` (default), `natural` (800–2500ms), `custom` (use `minMs`/`maxMs`).
  Per-agent override: `agents.list[].humanDelay`.
  Example:
  ```json5
  {
    agents: { defaults: { humanDelay: { mode: "natural" } } }
  }
  ```
See [/concepts/streaming](/concepts/streaming) for behavior + chunking details.

Typing indicators:
- `agents.defaults.typingMode`: `"never" | "instant" | "thinking" | "message"`. Defaults to
  `instant` for direct chats / mentions and `message` for unmentioned group chats.
- `session.typingMode`: per-session override for the mode.
- `agents.defaults.typingIntervalSeconds`: how often the typing signal is refreshed (default: 6s).
- `session.typingIntervalSeconds`: per-session override for the refresh interval.
See [/concepts/typing-indicators](/concepts/typing-indicators) for behavior details.

`agents.defaults.model.primary` should be set as `provider/model` (e.g. `anthropic/claude-opus-4-5`).
Aliases come from `agents.defaults.models.*.alias` (e.g. `Opus`).
If you omit the provider, Moltbot currently assumes `anthropic` as a temporary
deprecation fallback.
Z.AI models are available as `zai/<model>` (e.g. `zai/glm-4.7`) and require
`ZAI_API_KEY` (or legacy `Z_AI_API_KEY`) in the environment.

`agents.defaults.heartbeat` configures periodic heartbeat runs:
- `every`: duration string (`ms`, `s`, `m`, `h`); default unit minutes. Default:
  `30m`. Set `0m` to disable.
- `model`: optional override model for heartbeat runs (`provider/model`).
- `includeReasoning`: when `true`, heartbeats will also deliver the separate `Reasoning:` message when available (same shape as `/reasoning on`). Default: `false`.
- `session`: optional session key to control which session the heartbeat runs in. Default: `main`.
- `to`: optional recipient override (channel-specific id, e.g. E.164 for WhatsApp, chat id for Telegram).
- `target`: optional delivery channel (`last`, `whatsapp`, `telegram`, `discord`, `slack`, `msteams`, `signal`, `imessage`, `none`). Default: `last`.
- `prompt`: optional override for the heartbeat body (default: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Overrides are sent verbatim; include a `Read HEARTBEAT.md` line if you still want the file read.
- `ackMaxChars`: max chars allowed after `HEARTBEAT_OK` before delivery (default: 300).

Per-agent heartbeats:
- Set `agents.list[].heartbeat` to enable or override heartbeat settings for a specific agent.
- If any agent entry defines `heartbeat`, **only those agents** run heartbeats; defaults
  become the shared baseline for those agents.

Heartbeats run full agent turns. Shorter intervals burn more tokens; be mindful
of `every`, keep `HEARTBEAT.md` tiny, and/or choose a cheaper `model`.

`tools.exec` configures background exec defaults:
- `backgroundMs`: time before auto-background (ms, default 10000)
- `timeoutSec`: auto-kill after this runtime (seconds, default 1800)
- `cleanupMs`: how long to keep finished sessions in memory (ms, default 1800000)
- `notifyOnExit`: enqueue a system event + request heartbeat when backgrounded exec exits (default true)
- `applyPatch.enabled`: enable experimental `apply_patch` (OpenAI/OpenAI Codex only; default false)
- `applyPatch.allowModels`: optional allowlist of model ids (e.g. `gpt-5.2` or `openai/gpt-5.2`)
Note: `applyPatch` is only under `tools.exec`.

`tools.web` configures web search + fetch tools:
- `tools.web.search.enabled` (default: true when key is present)
- `tools.web.search.apiKey` (recommended: set via `moltbot configure --section web`, or use `BRAVE_API_KEY` env var)
- `tools.web.search.maxResults` (1–10, default 5)
- `tools.web.search.timeoutSeconds` (default 30)
- `tools.web.search.cacheTtlMinutes` (default 15)
- `tools.web.fetch.enabled` (default true)
- `tools.web.fetch.maxChars` (default 50000)
- `tools.web.fetch.timeoutSeconds` (default 30)
- `tools.web.fetch.cacheTtlMinutes` (default 15)
- `tools.web.fetch.userAgent` (optional override)
- `tools.web.fetch.readability` (default true; disable to use basic HTML cleanup only)
- `tools.web.fetch.firecrawl.enabled` (default true when an API key is set)
- `tools.web.fetch.firecrawl.apiKey` (optional; defaults to `FIRECRAWL_API_KEY`)
- `tools.web.fetch.firecrawl.baseUrl` (default https://api.firecrawl.dev)
- `tools.web.fetch.firecrawl.onlyMainContent` (default true)
- `tools.web.fetch.firecrawl.maxAgeMs` (optional)
- `tools.web.fetch.firecrawl.timeoutSeconds` (optional)

`tools.media` configures inbound media understanding (image/audio/video):
- `tools.media.models`: shared model list (capability-tagged; used after per-cap lists).
- `tools.media.concurrency`: max concurrent capability runs (default 2).
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - `enabled`: opt-out switch (default true when models are configured).
  - `prompt`: optional prompt override (image/video append a `maxChars` hint automatically).
  - `maxChars`: max output characters (default 500 for image/video; unset for audio).
  - `maxBytes`: max media size to send (defaults: image 10MB, audio 20MB, video 50MB).
  - `timeoutSeconds`: request timeout (defaults: image 60s, audio 60s, video 120s).
  - `language`: optional audio hint.
  - `attachments`: attachment policy (`mode`, `maxAttachments`, `prefer`).
  - `scope`: optional gating (first match wins) with `match.channel`, `match.chatType`, or `match.keyPrefix`.
  - `models`: ordered list of model entries; failures or oversize media fall back to the next entry.
- Each `models[]` entry:
  - Provider entry (`type: "provider"` or omitted):
    - `provider`: API provider id (`openai`, `anthropic`, `google`/`gemini`, `groq`, etc).
    - `model`: model id override (required for image; defaults to `gpt-4o-mini-transcribe`/`whisper-large-v3-turbo` for audio providers, and `gemini-3-flash-preview` for video).
    - `profile` / `preferredProfile`: auth profile selection.
  - CLI entry (`type: "cli"`):
    - `command`: executable to run.
    - `args`: templated args (supports `{{MediaPath}}`, `{{Prompt}}`, `{{MaxChars}}`, etc).
  - `capabilities`: optional list (`image`, `audio`, `video`) to gate a shared entry. Defaults when omitted: `openai`/`anthropic`/`minimax` → image, `google` → image+audio+video, `groq` → audio.
  - `prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language` can be overridden per entry.

If no models are configured (or `enabled: false`), understanding is skipped; the model still receives the original attachments.

Provider auth follows the standard model auth order (auth profiles, env vars like `OPENAI_API_KEY`/`GROQ_API_KEY`/`GEMINI_API_KEY`, or `models.providers.*.apiKey`).

Example:
```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        scope: {
          default: "deny",
          rules: [{ action: "allow", match: { chatType: "direct" } }]
        },
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          { type: "cli", command: "whisper", args: ["--model", "base", "{{MediaPath}}"] }
        ]
      },
      video: {
        enabled: true,
        maxBytes: 52428800,
        models: [{ provider: "google", model: "gemini-3-flash-preview" }]
      }
    }
  }
}
```

`agents.defaults.subagents` configures sub-agent defaults:
- `model`: default model for spawned sub-agents (string or `{ primary, fallbacks }`). If omitted, sub-agents inherit the caller’s model unless overridden per agent or per call.
- `maxConcurrent`: max concurrent sub-agent runs (default 1)
- `archiveAfterMinutes`: auto-archive sub-agent sessions after N minutes (default 60; set `0` to disable)
- Per-subagent tool policy: `tools.subagents.tools.allow` / `tools.subagents.tools.deny` (deny wins)

`tools.profile` sets a **base tool allowlist** before `tools.allow`/`tools.deny`:
- `minimal`: `session_status` only
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: no restriction (same as unset)

Per-agent override: `agents.list[].tools.profile`.

Example (messaging-only by default, allow Slack + Discord tools too):
```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"]
  }
}
```

Example (coding profile, but deny exec/process everywhere):
```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"]
  }
}
```

`tools.byProvider` lets you **further restrict** tools for specific providers (or a single `provider/model`).
Per-agent override: `agents.list[].tools.byProvider`.

Order: base profile → provider profile → allow/deny policies.
Provider keys accept either `provider` (e.g. `google-antigravity`) or `provider/model`
(e.g. `openai/gpt-5.2`).

Example (keep global coding profile, but minimal tools for Google Antigravity):
```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" }
    }
  }
}
```

Example (provider/model-specific allowlist):
```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] }
    }
  }
}
```

`tools.allow` / `tools.deny` configure a global tool allow/deny policy (deny wins).
Matching is case-insensitive and supports `*` wildcards (`"*"` means all tools).
This is applied even when the Docker sandbox is **off**.

Example (disable browser/canvas everywhere):
```json5
{
  tools: { deny: ["browser", "canvas"] }
}
```

Tool groups (shorthands) work in **global** and **per-agent** tool policies:
- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:moltbot`: all built-in Moltbot tools (excludes provider plugins)

`tools.elevated` controls elevated (host) exec access:
- `enabled`: allow elevated mode (default true)
- `allowFrom`: per-channel allowlists (empty = disabled)
  - `whatsapp`: E.164 numbers
  - `telegram`: chat ids or usernames
  - `discord`: user ids or usernames (falls back to `channels.discord.dm.allowFrom` if omitted)
  - `signal`: E.164 numbers
  - `imessage`: handles/chat ids
  - `webchat`: session ids or usernames

Example:
```json5
{
  tools: {
    elevated: {
      enabled: true,
      allowFrom: {
        whatsapp: ["+15555550123"],
        discord: ["steipete", "1234567890123"]
      }
    }
  }
}
```

Per-agent override (further restrict):
```json5
{
  agents: {
    list: [
      {
        id: "family",
        tools: {
          elevated: { enabled: false }
        }
      }
    ]
  }
}
```

Notes:
- `tools.elevated` is the global baseline. `agents.list[].tools.elevated` can only further restrict (both must allow).
- `/elevated on|off|ask|full` stores state per session key; inline directives apply to a single message.
- Elevated `exec` runs on the host and bypasses sandboxing.
- Tool policy still applies; if `exec` is denied, elevated cannot be used.

`agents.defaults.maxConcurrent` sets the maximum number of embedded agent runs that can
execute in parallel across sessions. Each session is still serialized (one run
per session key at a time). Default: 1.

### `agents.defaults.sandbox`

Optional **Docker sandboxing** for the embedded agent. Intended for non-main
sessions so they cannot access your host system.

Details: [Sandboxing](/gateway/sandboxing)

Defaults (if enabled):
- scope: `"agent"` (one container + workspace per agent)
- Debian bookworm-slim based image
- agent workspace access: `workspaceAccess: "none"` (default)
  - `"none"`: use a per-scope sandbox workspace under `~/.clawdbot/sandboxes`
- `"ro"`: keep the sandbox workspace at `/workspace`, and mount the agent workspace read-only at `/agent` (disables `write`/`edit`/`apply_patch`)
  - `"rw"`: mount the agent workspace read/write at `/workspace`
- auto-prune: idle > 24h OR age > 7d
- tool policy: allow only `exec`, `process`, `read`, `write`, `edit`, `apply_patch`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status` (deny wins)
  - configure via `tools.sandbox.tools`, override per-agent via `agents.list[].tools.sandbox.tools`
  - tool group shorthands supported in sandbox policy: `group:runtime`, `group:fs`, `group:sessions`, `group:memory` (see [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#tool-groups-shorthands))
- optional sandboxed browser (Chromium + CDP, noVNC observer)
- hardening knobs: `network`, `user`, `pidsLimit`, `memory`, `cpus`, `ulimits`, `seccompProfile`, `apparmorProfile`

Warning: `scope: "shared"` means a shared container and shared workspace. No
cross-session isolation. Use `scope: "session"` for per-session isolation.

Legacy: `perSession` is still supported (`true` → `scope: "session"`,
`false` → `scope: "shared"`).

`setupCommand` runs **once** after the container is created (inside the container via `sh -lc`).
For package installs, ensure network egress, a writable root FS, and a root user.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.clawdbot/sandboxes",
        docker: {
          image: "moltbot-sandbox:bookworm-slim",
          containerPrefix: "moltbot-sbx-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          // Per-agent override (multi-agent): agents.list[].sandbox.docker.*
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "moltbot-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
          binds: ["/var/run/docker.sock:/var/run/docker.sock", "/home/user/source:/source:rw"]
        },
        browser: {
          enabled: false,
          image: "moltbot-sandbox-browser:bookworm-slim",
          containerPrefix: "moltbot-sbx-browser-",
          cdpPort: 9222,
          vncPort: 5900,
          noVncPort: 6080,
          headless: false,
          enableNoVnc: true,
          allowHostControl: false,
          allowedControlUrls: ["http://10.0.0.42:18791"],
          allowedControlHosts: ["browser.lab.local", "10.0.0.42"],
          allowedControlPorts: [18791],
          autoStart: true,
          autoStartTimeoutMs: 12000
        },
        prune: {
          idleHours: 24,  // 0 disables idle pruning
          maxAgeDays: 7   // 0 disables max-age pruning
        }
      }
    }
  },
  tools: {
    sandbox: {
      tools: {
        allow: ["exec", "process", "read", "write", "edit", "apply_patch", "sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "session_status"],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"]
      }
    }
  }
}
```

Build the default sandbox image once with:
```bash
scripts/sandbox-setup.sh
```

Note: sandbox containers default to `network: "none"`; set `agents.defaults.sandbox.docker.network`
to `"bridge"` (or your custom network) if the agent needs outbound access.

Note: inbound attachments are staged into the active workspace at `media/inbound/*`. With `workspaceAccess: "rw"`, that means files are written into the agent workspace.

Note: `docker.binds` mounts additional host directories; global and per-agent binds are merged.

Build the optional browser image with:
```bash
scripts/sandbox-browser-setup.sh
```

When `agents.defaults.sandbox.browser.enabled=true`, the browser tool uses a sandboxed
Chromium instance (CDP). If noVNC is enabled (default when headless=false),
the noVNC URL is injected into the system prompt so the agent can reference it.
This does not require `browser.enabled` in the main config; the sandbox control
URL is injected per session.

`agents.defaults.sandbox.browser.allowHostControl` (default: false) allows
sandboxed sessions to explicitly target the **host** browser control server
via the browser tool (`target: "host"`). Leave this off if you want strict
sandbox isolation.

Allowlists for remote control:
- `allowedControlUrls`: exact control URLs permitted for `target: "custom"`.
- `allowedControlHosts`: hostnames permitted (hostname only, no port).
- `allowedControlPorts`: ports permitted (defaults: http=80, https=443).
Defaults: all allowlists are unset (no restriction). `allowHostControl` defaults to false.

### `models` (custom providers + base URLs)

Moltbot uses the **pi-coding-agent** model catalog. You can add custom providers
(LiteLLM, local OpenAI-compatible servers, Anthropic proxies, etc.) by writing
`~/.clawdbot/agents/<agentId>/agent/models.json` or by defining the same schema inside your
Moltbot config under `models.providers`.
Provider-by-provider overview + examples: [/concepts/model-providers](/concepts/model-providers).

When `models.providers` is present, Moltbot writes/merges a `models.json` into
`~/.clawdbot/agents/<agentId>/agent/` on startup:
- default behavior: **merge** (keeps existing providers, overrides on name)
- set `models.mode: "replace"` to overwrite the file contents

Select the model via `agents.defaults.model.primary` (provider/model).

```json5
{
  agents: {
    defaults: {
      model: { primary: "custom-proxy/llama-3.1-8b" },
      models: {
        "custom-proxy/llama-3.1-8b": {}
      }
    }
  },
  models: {
    mode: "merge",
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "LITELLM_KEY",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.1-8b",
            name: "Llama 3.1 8B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000
          }
        ]
      }
    }
  }
}
```

### OpenCode Zen (multi-model proxy)

OpenCode Zen is a multi-model gateway with per-model endpoints. Moltbot uses
the built-in `opencode` provider from pi-ai; set `OPENCODE_API_KEY` (or
`OPENCODE_ZEN_API_KEY`) from https://opencode.ai/auth.

Notes:
- Model refs use `opencode/<modelId>` (example: `opencode/claude-opus-4-5`).
- If you enable an allowlist via `agents.defaults.models`, add each model you plan to use.
- Shortcut: `moltbot onboard --auth-choice opencode-zen`.

```json5
{
  agents: {
    defaults: {
      model: { primary: "opencode/claude-opus-4-5" },
      models: { "opencode/claude-opus-4-5": { alias: "Opus" } }
    }
  }
}
```

### Z.AI (GLM-4.7) — provider alias support

Z.AI models are available via the built-in `zai` provider. Set `ZAI_API_KEY`
in your environment and reference the model by provider/model.

Shortcut: `moltbot onboard --auth-choice zai-api-key`.

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} }
    }
  }
}
```

Notes:
- `z.ai/*` and `z-ai/*` are accepted aliases and normalize to `zai/*`.
- If `ZAI_API_KEY` is missing, requests to `zai/*` will fail with an auth error at runtime.
- Example error: `No API key found for provider "zai".`
- Z.AI’s general API endpoint is `https://api.z.ai/api/paas/v4`. GLM coding
  requests use the dedicated Coding endpoint `https://api.z.ai/api/coding/paas/v4`.
  The built-in `zai` provider uses the Coding endpoint. If you need the general
  endpoint, define a custom provider in `models.providers` with the base URL
  override (see the custom providers section above).
- Use a fake placeholder in docs/configs; never commit real API keys.

### Moonshot AI (Kimi)

Use Moonshot's OpenAI-compatible endpoint:

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2-0905-preview" },
      models: { "moonshot/kimi-k2-0905-preview": { alias: "Kimi K2" } }
    }
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "kimi-k2-0905-preview",
            name: "Kimi K2 0905 Preview",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192
          }
        ]
      }
    }
  }
}
```

Notes:
- Set `MOONSHOT_API_KEY` in the environment or use `moltbot onboard --auth-choice moonshot-api-key`.
- Model ref: `moonshot/kimi-k2-0905-preview`.
- Use `https://api.moonshot.cn/v1` if you need the China endpoint.

### Kimi Code

Use Kimi Code's dedicated OpenAI-compatible endpoint (separate from Moonshot):

```json5
{
  env: { KIMICODE_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi-code/kimi-for-coding" },
      models: { "kimi-code/kimi-for-coding": { alias: "Kimi Code" } }
    }
  },
  models: {
    mode: "merge",
    providers: {
      "kimi-code": {
        baseUrl: "https://api.kimi.com/coding/v1",
        apiKey: "${KIMICODE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "kimi-for-coding",
            name: "Kimi For Coding",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 32768,
            headers: { "User-Agent": "KimiCLI/0.77" },
            compat: { supportsDeveloperRole: false }
          }
        ]
      }
    }
  }
}
```

Notes:
- Set `KIMICODE_API_KEY` in the environment or use `moltbot onboard --auth-choice kimi-code-api-key`.
- Model ref: `kimi-code/kimi-for-coding`.

### Synthetic (Anthropic-compatible)

Use Synthetic's Anthropic-compatible endpoint:

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } }
    }
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536
          }
        ]
      }
    }
  }
}
```

Notes:
- Set `SYNTHETIC_API_KEY` or use `moltbot onboard --auth-choice synthetic-api-key`.
- Model ref: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`.
- Base URL should omit `/v1` because the Anthropic client appends it.

### Local models (LM Studio) — recommended setup

See [/gateway/local-models](/gateway/local-models) for the current local guidance. TL;DR: run MiniMax M2.1 via LM Studio Responses API on serious hardware; keep hosted models merged for fallback.

### MiniMax M2.1

Use MiniMax M2.1 directly without LM Studio:

```json5
{
  agent: {
    model: { primary: "minimax/MiniMax-M2.1" },
    models: {
      "anthropic/claude-opus-4-5": { alias: "Opus" },
      "minimax/MiniMax-M2.1": { alias: "Minimax" }
    }
  },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            // Pricing: update in models.json if you need exact cost tracking.
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192
          }
        ]
      }
    }
  }
}
```

Notes:
- Set `MINIMAX_API_KEY` environment variable or use `moltbot onboard --auth-choice minimax-api`.
- Available model: `MiniMax-M2.1` (default).
- Update pricing in `models.json` if you need exact cost tracking.

### Cerebras (GLM 4.6 / 4.7)

Use Cerebras via their OpenAI-compatible endpoint:

```json5
{
  env: { CEREBRAS_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: {
        primary: "cerebras/zai-glm-4.7",
        fallbacks: ["cerebras/zai-glm-4.6"]
      },
      models: {
        "cerebras/zai-glm-4.7": { alias: "GLM 4.7 (Cerebras)" },
        "cerebras/zai-glm-4.6": { alias: "GLM 4.6 (Cerebras)" }
      }
    }
  },
  models: {
    mode: "merge",
    providers: {
      cerebras: {
        baseUrl: "https://api.cerebras.ai/v1",
        apiKey: "${CEREBRAS_API_KEY}",
        api: "openai-completions",
        models: [
          { id: "zai-glm-4.7", name: "GLM 4.7 (Cerebras)" },
          { id: "zai-glm-4.6", name: "GLM 4.6 (Cerebras)" }
        ]
      }
    }
  }
}
```

Notes:
- Use `cerebras/zai-glm-4.7` for Cerebras; use `zai/glm-4.7` for Z.AI direct.
- Set `CEREBRAS_API_KEY` in the environment or config.

Notes:
- Supported APIs: `openai-completions`, `openai-responses`, `anthropic-messages`,
  `google-generative-ai`
- Use `authHeader: true` + `headers` for custom auth needs.
- Override the agent config root with `CLAWDBOT_AGENT_DIR` (or `PI_CODING_AGENT_DIR`)
  if you want `models.json` stored elsewhere (default: `~/.clawdbot/agents/main/agent`).

### `session`

Controls session scoping, reset policy, reset triggers, and where the session store is written.

```json5
{
  session: {
    scope: "per-sender",
    dmScope: "main",
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"]
    },
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 60
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      dm: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 }
    },
    resetTriggers: ["/new", "/reset"],
    // Default is already per-agent under ~/.clawdbot/agents/<agentId>/sessions/sessions.json
    // You can override with {agentId} templating:
    store: "~/.clawdbot/agents/{agentId}/sessions/sessions.json",
    // Direct chats collapse to agent:<agentId>:<mainKey> (default: "main").
    mainKey: "main",
    agentToAgent: {
      // Max ping-pong reply turns between requester/target (0–5).
      maxPingPongTurns: 5
    },
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } }
      ],
      default: "allow"
    }
  }
}
```

Fields:
- `mainKey`: direct-chat bucket key (default: `"main"`). Useful when you want to “rename” the primary DM thread without changing `agentId`.
  - Sandbox note: `agents.defaults.sandbox.mode: "non-main"` uses this key to detect the main session. Any session key that does not match `mainKey` (groups/channels) is sandboxed.
- `dmScope`: how DM sessions are grouped (default: `"main"`).
  - `main`: all DMs share the main session for continuity.
  - `per-peer`: isolate DMs by sender id across channels.
  - `per-channel-peer`: isolate DMs per channel + sender (recommended for multi-user inboxes).
- `identityLinks`: map canonical ids to provider-prefixed peers so the same person shares a DM session across channels when using `per-peer` or `per-channel-peer`.
  - Example: `alice: ["telegram:123456789", "discord:987654321012345678"]`.
- `reset`: primary reset policy. Defaults to daily resets at 4:00 AM local time on the gateway host.
  - `mode`: `daily` or `idle` (default: `daily` when `reset` is present).
  - `atHour`: local hour (0-23) for the daily reset boundary.
  - `idleMinutes`: sliding idle window in minutes. When daily + idle are both configured, whichever expires first wins.
- `resetByType`: per-session overrides for `dm`, `group`, and `thread`.
  - If you only set legacy `session.idleMinutes` without any `reset`/`resetByType`, Moltbot stays in idle-only mode for backward compatibility.
- `heartbeatIdleMinutes`: optional idle override for heartbeat checks (daily reset still applies when enabled).
- `agentToAgent.maxPingPongTurns`: max reply-back turns between requester/target (0–5, default 5).
- `sendPolicy.default`: `allow` or `deny` fallback when no rule matches.
- `sendPolicy.rules[]`: match by `channel`, `chatType` (`direct|group|room`), or `keyPrefix` (e.g. `cron:`). First deny wins; otherwise allow.

### `skills` (skills config)

Controls bundled allowlist, install preferences, extra skill folders, and per-skill
overrides. Applies to **bundled** skills and `~/.clawdbot/skills` (workspace skills
still win on name conflicts).

Fields:
- `allowBundled`: optional allowlist for **bundled** skills only. If set, only those
  bundled skills are eligible (managed/workspace skills unaffected).
- `load.extraDirs`: additional skill directories to scan (lowest precedence).
- `install.preferBrew`: prefer brew installers when available (default: true).
- `install.nodeManager`: node installer preference (`npm` | `pnpm` | `yarn`, default: npm).
- `entries.<skillKey>`: per-skill config overrides.

Per-skill fields:
- `enabled`: set `false` to disable a skill even if it’s bundled/installed.
- `env`: environment variables injected for the agent run (only if not already set).
- `apiKey`: optional convenience for skills that declare a primary env var (e.g. `nano-banana-pro` → `GEMINI_API_KEY`).

Example:

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: [
        "~/Projects/agent-scripts/skills",
        "~/Projects/oss/some-skill-pack/skills"
      ]
    },
    install: {
      preferBrew: true,
      nodeManager: "npm"
    },
    entries: {
      "nano-banana-pro": {
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE"
        }
      },
      peekaboo: { enabled: true },
      sag: { enabled: false }
    }
  }
}
```

### `plugins` (extensions)

Controls plugin discovery, allow/deny, and per-plugin config. Plugins are loaded
from `~/.clawdbot/extensions`, `<workspace>/.clawdbot/extensions`, plus any
`plugins.load.paths` entries. **Config changes require a gateway restart.**
See [/plugin](/plugin) for full usage.

Fields:
- `enabled`: master toggle for plugin loading (default: true).
- `allow`: optional allowlist of plugin ids; when set, only listed plugins load.
- `deny`: optional denylist of plugin ids (deny wins).
- `load.paths`: extra plugin files or directories to load (absolute or `~`).
- `entries.<pluginId>`: per-plugin overrides.
  - `enabled`: set `false` to disable.
  - `config`: plugin-specific config object (validated by the plugin if provided).

Example:

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    load: {
      paths: ["~/Projects/oss/voice-call-extension"]
    },
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio"
        }
      }
    }
  }
}
```

### `browser` (clawd-managed browser)

Moltbot can start a **dedicated, isolated** Chrome/Brave/Edge/Chromium instance for clawd and expose a small loopback control service.
Profiles can point at a **remote** Chromium-based browser via `profiles.<name>.cdpUrl`. Remote
profiles are attach-only (start/stop/reset are disabled).

`browser.cdpUrl` remains for legacy single-profile configs and as the base
scheme/host for profiles that only set `cdpPort`.

Defaults:
- enabled: `true`
- evaluateEnabled: `true` (set `false` to disable `act:evaluate` and `wait --fn`)
- control service: loopback only (port derived from `gateway.port`, default `18791`)
- CDP URL: `http://127.0.0.1:18792` (control service + 1, legacy single-profile)
- profile color: `#FF4500` (lobster-orange)
- Note: the control server is started by the running gateway (Moltbot.app menubar, or `moltbot gateway`).
- Auto-detect order: default browser if Chromium-based; otherwise Chrome → Brave → Edge → Chromium → Chrome Canary.

```json5
{
  browser: {
    enabled: true,
    evaluateEnabled: true,
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    defaultProfile: "chrome",
    profiles: {
      clawd: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" }
    },
    color: "#FF4500",
    // Advanced:
    // headless: false,
    // noSandbox: false,
    // executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    // attachOnly: false, // set true when tunneling a remote CDP to localhost
  }
}
```

### `ui` (Appearance)

Optional accent color used by the native apps for UI chrome (e.g. Talk Mode bubble tint).

If unset, clients fall back to a muted light-blue.

```json5
{
  ui: {
    seamColor: "#FF4500", // hex (RRGGBB or #RRGGBB)
    // Optional: Control UI assistant identity override.
    // If unset, the Control UI uses the active agent identity (config or IDENTITY.md).
    assistant: {
      name: "Moltbot",
      avatar: "CB" // emoji, short text, or image URL/data URI
    }
  }
}
```

### `gateway` (Gateway server mode + bind)

Use `gateway.mode` to explicitly declare whether this machine should run the Gateway.

Defaults:
- mode: **unset** (treated as “do not auto-start”)
- bind: `loopback`
- port: `18789` (single port for WS + HTTP)

```json5
{
  gateway: {
    mode: "local", // or "remote"
    port: 18789, // WS + HTTP multiplex
    bind: "loopback",
    // controlUi: { enabled: true, basePath: "/moltbot" }
    // auth: { mode: "token", token: "your-token" } // token gates WS + Control UI access
    // tailscale: { mode: "off" | "serve" | "funnel" }
  }
}
```

Control UI base path:
- `gateway.controlUi.basePath` sets the URL prefix where the Control UI is served.
- Examples: `"/ui"`, `"/moltbot"`, `"/apps/moltbot"`.
- Default: root (`/`) (unchanged).
- `gateway.controlUi.allowInsecureAuth` allows token-only auth for the Control UI when
  device identity is omitted (typically over HTTP). Default: `false`. Prefer HTTPS
  (Tailscale Serve) or `127.0.0.1`.
- `gateway.controlUi.dangerouslyDisableDeviceAuth` disables device identity checks for the
  Control UI (token/password only). Default: `false`. Break-glass only.

Related docs:
- [Control UI](/web/control-ui)
- [Web overview](/web)
- [Tailscale](/gateway/tailscale)
- [Remote access](/gateway/remote)

Trusted proxies:
- `gateway.trustedProxies`: list of reverse proxy IPs that terminate TLS in front of the Gateway.
- When a connection comes from one of these IPs, Moltbot uses `x-forwarded-for` (or `x-real-ip`) to determine the client IP for local pairing checks and HTTP auth/local checks.
- Only list proxies you fully control, and ensure they **overwrite** incoming `x-forwarded-for`.

Notes:
- `moltbot gateway` refuses to start unless `gateway.mode` is set to `local` (or you pass the override flag).
- `gateway.port` controls the single multiplexed port used for WebSocket + HTTP (control UI, hooks, A2UI).
- OpenAI Chat Completions endpoint: **disabled by default**; enable with `gateway.http.endpoints.chatCompletions.enabled: true`.
- Precedence: `--port` > `CLAWDBOT_GATEWAY_PORT` > `gateway.port` > default `18789`.
- Gateway auth is required by default (token/password or Tailscale Serve identity). Non-loopback binds require a shared token/password.
- The onboarding wizard generates a gateway token by default (even on loopback).
- `gateway.remote.token` is **only** for remote CLI calls; it does not enable local gateway auth. `gateway.token` is ignored.

Auth and Tailscale:
- `gateway.auth.mode` sets the handshake requirements (`token` or `password`). When unset, token auth is assumed.
- `gateway.auth.token` stores the shared token for token auth (used by the CLI on the same machine).
- When `gateway.auth.mode` is set, only that method is accepted (plus optional Tailscale headers).
- `gateway.auth.password` can be set here, or via `CLAWDBOT_GATEWAY_PASSWORD` (recommended).
- `gateway.auth.allowTailscale` allows Tailscale Serve identity headers
  (`tailscale-user-login`) to satisfy auth when the request arrives on loopback
  with `x-forwarded-for`, `x-forwarded-proto`, and `x-forwarded-host`. Moltbot
  verifies the identity by resolving the `x-forwarded-for` address via
  `tailscale whois` before accepting it. When `true`, Serve requests do not need
  a token/password; set `false` to require explicit credentials. Defaults to
  `true` when `tailscale.mode = "serve"` and auth mode is not `password`.
- `gateway.tailscale.mode: "serve"` uses Tailscale Serve (tailnet only, loopback bind).
- `gateway.tailscale.mode: "funnel"` exposes the dashboard publicly; requires auth.
- `gateway.tailscale.resetOnExit` resets Serve/Funnel config on shutdown.

Remote client defaults (CLI):
- `gateway.remote.url` sets the default Gateway WebSocket URL for CLI calls when `gateway.mode = "remote"`.
- `gateway.remote.transport` selects the macOS remote transport (`ssh` default, `direct` for ws/wss). When `direct`, `gateway.remote.url` must be `ws://` or `wss://`. `ws://host` defaults to port `18789`.
- `gateway.remote.token` supplies the token for remote calls (leave unset for no auth).
- `gateway.remote.password` supplies the password for remote calls (leave unset for no auth).

macOS app behavior:
- Moltbot.app watches `~/.clawdbot/moltbot.json` and switches modes live when `gateway.mode` or `gateway.remote.url` changes.
- If `gateway.mode` is unset but `gateway.remote.url` is set, the macOS app treats it as remote mode.
- When you change connection mode in the macOS app, it writes `gateway.mode` (and `gateway.remote.url` + `gateway.remote.transport` in remote mode) back to the config file.

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      password: "your-password"
    }
  }
}
```

Direct transport example (macOS app):

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      transport: "direct",
      url: "wss://gateway.example.ts.net",
      token: "your-token"
    }
  }
}
```

### `gateway.reload` (Config hot reload)

The Gateway watches `~/.clawdbot/moltbot.json` (or `CLAWDBOT_CONFIG_PATH`) and applies changes automatically.

Modes:
- `hybrid` (default): hot-apply safe changes; restart the Gateway for critical changes.
- `hot`: only apply hot-safe changes; log when a restart is required.
- `restart`: restart the Gateway on any config change.
- `off`: disable hot reload.

```json5
{
  gateway: {
    reload: {
      mode: "hybrid",
      debounceMs: 300
    }
  }
}
```

#### Hot reload matrix (files + impact)

Files watched:
- `~/.clawdbot/moltbot.json` (or `CLAWDBOT_CONFIG_PATH`)

Hot-applied (no full gateway restart):
- `hooks` (webhook auth/path/mappings) + `hooks.gmail` (Gmail watcher restarted)
- `browser` (browser control server restart)
- `cron` (cron service restart + concurrency update)
- `agents.defaults.heartbeat` (heartbeat runner restart)
- `web` (WhatsApp web channel restart)
- `telegram`, `discord`, `signal`, `imessage` (channel restarts)
- `agent`, `models`, `routing`, `messages`, `session`, `whatsapp`, `logging`, `skills`, `ui`, `talk`, `identity`, `wizard` (dynamic reads)

Requires full Gateway restart:
- `gateway` (port/bind/auth/control UI/tailscale)
- `bridge` (legacy)
- `discovery`
- `canvasHost`
- `plugins`
- Any unknown/unsupported config path (defaults to restart for safety)

### Multi-instance isolation

To run multiple gateways on one host (for redundancy or a rescue bot), isolate per-instance state + config and use unique ports:
- `CLAWDBOT_CONFIG_PATH` (per-instance config)
- `CLAWDBOT_STATE_DIR` (sessions/creds)
- `agents.defaults.workspace` (memories)
- `gateway.port` (unique per instance)

Convenience flags (CLI):
- `moltbot --dev …` → uses `~/.clawdbot-dev` + shifts ports from base `19001`
- `moltbot --profile <name> …` → uses `~/.clawdbot-<name>` (port via config/env/flags)

See [Gateway runbook](/gateway) for the derived port mapping (gateway/browser/canvas).
See [Multiple gateways](/gateway/multiple-gateways) for browser/CDP port isolation details.

Example:
```bash
CLAWDBOT_CONFIG_PATH=~/.clawdbot/a.json \
CLAWDBOT_STATE_DIR=~/.clawdbot-a \
moltbot gateway --port 19001
```

### `hooks` (Gateway webhooks)

Enable a simple HTTP webhook endpoint on the Gateway HTTP server.

Defaults:
- enabled: `false`
- path: `/hooks`
- maxBodyBytes: `262144` (256 KB)

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    presets: ["gmail"],
    transformsDir: "~/.clawdbot/hooks",
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate:
          "From: {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}",
        deliver: true,
        channel: "last",
        model: "openai/gpt-5.2-mini",
      },
    ],
  }
}
```

Requests must include the hook token:
- `Authorization: Bearer <token>` **or**
- `x-moltbot-token: <token>` **or**
- `?token=<token>`

Endpoints:
- `POST /hooks/wake` → `{ text, mode?: "now"|"next-heartbeat" }`
- `POST /hooks/agent` → `{ message, name?, sessionKey?, wakeMode?, deliver?, channel?, to?, model?, thinking?, timeoutSeconds? }`
- `POST /hooks/<name>` → resolved via `hooks.mappings`

`/hooks/agent` always posts a summary into the main session (and can optionally trigger an immediate heartbeat via `wakeMode: "now"`).

Mapping notes:
- `match.path` matches the sub-path after `/hooks` (e.g. `/hooks/gmail` → `gmail`).
- `match.source` matches a payload field (e.g. `{ source: "gmail" }`) so you can use a generic `/hooks/ingest` path.
- Templates like `{{messages[0].subject}}` read from the payload.
- `transform` can point to a JS/TS module that returns a hook action.
- `deliver: true` sends the final reply to a channel; `channel` defaults to `last` (falls back to WhatsApp).
- If there is no prior delivery route, set `channel` + `to` explicitly (required for Telegram/Discord/Google Chat/Slack/Signal/iMessage/MS Teams).
- `model` overrides the LLM for this hook run (`provider/model` or alias; must be allowed if `agents.defaults.models` is set).

Gmail helper config (used by `moltbot webhooks gmail setup` / `run`):

```json5
{
  hooks: {
    gmail: {
      account: "moltbot@gmail.com",
      topic: "projects/<project-id>/topics/gog-gmail-watch",
      subscription: "gog-gmail-watch-push",
      pushToken: "shared-push-token",
      hookUrl: "http://127.0.0.1:18789/hooks/gmail",
      includeBody: true,
      maxBytes: 20000,
      renewEveryMinutes: 720,
      serve: { bind: "127.0.0.1", port: 8788, path: "/" },
      tailscale: { mode: "funnel", path: "/gmail-pubsub" },

      // Optional: use a cheaper model for Gmail hook processing
      // Falls back to agents.defaults.model.fallbacks, then primary, on auth/rate-limit/timeout
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      // Optional: default thinking level for Gmail hooks
      thinking: "off",
    }
  }
}
```

Model override for Gmail hooks:
- `hooks.gmail.model` specifies a model to use for Gmail hook processing (defaults to session primary).
- Accepts `provider/model` refs or aliases from `agents.defaults.models`.
- Falls back to `agents.defaults.model.fallbacks`, then `agents.defaults.model.primary`, on auth/rate-limit/timeouts.
- If `agents.defaults.models` is set, include the hooks model in the allowlist.
- At startup, warns if the configured model is not in the model catalog or allowlist.
- `hooks.gmail.thinking` sets the default thinking level for Gmail hooks and is overridden by per-hook `thinking`.

Gateway auto-start:
- If `hooks.enabled=true` and `hooks.gmail.account` is set, the Gateway starts
  `gog gmail watch serve` on boot and auto-renews the watch.
- Set `CLAWDBOT_SKIP_GMAIL_WATCHER=1` to disable the auto-start (for manual runs).
- Avoid running a separate `gog gmail watch serve` alongside the Gateway; it will
  fail with `listen tcp 127.0.0.1:8788: bind: address already in use`.

Note: when `tailscale.mode` is on, Moltbot defaults `serve.path` to `/` so
Tailscale can proxy `/gmail-pubsub` correctly (it strips the set-path prefix).
If you need the backend to receive the prefixed path, set
`hooks.gmail.tailscale.target` to a full URL (and align `serve.path`).

### `canvasHost` (LAN/tailnet Canvas file server + live reload)

The Gateway serves a directory of HTML/CSS/JS over HTTP so iOS/Android nodes can simply `canvas.navigate` to it.

Default root: `~/clawd/canvas`  
Default port: `18793` (chosen to avoid the clawd browser CDP port `18792`)  
The server listens on the **gateway bind host** (LAN or Tailnet) so nodes can reach it.

The server:
- serves files under `canvasHost.root`
- injects a tiny live-reload client into served HTML
- watches the directory and broadcasts reloads over a WebSocket endpoint at `/__moltbot/ws`
- auto-creates a starter `index.html` when the directory is empty (so you see something immediately)
- also serves A2UI at `/__moltbot__/a2ui/` and is advertised to nodes as `canvasHostUrl`
  (always used by nodes for Canvas/A2UI)

Disable live reload (and file watching) if the directory is large or you hit `EMFILE`:
- config: `canvasHost: { liveReload: false }`

```json5
{
  canvasHost: {
    root: "~/clawd/canvas",
    port: 18793,
    liveReload: true
  }
}
```

Changes to `canvasHost.*` require a gateway restart (config reload will restart).

Disable with:
- config: `canvasHost: { enabled: false }`
- env: `CLAWDBOT_SKIP_CANVAS_HOST=1`

### `bridge` (legacy TCP bridge, removed)

Current builds no longer include the TCP bridge listener; `bridge.*` config keys are ignored.
Nodes connect over the Gateway WebSocket. This section is kept for historical reference.

Legacy behavior:
- The Gateway could expose a simple TCP bridge for nodes (iOS/Android), typically on port `18790`.

Defaults:
- enabled: `true`
- port: `18790`
- bind: `lan` (binds to `0.0.0.0`)

Bind modes:
- `lan`: `0.0.0.0` (reachable on any interface, including LAN/Wi‑Fi and Tailscale)
- `tailnet`: bind only to the machine’s Tailscale IP (recommended for Vienna ⇄ London)
- `loopback`: `127.0.0.1` (local only)
- `auto`: prefer tailnet IP if present, else `lan`

TLS:
- `bridge.tls.enabled`: enable TLS for bridge connections (TLS-only when enabled).
- `bridge.tls.autoGenerate`: generate a self-signed cert when no cert/key are present (default: true).
- `bridge.tls.certPath` / `bridge.tls.keyPath`: PEM paths for the bridge certificate + private key.
- `bridge.tls.caPath`: optional PEM CA bundle (custom roots or future mTLS).

When TLS is enabled, the Gateway advertises `bridgeTls=1` and `bridgeTlsSha256` in discovery TXT
records so nodes can pin the certificate. Manual connections use trust-on-first-use if no
fingerprint is stored yet.
Auto-generated certs require `openssl` on PATH; if generation fails, the bridge will not start.

```json5
{
  bridge: {
    enabled: true,
    port: 18790,
    bind: "tailnet",
    tls: {
      enabled: true,
      // Uses ~/.clawdbot/bridge/tls/bridge-{cert,key}.pem when omitted.
      // certPath: "~/.clawdbot/bridge/tls/bridge-cert.pem",
      // keyPath: "~/.clawdbot/bridge/tls/bridge-key.pem"
    }
  }
}
```

### `discovery.mdns` (Bonjour / mDNS broadcast mode)

Controls LAN mDNS discovery broadcasts (`_moltbot-gw._tcp`).

- `minimal` (default): omit `cliPath` + `sshPort` from TXT records
- `full`: include `cliPath` + `sshPort` in TXT records
- `off`: disable mDNS broadcasts entirely

```json5
{
  discovery: { mdns: { mode: "minimal" } }
}
```

### `discovery.wideArea` (Wide-Area Bonjour / unicast DNS‑SD)

When enabled, the Gateway writes a unicast DNS-SD zone for `_moltbot-bridge._tcp` under `~/.clawdbot/dns/` using the standard discovery domain `moltbot.internal.`

To make iOS/Android discover across networks (Vienna ⇄ London), pair this with:
- a DNS server on the gateway host serving `moltbot.internal.` (CoreDNS is recommended)
- Tailscale **split DNS** so clients resolve `moltbot.internal` via that server

One-time setup helper (gateway host):

```bash
moltbot dns setup --apply
```

```json5
{
  discovery: { wideArea: { enabled: true } }
}
```

## Template variables

Template placeholders are expanded in `tools.media.*.models[].args` and `tools.media.models[].args` (and any future templated argument fields).

| Variable | Description |
|----------|-------------|
| `{{Body}}` | Full inbound message body |
| `{{RawBody}}` | Raw inbound message body (no history/sender wrappers; best for command parsing) |
| `{{BodyStripped}}` | Body with group mentions stripped (best default for agents) |
| `{{From}}` | Sender identifier (E.164 for WhatsApp; may differ per channel) |
| `{{To}}` | Destination identifier |
| `{{MessageSid}}` | Channel message id (when available) |
| `{{SessionId}}` | Current session UUID |
| `{{IsNewSession}}` | `"true"` when a new session was created |
| `{{MediaUrl}}` | Inbound media pseudo-URL (if present) |
| `{{MediaPath}}` | Local media path (if downloaded) |
| `{{MediaType}}` | Media type (image/audio/document/…) |
| `{{Transcript}}` | Audio transcript (when enabled) |
| `{{Prompt}}` | Resolved media prompt for CLI entries |
| `{{MaxChars}}` | Resolved max output chars for CLI entries |
| `{{ChatType}}` | `"direct"` or `"group"` |
| `{{GroupSubject}}` | Group subject (best effort) |
| `{{GroupMembers}}` | Group members preview (best effort) |
| `{{SenderName}}` | Sender display name (best effort) |
| `{{SenderE164}}` | Sender phone number (best effort) |
| `{{Provider}}` | Provider hint (whatsapp|telegram|discord|googlechat|slack|signal|imessage|msteams|webchat|…) |

## Cron (Gateway scheduler)

Cron is a Gateway-owned scheduler for wakeups and scheduled jobs. See [Cron jobs](/automation/cron-jobs) for the feature overview and CLI examples.

```json5
{
  cron: {
    enabled: true,
    maxConcurrentRuns: 2
  }
}
```

---

*Next: [Agent Runtime](/concepts/agent)* 🦞
