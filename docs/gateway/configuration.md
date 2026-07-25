---
summary: "Configuration overview: common tasks, quick setup, and links to the full reference"
read_when:
  - Setting up OpenClaw for the first time
  - Looking for common configuration patterns
  - Navigating to specific config sections
title: "Configuration"
---

OpenClaw reads an optional <Tooltip tip="JSON5 supports comments and trailing commas">**JSON5**</Tooltip> config from `~/.openclaw/openclaw.json`. If the file is missing, OpenClaw uses safe defaults.

The active config path must be a regular file. OpenClaw-owned writes replace it atomically (rename onto the path), so a symlinked `openclaw.json` gets its target replaced rather than written through - avoid symlinked config layouts. If you keep config outside the default state directory, point `OPENCLAW_CONFIG_PATH` directly at the real file.

Common reasons to add a config:

- Connect channels and control who can message the bot
- Set models, tools, sandboxing, or automation (cron, hooks)
- Tune sessions, media, networking, or UI

See the [full reference](/gateway/configuration-reference) for every available field.

Configuration follows a two-bucket rule: root siblings hold infrastructure and cross-agent defaults, while `agents.defaults` holds agent-loop behavior. Entries under `agents.entries` may override either bucket where the schema supports a per-agent override.

Agents and automation should use `config.schema.lookup` for exact field-level
docs before editing config. Use this page for task-oriented guidance and
[Configuration reference](/gateway/configuration-reference) for the broader
field map and defaults.

<Tip>
**New to configuration?** Start with `openclaw onboard` for interactive setup, or check out the [Configuration Examples](/gateway/configuration-examples) guide for complete copy-paste configs.
</Tip>

For launchers that need multiple independently owned, ordered inputs, see
[Configuration layers](/gateway/config-layers). Layers are opt-in, read-only,
and composed only when `--config-layer` is supplied.

## Minimal config

```json5
// ~/.openclaw/openclaw.json
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

## Editing config

<Tabs>
  <Tab title="Interactive wizard">
    ```bash
    openclaw onboard       # full onboarding flow
    openclaw configure     # config wizard
    ```
  </Tab>
  <Tab title="CLI (one-liners)">
    ```bash
    openclaw config get agents.defaults.workspace
    openclaw config set agents.defaults.heartbeat.every "2h"
    openclaw config unset plugins.entries.brave.config.webSearch.apiKey
    ```
  </Tab>
  <Tab title="Control UI">
    Open [http://127.0.0.1:18789](http://127.0.0.1:18789) and use the **Config** tab.
    The Control UI renders a form from the live config schema, including field
    `title` / `description` docs metadata plus plugin and channel schemas when
    available, with a **Raw JSON** editor as an escape hatch. For drill-down
    UIs and other tooling, the gateway also exposes `config.schema.lookup` to
    fetch one path-scoped schema node plus immediate child summaries.
    Settings show common fields first. Each section keeps its advanced fields
    in a collapsed **Advanced (N)** group; use **Show advanced** to expand all
    groups. Settings search always includes both tiers and opens the matching
    advanced group when needed.
  </Tab>
  <Tab title="Direct edit">
    Edit `~/.openclaw/openclaw.json` directly. The Gateway watches the file and applies changes automatically (see [hot reload](#config-hot-reload)).
  </Tab>
</Tabs>

## Strict validation

<Warning>
OpenClaw only accepts configurations that fully match the schema. Unknown keys, malformed types, or invalid values cause the Gateway to **refuse to start**. The only root-level exception is `$schema` (string), so editors can attach JSON Schema metadata.
</Warning>

`openclaw config schema` prints the canonical JSON Schema used by Control UI
and validation. `config.schema.lookup` fetches a single path-scoped node plus
child summaries for drill-down tooling. Field `title`/`description` docs metadata
carries through nested objects, wildcard (`*`), array-item (`[]`), and `anyOf`/
`oneOf`/`allOf` branches. Runtime plugin and channel schemas merge in when the
manifest registry is loaded.

Every config leaf has a common or advanced presentation tier in `uiHints`.
`advanced: false` marks common settings and `advanced: true` marks advanced
settings. A leaf inherits the nearest ancestor tier when it has no direct hint;
paths with no declared ancestor default to advanced. This affects presentation
only, not validation, defaults, reload behavior, or whether the key can be set.

When validation fails:

- The Gateway does not boot
- Only diagnostic commands work (`openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`)
- Run `openclaw doctor` to see exact issues
- Run `openclaw doctor --fix` (`--repair` is the same flag; `--yes` skips prompts) to apply repairs

The Gateway keeps a trusted last-known-good copy after each successful startup,
but startup and hot reload do not restore it automatically - only `openclaw doctor --fix`
does. If `openclaw.json` fails validation (including plugin-local validation), Gateway
startup fails or the reload is skipped and the current runtime keeps the last accepted
config. A rejected write is also saved as `<path>.rejected.<timestamp>` for inspection.
The Gateway blocks writes that look like accidental clobbers - dropping `gateway.mode`,
losing the `meta` block, or shrinking the file by more than half - unless the write
explicitly allows destructive changes. Promotion to last-known-good is skipped when a
candidate contains a redacted secret placeholder such as `***` or `[redacted]`.

## Common tasks

<AccordionGroup>
  <Accordion title="Set up a channel (WhatsApp, Telegram, Discord, etc.)">
    Each channel has its own config section under `channels.<provider>`. See the dedicated channel page for setup steps:

    - [Discord](/channels/discord) - `channels.discord`
    - [Feishu](/channels/feishu) - `channels.feishu`
    - [Google Chat](/channels/googlechat) - `channels.googlechat`
    - [iMessage](/channels/imessage) - `channels.imessage`
    - [Mattermost](/channels/mattermost) - `channels.mattermost`
    - [Microsoft Teams](/channels/msteams) - `channels.msteams`
    - [Signal](/channels/signal) - `channels.signal`
    - [Slack](/channels/slack) - `channels.slack`
    - [Telegram](/channels/telegram) - `channels.telegram`
    - [WhatsApp](/channels/whatsapp) - `channels.whatsapp`

    All channels share the same DM policy pattern:

    ```json5
    {
      channels: {
        telegram: {
          enabled: true,
          botToken: "123:abc",
          dmPolicy: "pairing",   // pairing | allowlist | open | disabled
          allowFrom: ["tg:123"], // only for allowlist/open
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Choose and configure models">
    Set the primary model and optional fallbacks:

    ```json5
    {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-6",
            fallbacks: ["openai/gpt-5.4"],
          },
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
            "openai/gpt-5.4": { alias: "GPT" },
          },
        },
      },
    }
    ```

    - `agents.defaults.models` stores aliases and per-model settings; adding an entry never restricts `/model` or `--model` overrides.
    - `agents.defaults.modelPolicy.allow` is the explicit allowlist for overrides and model pickers. It accepts exact refs and `provider/*` wildcards; omit it or use `[]` to allow any model.
    - Model refs use `provider/model` format (e.g. `anthropic/claude-opus-4-6`).
    - `agents.defaults.imageMaxDimensionPx` controls transcript/tool image downscaling (default `1200`); lower values usually reduce vision-token usage on screenshot-heavy runs.
    - See [Models CLI](/concepts/models) for switching models in chat and [Model Failover](/concepts/model-failover) for auth rotation and fallback behavior.
    - For custom/self-hosted providers, see [Custom providers](/gateway/config-tools#custom-providers-and-base-urls) in the reference.

  </Accordion>

  <Accordion title="Control who can message the bot">
    DM access is controlled per channel via `dmPolicy` (default `"pairing"`):

    - `"pairing"`: unknown senders get a one-time pairing code to approve
    - `"allowlist"`: only senders in `allowFrom` (or the paired allow store)
    - `"open"`: allow all inbound DMs (requires `allowFrom: ["*"]`)
    - `"disabled"`: ignore all DMs

    For groups, use `groupPolicy` (`"allowlist" | "open" | "disabled"`) plus `groupAllowFrom` or channel-specific allowlists.

    See the [full reference](/gateway/config-channels#dm-and-group-access) for per-channel details.

  </Accordion>

  <Accordion title="Set up group chat mention gating">
    Group messages default to **require mention**. Configure trigger patterns per agent. Normal group/channel replies post automatically; opt into the message-tool path for shared rooms where the agent should decide when to speak:

    ```json5
    {
      messages: {
        visibleReplies: "automatic", // set "message_tool" to require message-tool sends everywhere
        groupChat: {
          visibleReplies: "message_tool", // opt-in; visible output requires message(action=send)
          unmentionedInbound: "room_event", // unmentioned always-on group chatter is quiet context
        },
      },
      agents: {
        list: [
          {
            id: "main",
            groupChat: {
              mentionPatterns: ["@openclaw", "openclaw"],
            },
          },
        ],
      },
      channels: {
        whatsapp: {
          groups: { "*": { requireMention: true } },
        },
      },
    }
    ```

    - **Metadata mentions**: native @-mentions (WhatsApp tap-to-mention, Telegram @bot, etc.)
    - **Text patterns**: safe regex patterns in `mentionPatterns`
    - **Visible replies**: `messages.visibleReplies` can require message-tool sends globally; `messages.groupChat.visibleReplies` overrides that for groups/channels.
    - See [full reference](/gateway/config-channels#group-chat-mention-gating) for visible reply modes, per-channel overrides, and self-chat mode.

  </Accordion>

  <Accordion title="Restrict skills per agent">
    Use `agents.defaults.skills` for a shared baseline, then override specific
    agents with `agents.entries.*.skills`:

    ```json5
    {
      agents: {
        defaults: {
          skills: ["github", "weather"],
        },
        list: [
          { id: "writer" }, // inherits github, weather
          { id: "docs", skills: ["docs-search"] }, // replaces defaults
          { id: "locked-down", skills: [] }, // no skills
        ],
      },
    }
    ```

    - Omit `agents.defaults.skills` for unrestricted skills by default.
    - Omit `agents.entries.*.skills` to inherit the defaults.
    - Set `agents.entries.*.skills: []` for no skills.
    - See [Skills](/tools/skills), [Skills config](/tools/skills-config), and
      the [Configuration Reference](/gateway/config-agents#agents-defaults-skills).

  </Accordion>

  <Accordion title="Configure per-channel health monitoring">
    Disable or enable automatic health restarts for a channel or account:

    ```json5
    {
      channels: {
        telegram: {
          healthMonitor: { enabled: false },
          accounts: {
            alerts: {
              healthMonitor: { enabled: true },
            },
          },
        },
      },
    }
    ```

    - Use `channels.<provider>.healthMonitor.enabled` or `channels.<provider>.accounts.<id>.healthMonitor.enabled` to control auto-restarts for one channel or account.
    - See [Health Checks](/gateway/health) for operational debugging and the [full reference](/gateway/configuration-reference#gateway) for all fields.

  </Accordion>

  <Accordion title="Configure sessions and resets">
    Sessions control conversation continuity and isolation:

    ```json5
    {
      session: {
        dmScope: "per-channel-peer",  // recommended for multi-user
        threadBindings: {
          enabled: true,
          idleHours: 24,
          maxAgeHours: 0,
        },
        reset: {
          mode: "daily",
          atHour: 4,
          idleMinutes: 120,
        },
      },
    }
    ```

    - `dmScope`: `main` (shared) | `per-peer` | `per-channel-peer` | `per-account-channel-peer`
    - `threadBindings`: global defaults for thread-bound session routing. `/focus`, `/unfocus`, `/agents`, `/session idle`, and `/session max-age` bind, unbind, list, and tune this per session (Discord binds threads, Telegram binds topics/conversations).
    - See [Session Management](/concepts/session) for scoping, identity links, and send policy.
    - See [full reference](/gateway/config-agents#session) for all fields.

  </Accordion>

  <Accordion title="Enable sandboxing">
    Run agent sessions in isolated sandbox runtimes:

    ```json5
    {
      agents: {
        defaults: {
          sandbox: {
            mode: "non-main",  // off | non-main | all
            scope: "agent",    // session | agent | shared
          },
        },
      },
    }
    ```

    Build the image first - from a source checkout run `scripts/sandbox-setup.sh`, or from an npm install see the inline `docker build` command in [Sandboxing § Images and setup](/gateway/sandboxing#images-and-setup).

    See [Sandboxing](/gateway/sandboxing) for the full guide and [full reference](/gateway/config-agents#agentsdefaultssandbox) for all options.

  </Accordion>

  <Accordion title="Enable relay-backed push for official iOS builds">
    Relay-backed push for public App Store builds uses the hosted OpenClaw relay: `https://ios-push-relay.openclaw.ai`.

    Custom relay deployments require a deliberately separate iOS build/deployment path whose relay URL matches the gateway relay URL. If you are using a custom relay build, set this in gateway config:

    ```json5
    {
      gateway: {
        push: {
          apns: {
            relay: {
              baseUrl: "https://relay.example.com",
              // Optional. Default: 10000
              timeoutMs: 10000,
            },
          },
        },
      },
    }
    ```

    CLI equivalent:

    ```bash
    openclaw config set gateway.push.apns.relay.baseUrl https://relay.example.com
    ```

    What this does:

    - Lets the gateway send `push.test`, wake nudges, and reconnect wakes through the external relay.
    - Uses a registration-scoped send grant forwarded by the paired iOS app. The gateway does not need a deployment-wide relay token.
    - Binds each relay-backed registration to the gateway identity that the iOS app paired with, so another gateway cannot reuse the stored registration.
    - Keeps local/manual iOS builds on direct APNs. Relay-backed sends apply only to official distributed builds that registered through the relay.
    - Must match the relay base URL baked into the iOS build, so registration and send traffic reach the same relay deployment.

    End-to-end flow:

    1. Install the official iOS app.
    2. Optional: configure `gateway.push.apns.relay.baseUrl` on the gateway only when using a deliberately separate custom relay build.
    3. Pair the iOS app to the gateway and let both node and operator sessions connect.
    4. The iOS app fetches the gateway identity, registers with the relay using App Attest plus the app receipt, and then publishes the relay-backed `push.apns.register` payload to the paired gateway.
    5. The gateway stores the relay handle and send grant, then uses them for `push.test`, wake nudges, and reconnect wakes.

    Operational notes:

    - If you switch the iOS app to a different gateway, reconnect the app so it can publish a new relay registration bound to that gateway.
    - If you ship a new iOS build that points at a different relay deployment, the app refreshes its cached relay registration instead of reusing the old relay origin.

    Compatibility note:

    - `OPENCLAW_APNS_RELAY_BASE_URL` and `OPENCLAW_APNS_RELAY_TIMEOUT_MS` still work as temporary env overrides.
    - Custom gateway relay URLs must match the relay base URL baked into the iOS build; the public App Store release lane rejects custom iOS relay URL overrides.
    - `OPENCLAW_APNS_RELAY_ALLOW_HTTP=true` remains a loopback-only development escape hatch; do not persist HTTP relay URLs in config.

    See [iOS App](/platforms/ios#relay-backed-push-for-official-builds) for the end-to-end flow and [Authentication and trust flow](/platforms/ios#authentication-and-trust-flow) for the relay security model.

  </Accordion>

  <Accordion title="Set up heartbeat (periodic check-ins)">
    ```json5
    {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            target: "last",
          },
        },
      },
    }
    ```

    - `every`: duration string (`30m`, `2h`). Set `0m` to disable. Default: `30m`.
    - `target`: `last` | `none` | `<channel-id>` (for example `discord`, `matrix`, `telegram`, or `whatsapp`)
    - `directPolicy`: `allow` (default) or `block` for DM-style heartbeat targets
    - See [Heartbeat](/gateway/heartbeat) for the full guide.

  </Accordion>

  <Accordion title="Configure cron jobs">
    ```json5
    {
      cron: {
        enabled: true,
        sessionRetention: "24h",
      },
    }
    ```

    - `sessionRetention`: prune completed isolated run sessions from SQLite session rows (default `24h`; set `false` to disable).
    - Run history automatically keeps the newest 2000 terminal rows per job; lost rows retain their 24-hour cleanup window.
    - See [Cron jobs](/automation/cron-jobs) for feature overview and CLI examples.

  </Accordion>

  <Accordion title="Set up webhooks (hooks)">
    Enable HTTP webhook endpoints on the Gateway:

    ```json5
    {
      hooks: {
        enabled: true,
        token: "shared-secret",
        path: "/hooks",
        defaultSessionKey: "hook:ingress",
        allowRequestSessionKey: false,
        allowedSessionKeyPrefixes: ["hook:"],
        mappings: [
          {
            match: { path: "gmail" },
            action: "agent",
            agentId: "main",
            deliver: true,
          },
        ],
      },
    }
    ```

    Security note:
    - Treat all hook/webhook payload content as untrusted input.
    - Use a dedicated `hooks.token`; do not reuse active Gateway auth secrets (`gateway.auth.token` / `OPENCLAW_GATEWAY_TOKEN` or `gateway.auth.password` / `OPENCLAW_GATEWAY_PASSWORD`).
    - Hook auth is header-only (`Authorization: Bearer ...` or `x-openclaw-token`); query-string tokens are rejected.
    - `hooks.path` cannot be `/`; keep webhook ingress on a dedicated subpath such as `/hooks`.
    - Keep unsafe-content bypass flags disabled (`hooks.gmail.allowUnsafeExternalContent`, `hooks.mappings[].allowUnsafeExternalContent`) unless doing tightly scoped debugging.
    - If you enable `hooks.allowRequestSessionKey`, also set `hooks.allowedSessionKeyPrefixes` to bound caller-selected session keys.
    - For hook-driven agents, prefer strong modern model tiers and strict tool policy (for example messaging-only plus sandboxing where possible).

    See [full reference](/gateway/configuration-reference#hooks) for all mapping options and Gmail integration.

  </Accordion>

  <Accordion title="Configure multi-agent routing">
    Run multiple isolated agents with separate workspaces and sessions:

    ```json5
    {
      agents: {
        list: [
          { id: "home", default: true, workspace: "~/.openclaw/workspace-home" },
          { id: "work", workspace: "~/.openclaw/workspace-work" },
        ],
      },
      bindings: [
        { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
        { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
      ],
    }
    ```

    See [Multi-Agent](/concepts/multi-agent) and [full reference](/gateway/config-agents#multi-agent-routing) for binding rules and per-agent access profiles.

  </Accordion>

  <Accordion title="Split config into multiple files ($include)">
    Use `$include` to organize large configs:

    ```json5
    // ~/.openclaw/openclaw.json
    {
      gateway: { port: 18789 },
      agents: { $include: "./agents.json5" },
      broadcast: {
        $include: ["./clients/a.json5", "./clients/b.json5"],
      },
    }
    ```

    - **Single file**: replaces the containing object
    - **Array of files**: deep-merged in order (later wins), up to 10 nested levels deep
    - **Sibling keys**: merged after includes (override included values)
    - **Relative paths**: resolved relative to the including file
    - **Path format**: include paths must not contain null bytes and must be strictly shorter than 4096 characters before and after resolution
    - **OpenClaw-owned writes**: when a write changes only one top-level section
      backed by a single-file include such as `plugins: { $include: "./plugins.json5" }`,
      OpenClaw updates that included file and leaves `openclaw.json` intact
    - **Unsupported write-through**: root includes, include arrays, and includes
      with sibling overrides fail closed for OpenClaw-owned writes instead of
      flattening the config
    - **Confinement**: `$include` paths must resolve under the directory holding
      `openclaw.json`. To share a tree across machines or users, set
      `OPENCLAW_INCLUDE_ROOTS` to a path-list (`:` on POSIX, `;` on Windows) of
      additional directories that includes may reference. Symlinks are resolved
      and re-checked, so a path that lexically lives in a config dir but whose
      real target escapes every allowed root is still rejected.
    - **Error handling**: clear errors for missing files, parse errors, circular includes, invalid path format, and excessive length

  </Accordion>
</AccordionGroup>

## Config hot reload

The Gateway watches `~/.openclaw/openclaw.json` and applies changes automatically - no manual restart needed for most settings.

Direct file edits are treated as untrusted until they validate. The watcher waits
for editor temp-write/rename churn to settle, reads the final file, and rejects
invalid external edits without rewriting `openclaw.json`. OpenClaw-owned config
writes use the same schema gate before writing (see [Strict validation](#strict-validation)
for the clobber/rollback rules that apply to every write).

If you see `config reload skipped (invalid config)` or startup reports `Invalid
config`, inspect the config, run `openclaw config validate`, then run `openclaw
doctor --fix` for repair. See [Gateway troubleshooting](/gateway/troubleshooting#gateway-rejected-invalid-config)
for the checklist.

### Reload modes

| Mode                   | Behavior                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------- |
| **`hybrid`** (default) | Hot-applies safe changes instantly. Automatically restarts for critical ones.           |
| **`hot`**              | Hot-applies safe changes only. Logs a warning when a restart is needed - you handle it. |
| **`restart`**          | Restarts the Gateway on any config change, safe or not.                                 |
| **`off`**              | Disables file watching. Changes take effect on the next manual restart.                 |

```json5
{
  gateway: {
    reload: { mode: "hybrid", debounceMs: 300 },
  },
}
```

### What hot-applies vs what needs a restart

Most fields hot-apply without downtime; some hot-applied sections restart just that
subsystem (channel, cron, heartbeat, health monitor) rather than the whole Gateway. In
`hybrid` mode, Gateway-restart-required changes are handled automatically.

| Category            | Fields                                                                  | Gateway restart needed?      |
| ------------------- | ----------------------------------------------------------------------- | ---------------------------- |
| Channels            | `channels.*`, `web` (WhatsApp) - all built-in and plugin channels       | No (restarts that channel)   |
| Agent & models      | `agent`, `agents`, `models`, `routing`                                  | No                           |
| Automation          | `hooks`, `cron`, `agent.heartbeat`                                      | No (restarts that subsystem) |
| Sessions & messages | `session`, `messages`                                                   | No                           |
| Tools & media       | `tools`, `skills`, `mcp`, `audio`, `talk`                               | No                           |
| Plugin config       | `plugins.entries.*`, `plugins.allow`, `plugins.deny`, `plugins.enabled` | No (reloads plugin runtime)  |
| UI & misc           | `ui`, `logging`, `identity`, `bindings`                                 | No                           |
| Gateway server      | `gateway.*` (port, bind, auth, tailscale, TLS, HTTP, push)              | **Yes**                      |
| Infrastructure      | `discovery`, `browser`, `plugins.load`, `plugins.installs`              | **Yes**                      |

<Note>
`gateway.reload` and `gateway.remote` are exceptions under `gateway.*` - changing them does **not** trigger a restart. Individual plugins can also override this table: a loaded plugin may declare its own restart-triggering config prefixes (for example the bundled Canvas plugin restarts the Gateway for `plugins.enabled`, `plugins.allow`, and `plugins.deny`, not just its own `plugins.entries.canvas`), so the actual behavior depends on which plugins are active.
</Note>

### Reload planning

When you edit a source file that is referenced through `$include`, OpenClaw plans
the reload from the source-authored layout, not the flattened in-memory view.
That keeps hot-reload decisions (hot-apply vs restart) predictable even when a
single top-level section lives in its own included file such as
`plugins: { $include: "./plugins.json5" }`. Reload planning fails closed if the
source layout is ambiguous.

## Config RPC (programmatic updates)

For tooling that writes config over the gateway API, prefer this flow:

- `config.schema.lookup` to inspect one subtree (shallow schema node + child
  summaries)
- `config.get` to fetch the current snapshot plus `hash`
- `config.patch` for partial updates (JSON merge patch: objects merge, `null`
  deletes, arrays replace when explicitly confirmed with `replacePaths` if
  entries would be removed)
- `config.apply` only when you intend to replace the entire config
- `update.run` for explicit self-update plus restart; include `continuationMessage` when the post-restart session should run one follow-up turn
- `update.status` to inspect the latest update restart sentinel and verify the running version after a restart

Agents should treat `config.schema.lookup` as the first stop for exact
field-level docs and constraints. Use [Configuration reference](/gateway/configuration-reference)
when they need the broader config map, defaults, or links to dedicated
subsystem references.

<Note>
Control-plane writes (`config.apply`, `config.patch`, `update.run`) are
rate-limited to 30 requests per 60 seconds, per method, per
`deviceId+clientIp`; see [Rate limiting](/gateway/security/rate-limiting). Restart
requests coalesce and then enforce a 30-second cooldown between restart cycles.
`update.status` is read-only but admin-scoped because the restart sentinel can
include update step summaries and command output tails.
</Note>

Example partial patch:

```bash
openclaw gateway call config.get --params '{}'  # capture payload.hash
openclaw gateway call config.patch --params '{
  "raw": "{ channels: { telegram: { groups: { \"*\": { requireMention: false } } } } }",
  "baseHash": "<hash>"
}'
```

Both `config.apply` and `config.patch` accept `raw`, `baseHash`, `sessionKey`,
`note`, and `restartDelayMs`. `baseHash` is required for both methods once a
config file already exists (a first write with no existing config skips the check).

`config.patch` also accepts `replacePaths`, an array of config paths whose array
replacement is intentional. If a patch would replace or delete an existing array
with fewer entries, the Gateway rejects the write unless that exact path appears
in `replacePaths`; nested arrays under array entries use `[]`, such as
`agents.entries.*.skills`. This prevents truncated `config.get` snapshots from
silently clobbering routing or allowlist arrays. Use `config.apply` when you
intend to replace the full config.

## Environment variables

OpenClaw reads env vars from the parent process plus:

- `.env` from the current working directory (if present)
- `~/.openclaw/.env` (global fallback)

Neither file overrides existing env vars. You can also set inline env vars in config:

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

<Accordion title="Shell env import (optional)">
  If enabled and expected keys aren't set, OpenClaw runs your login shell and imports only the missing keys:

```json5
{
  env: {
    shellEnv: { enabled: true, timeoutMs: 15000 },
  },
}
```

Env var equivalent: `OPENCLAW_LOAD_SHELL_ENV=1`. Default `timeoutMs`: `15000`.
</Accordion>

<Accordion title="Env var substitution in config values">
  Reference env vars in any config string value with `${VAR_NAME}`:

```json5
{
  gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
  models: { providers: { custom: { apiKey: "${CUSTOM_API_KEY}" } } },
}
```

Rules:

- Only uppercase names matched: `[A-Z_][A-Z0-9_]*`
- Missing/empty vars throw an error at load time
- Escape with `$${VAR}` for literal output
- Works inside `$include` files
- Inline substitution: `"${BASE}/v1"` → `"https://api.example.com/v1"`

</Accordion>

<Accordion title="Secret refs (env, file, exec)">
  For fields that support SecretRef objects, you can use:

```json5
{
  models: {
    providers: {
      openai: { apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" } },
    },
  },
  skills: {
    entries: {
      "image-lab": {
        apiKey: {
          source: "file",
          provider: "filemain",
          id: "/skills/entries/image-lab/apiKey",
        },
      },
    },
  },
  channels: {
    googlechat: {
      serviceAccount: {
        source: "exec",
        provider: "vault",
        id: "channels/googlechat/serviceAccount",
      },
    },
  },
}
```

SecretRef details (including `secrets.providers` for `env`/`file`/`exec`) are in [Secrets Management](/gateway/secrets).
Supported credential paths are listed in [SecretRef Credential Surface](/reference/secretref-credential-surface).
</Accordion>

See [Environment](/help/environment) for full precedence and sources.

## Full reference

For the complete field-by-field reference, see **[Configuration Reference](/gateway/configuration-reference)**.

---

_Related: [Configuration Examples](/gateway/configuration-examples) · [Configuration Reference](/gateway/configuration-reference) · [Doctor](/gateway/doctor)_

## Related

- [Configuration reference](/gateway/configuration-reference)
- [Configuration examples](/gateway/configuration-examples)
- [Gateway runbook](/gateway)
