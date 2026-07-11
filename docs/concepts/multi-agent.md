---
summary: "Multi-agent routing: agent boundaries, channel accounts, and bindings"
title: "Multi-agent routing"
sidebarTitle: "Multi-agent routing"
read_when: "You want multiple agents with separate workspaces, auth, and sessions in one Gateway process."
status: active
---

Run multiple _isolated_ agents in one Gateway process, each with its own workspace, state directory (`agentDir`), and SQLite-backed session history, plus multiple channel accounts (e.g. two WhatsApp numbers). Inbound messages route to the right agent through **bindings**.

An **agent** is the full per-persona scope: workspace files, auth profiles, model registry, and session store. A **binding** maps a channel account (a Slack workspace, a WhatsApp number, etc.) to one of those agents.

## What is one agent

Each agent has its own:

- **Workspace**: files, `AGENTS.md`/`SOUL.md`/`USER.md`, local notes, persona rules.
- **State directory** (`agentDir`): auth profiles, model registry, per-agent config.
- **Session store**: chat history and routing state in `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`.

Auth profiles are per-agent, read from:

```text
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

<Note>
`sessions_history` is the safer cross-session recall path: it returns a bounded, redacted view, not a raw transcript dump. It strips thinking-block signatures, tool-result payload details, `<relevant-memories>` scaffolding, tool-call XML tags (`<tool_call>`, `<function_call>`, and their plural/downgraded forms), and MiniMax tool-call XML, then truncates and caps output by byte size.
</Note>

<Warning>
Never reuse `agentDir` across agents — it causes auth/session state collisions. When a secondary agent's local OAuth credential is expired or its refresh fails, OpenClaw reads through to the default/main agent's credential for the same profile id and adopts whichever token is freshest, without copying the refresh token into the secondary agent's store. If you want a fully independent OAuth account, sign in from that agent. If you copy credentials manually, copy only portable static `api_key` or `token` profiles — OAuth refresh material is not portable by default (`copyToAgents` can opt a profile in explicitly).
</Warning>

Skills load from each agent workspace plus shared roots such as `~/.openclaw/skills`, then filter by the effective agent skill allowlist. Use `agents.defaults.skills` for a shared baseline and `agents.list[].skills` for a per-agent replacement (explicit entries replace the default, they do not merge). See [Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills) and [Skills: agent allowlists](/tools/skills#agent-allowlists).

Plugin-owned storage follows that plugin's configuration; adding a second agent
does not automatically split every global plugin store. For example, configure
[Memory Wiki per-agent vaults](/concepts/multi-agent#per-agent-memory-wiki-vaults)
when personas must not share compiled wiki knowledge.

<Note>
**Workspace note:** each agent's workspace is the **default cwd**, not a hard sandbox. Relative paths resolve inside the workspace, but absolute paths can reach other host locations unless sandboxing is enabled. See [Sandboxing](/gateway/sandboxing).
</Note>

## Paths

| What                             | Default                                                                                | Override                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Config                           | `~/.openclaw/openclaw.json`                                                            | `OPENCLAW_CONFIG_PATH`                                                                   |
| State dir                        | `~/.openclaw`                                                                          | `OPENCLAW_STATE_DIR`                                                                     |
| Default agent's workspace        | `~/.openclaw/workspace` (or `workspace-<profile>` when `OPENCLAW_PROFILE` is set)      | `agents.list[].workspace`, then `agents.defaults.workspace`, or `OPENCLAW_WORKSPACE_DIR` |
| Other agents' workspace          | `<stateDir>/workspace-<agentId>` (or `<agents.defaults.workspace>/<agentId>` when set) | `agents.list[].workspace`                                                                |
| Agent dir                        | `~/.openclaw/agents/<agentId>/agent`                                                   | `agents.list[].agentDir`                                                                 |
| Sessions and transcripts         | `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`                             | —                                                                                        |
| Legacy/archive session artifacts | `~/.openclaw/agents/<agentId>/sessions`                                                | —                                                                                        |

### Single-agent mode (default)

If you configure nothing, OpenClaw runs one agent:

- `agentId` defaults to `main`.
- Sessions key as `agent:main:<mainKey>` (default `mainKey` is `main`).
- Workspace defaults to `~/.openclaw/workspace` (or `workspace-<profile>` when `OPENCLAW_PROFILE` is set to something other than `default`).
- State defaults to `~/.openclaw/agents/main/agent`.

## Agent helper

Add a new isolated agent:

```bash
openclaw agents add work
```

Flags: `--workspace <dir>`, `--model <id>`, `--agent-dir <dir>`, `--bind <channel[:accountId]>` (repeatable), `--non-interactive` (requires `--workspace`).

Add `bindings` to route inbound messages (the wizard offers to do this for you), then verify:

```bash
openclaw agents list --bindings
```

## Quick start

<Steps>
  <Step title="Create each agent workspace">
    ```bash
    openclaw agents add coding
    openclaw agents add social
    ```

    Each agent gets its own workspace with `SOUL.md`, `AGENTS.md`, and optional `USER.md`, plus a dedicated `agentDir` and session store under `~/.openclaw/agents/<agentId>`.

  </Step>
  <Step title="Create channel accounts">
    Create one account per agent on your preferred channels:

    - Discord: one bot per agent, enable Message Content Intent, copy each token.
    - Telegram: one bot per agent via BotFather, copy each token.
    - WhatsApp: link each phone number per account.

    ```bash
    openclaw channels login --channel whatsapp --account work
    ```

    See channel guides: [Discord](/channels/discord), [Telegram](/channels/telegram), [WhatsApp](/channels/whatsapp).

  </Step>
  <Step title="Add agents, accounts, and bindings">
    Add agents under `agents.list`, channel accounts under `channels.<channel>.accounts`, and connect them with `bindings` (examples below).
  </Step>
  <Step title="Restart and verify">
    ```bash
    openclaw gateway restart
    openclaw agents list --bindings
    openclaw channels status --probe
    ```
  </Step>
</Steps>

## Multiple agents, multiple personas

Each configured `agentId` is a distinct persona boundary for core agent state:

- Different accounts per channel (per `accountId`).
- Different personalities (per-agent `AGENTS.md`/`SOUL.md`).
- Separate auth and sessions, with cross-agent access enabled only through explicit features or plugin configuration.

This lets multiple people share one Gateway while keeping core agent state separate.

## Per-agent Memory Wiki vaults

Memory Wiki uses one global vault by default. To keep a support agent's
compiled knowledge separate from a marketing agent's, set
`plugins.entries.memory-wiki.config.vault.scope` to `agent`:

```json5
{
  plugins: {
    entries: {
      "memory-wiki": {
        enabled: true,
        config: {
          vault: {
            scope: "agent",
            path: "~/.openclaw/wiki",
          },
        },
      },
    },
  },
}
```

The configured path is the parent directory. OpenClaw appends the normalized
agent id, producing paths such as `~/.openclaw/wiki/support` and
`~/.openclaw/wiki/marketing`. Agent-scoped CLI and Gateway operations require
an explicit agent when multiple agents are configured. See
[Memory Wiki per-agent vaults](/plugins/memory-wiki#per-agent-vaults) for bridge
filtering, migration, and trust-boundary details.

## Cross-agent QMD memory search

To let one agent search another agent's QMD session transcripts, add extra collections under `agents.list[].memorySearch.qmd.extraCollections`. Use `agents.defaults.memorySearch.qmd.extraCollections` when every agent should share the same collections.

```json5
{
  agents: {
    defaults: {
      workspace: "~/workspaces/main",
      memorySearch: {
        qmd: {
          extraCollections: [{ path: "~/agents/family/sessions", name: "family-sessions" }],
        },
      },
    },
    list: [
      {
        id: "main",
        workspace: "~/workspaces/main",
        memorySearch: {
          qmd: {
            extraCollections: [{ path: "notes" }], // resolves inside workspace -> collection named "notes-main"
          },
        },
      },
      { id: "family", workspace: "~/workspaces/family" },
    ],
  },
  memory: {
    backend: "qmd",
    qmd: { includeDefaultMemory: false },
  },
}
```

An extra-collection path can be shared across agents, but its `name` stays explicit when the path is outside the agent workspace. Paths inside the workspace stay agent-scoped so each agent keeps its own transcript search set.

## One WhatsApp number, multiple people (DM split)

Route different WhatsApp DMs to different agents on **one** WhatsApp account by matching sender E.164 (`+15551234567`) with `peer.kind: "direct"`. Replies still come from the same WhatsApp number — there is no per-agent sender identity.

<Note>
Direct chats collapse to the agent's main session key by default, so true isolation requires one agent per person.
</Note>

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    {
      agentId: "alex",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551230001" } },
    },
    {
      agentId: "mia",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551230002" } },
    },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

DM access control (pairing/allowlist) is global per WhatsApp account, not per agent. For shared groups, bind the group to one agent or use [Broadcast groups](/channels/broadcast-groups).

## Routing rules

Bindings are deterministic and most-specific wins. See [Channel routing](/channels/channel-routing#routing-rules-how-an-agent-is-chosen) for the full tier order (exact peer, parent peer, peer wildcard, guild+roles, guild, team, account, channel, default agent). A few rules worth calling out here:

- If multiple bindings match within the same tier, the first one in config order wins.
- If a binding sets multiple match fields (for example `peer` + `guildId`), all specified fields must match (`AND` semantics).
- A binding that omits `accountId` matches only the default account, not every account. Use `accountId: "*"` for a channel-wide fallback, or `accountId: "<name>"` for one account. Adding the same binding again with an explicit account id upgrades the existing channel-only binding instead of duplicating it.

## Multiple accounts / phone numbers

Channels that support multiple accounts (e.g. WhatsApp) use `accountId` to identify each login. Each `accountId` routes to its own agent, so one server can host multiple phone numbers without mixing sessions.

Set `channels.<channel>.defaultAccount` to choose the account used when `accountId` is omitted. When unset, OpenClaw falls back to `default` if present, otherwise the first configured account id (sorted).

Channels supporting multiple accounts: `discord`, `feishu`, `googlechat`, `imessage`, `irc`, `line`, `mattermost`, `matrix`, `nextcloud-talk`, `nostr`, `signal`, `slack`, `telegram`, `whatsapp`, `zalo`, `zalouser`.

## Concepts

- `agentId`: one "brain" (workspace, per-agent auth, per-agent session store).
- `accountId`: one channel account instance (e.g. WhatsApp account `personal` vs `biz`).
- `binding`: routes inbound messages to an `agentId` by `(channel, accountId, peer)`, and optionally guild/team ids.
- Direct chats collapse to `agent:<agentId>:<mainKey>` (per-agent "main"; see `session.mainKey`).

## Platform examples

<AccordionGroup>
  <Accordion title="Discord bots per agent">
    Each Discord bot account maps to a unique `accountId`. Bind each account to an agent and keep allowlists per bot.

    ```json5
    {
      agents: {
        list: [
          { id: "main", workspace: "~/.openclaw/workspace-main" },
          { id: "coding", workspace: "~/.openclaw/workspace-coding" },
        ],
      },
      bindings: [
        { agentId: "main", match: { channel: "discord", accountId: "default" } },
        { agentId: "coding", match: { channel: "discord", accountId: "coding" } },
      ],
      channels: {
        discord: {
          groupPolicy: "allowlist",
          accounts: {
            default: {
              token: "DISCORD_BOT_TOKEN_MAIN",
              guilds: {
                "123456789012345678": {
                  channels: {
                    "222222222222222222": { allow: true, requireMention: false },
                  },
                },
              },
            },
            coding: {
              token: "DISCORD_BOT_TOKEN_CODING",
              guilds: {
                "123456789012345678": {
                  channels: {
                    "333333333333333333": { allow: true, requireMention: false },
                  },
                },
              },
            },
          },
        },
      },
    }
    ```

    - Invite each bot to the guild and enable Message Content Intent.
    - Tokens live in `channels.discord.accounts.<id>.token` (default account can use `DISCORD_BOT_TOKEN`).

  </Accordion>
  <Accordion title="Telegram bots per agent">
    ```json5
    {
      agents: {
        list: [
          { id: "main", workspace: "~/.openclaw/workspace-main" },
          { id: "alerts", workspace: "~/.openclaw/workspace-alerts" },
        ],
      },
      bindings: [
        { agentId: "main", match: { channel: "telegram", accountId: "default" } },
        { agentId: "alerts", match: { channel: "telegram", accountId: "alerts" } },
      ],
      channels: {
        telegram: {
          accounts: {
            default: {
              botToken: "123456:ABC...",
              dmPolicy: "pairing",
            },
            alerts: {
              botToken: "987654:XYZ...",
              dmPolicy: "allowlist",
              allowFrom: ["tg:123456789"],
            },
          },
        },
      },
    }
    ```

    - Create one bot per agent with BotFather and copy each token.
    - Tokens live in `channels.telegram.accounts.<id>.botToken` (default account can use `TELEGRAM_BOT_TOKEN`).
    - For multiple bots in the same Telegram group, invite each bot and mention the one that should answer.
    - Disable BotFather Privacy Mode for each group bot (`/setprivacy` -> Disable), then remove and re-add the bot so Telegram applies the setting.
    - Allow groups with `channels.telegram.groups`, or use `groupPolicy: "open"` only for trusted group deployments.
    - Put sender user IDs in `groupAllowFrom`. Group and supergroup IDs belong in `channels.telegram.groups`, not `groupAllowFrom`.
    - Bind by `accountId` so each bot routes to its own agent.

  </Accordion>
  <Accordion title="WhatsApp numbers per agent">
    Link each account before starting the gateway:

    ```bash
    openclaw channels login --channel whatsapp --account personal
    openclaw channels login --channel whatsapp --account biz
    ```

    `~/.openclaw/openclaw.json` (JSON5):

    ```js
    {
      agents: {
        list: [
          {
            id: "home",
            default: true,
            name: "Home",
            workspace: "~/.openclaw/workspace-home",
            agentDir: "~/.openclaw/agents/home/agent",
          },
          {
            id: "work",
            name: "Work",
            workspace: "~/.openclaw/workspace-work",
            agentDir: "~/.openclaw/agents/work/agent",
          },
        ],
      },

      // Deterministic routing: first match wins (most-specific first).
      bindings: [
        { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
        { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

        // Optional per-peer override (example: send a specific group to work agent).
        {
          agentId: "work",
          match: {
            channel: "whatsapp",
            accountId: "personal",
            peer: { kind: "group", id: "1203630...@g.us" },
          },
        },
      ],

      // Off by default: agent-to-agent messaging must be explicitly enabled + allowlisted.
      tools: {
        agentToAgent: {
          enabled: false,
          allow: ["home", "work"],
        },
      },

      channels: {
        whatsapp: {
          accounts: {
            personal: {
              // Optional override. Default: ~/.openclaw/credentials/whatsapp/personal
              // authDir: "~/.openclaw/credentials/whatsapp/personal",
            },
            biz: {
              // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
              // authDir: "~/.openclaw/credentials/whatsapp/biz",
            },
          },
        },
      },
    }
    ```

  </Accordion>
</AccordionGroup>

## Common patterns

<Tabs>
  <Tab title="WhatsApp daily + Telegram deep work">
    Split by channel: route WhatsApp to a fast everyday agent and Telegram to an Opus agent.

    ```json5
    {
      agents: {
        list: [
          {
            id: "chat",
            name: "Everyday",
            workspace: "~/.openclaw/workspace-chat",
            model: "anthropic/claude-sonnet-4-6",
          },
          {
            id: "opus",
            name: "Deep Work",
            workspace: "~/.openclaw/workspace-opus",
            model: "anthropic/claude-opus-4-6",
          },
        ],
      },
      bindings: [
        { agentId: "chat", match: { channel: "whatsapp", accountId: "*" } },
        { agentId: "opus", match: { channel: "telegram", accountId: "*" } },
      ],
    }
    ```

    These examples use `accountId: "*"` so the bindings keep working if you add accounts later. To route a single DM/group to Opus while keeping the rest on chat, add a `match.peer` binding for that peer — peer matches always win over channel-wide rules.

  </Tab>
  <Tab title="Same channel, one peer to Opus">
    Keep WhatsApp on the fast agent, but route one DM to Opus:

    ```json5
    {
      agents: {
        list: [
          {
            id: "chat",
            name: "Everyday",
            workspace: "~/.openclaw/workspace-chat",
            model: "anthropic/claude-sonnet-4-6",
          },
          {
            id: "opus",
            name: "Deep Work",
            workspace: "~/.openclaw/workspace-opus",
            model: "anthropic/claude-opus-4-6",
          },
        ],
      },
      bindings: [
        {
          agentId: "opus",
          match: { channel: "whatsapp", accountId: "*", peer: { kind: "direct", id: "+15551234567" } },
        },
        { agentId: "chat", match: { channel: "whatsapp", accountId: "*" } },
      ],
    }
    ```

    Peer bindings always win, so keep them above the channel-wide rule.

  </Tab>
  <Tab title="Family agent bound to a WhatsApp group">
    Bind a dedicated family agent to a single WhatsApp group, with mention gating and a tighter tool policy:

    ```json5
    {
      agents: {
        list: [
          {
            id: "family",
            name: "Family",
            workspace: "~/.openclaw/workspace-family",
            identity: { name: "Family Bot" },
            groupChat: {
              mentionPatterns: ["@family", "@familybot", "@Family Bot"],
            },
            sandbox: {
              mode: "all",
              scope: "agent",
            },
            tools: {
              allow: [
                "exec",
                "read",
                "sessions_list",
                "sessions_history",
                "sessions_send",
                "sessions_spawn",
                "session_status",
              ],
              deny: ["write", "edit", "apply_patch", "browser", "canvas", "nodes", "cron"],
            },
          },
        ],
      },
      bindings: [
        {
          agentId: "family",
          match: {
            channel: "whatsapp",
            peer: { kind: "group", id: "120363999999999999@g.us" },
          },
        },
      ],
    }
    ```

    Tool allow/deny lists are **tools**, not skills. If a skill needs to run a binary, ensure `exec` is allowed and the binary exists in the sandbox. For stricter gating, set `agents.list[].groupChat.mentionPatterns` and keep group allowlists enabled for the channel.

  </Tab>
</Tabs>

## Per-agent sandbox and tool configuration

Each agent can have its own sandbox and tool restrictions:

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // No sandbox for personal agent
        },
        // No tool restrictions - all tools available
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // Always sandboxed
          scope: "agent",  // One container per agent
          docker: {
            // Optional one-time setup after container creation
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // Only read tool
          deny: ["exec", "write", "edit", "apply_patch"],    // Deny others
        },
      },
    ],
  },
}
```

<Note>
`setupCommand` lives under `sandbox.docker` and runs once on container creation. Per-agent `sandbox.docker.*` overrides are ignored when the resolved scope is `"shared"`.
</Note>

This gives you:

- **Security isolation**: restrict tools for untrusted agents.
- **Resource control**: sandbox specific agents while keeping others on host.
- **Flexible policies**: different permissions per agent.

<Note>
`tools.elevated` has both a global gate (`tools.elevated.enabled`/`allowFrom`) and a per-agent gate (`agents.list[].tools.elevated.enabled`/`allowFrom`). The per-agent gate can only further restrict the global one — both must allow a sender for elevated commands to run. For group targeting, use `agents.list[].groupChat.mentionPatterns` so @mentions map cleanly to the intended agent.
</Note>

See [Multi-agent sandbox and tools](/tools/multi-agent-sandbox-tools) for detailed examples.

## Related

- [ACP agents](/tools/acp-agents) — running external coding harnesses
- [Channel routing](/channels/channel-routing) — how messages route to agents
- [Presence](/concepts/presence) — agent presence and availability
- [Session](/concepts/session) — session isolation and routing
- [Sub-agents](/tools/subagents) — spawning background agent runs
