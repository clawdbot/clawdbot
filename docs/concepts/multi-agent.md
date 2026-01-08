---
summary: "Multi-agent routing: isolated agents, provider accounts, and bindings"
title: Multi-Agent Routing
read_when: "You want multiple isolated agents (workspaces + auth) in one gateway process."
status: active
---

# Multi-Agent Routing

Goal: multiple *isolated* agents (separate workspace + `agentDir` + sessions), plus multiple provider accounts (e.g. two WhatsApps) in one running Gateway. Inbound is routed to an agent via bindings.

## What is “one agent”?

An **agent** is a fully scoped brain with its own:

- **Workspace** (files, AGENTS.md/SOUL.md/USER.md, local notes, persona rules).
- **State directory** (`agentDir`) for auth profiles, model registry, and per-agent config.
- **Session store** (chat history + routing state) under `~/.clawdbot/agents/<agentId>/sessions`.

The Gateway can host **one agent** (default) or **many agents** side-by-side.

## Paths (quick map)

- Config: `~/.clawdbot/clawdbot.json` (or `CLAWDBOT_CONFIG_PATH`)
- State dir: `~/.clawdbot` (or `CLAWDBOT_STATE_DIR`)
- Workspace: `~/clawd` (or `~/clawd-<agentId>`)
- Agent dir: `~/.clawdbot/agents/<agentId>/agent` (or `routing.agents.<agentId>.agentDir`)
- Sessions: `~/.clawdbot/agents/<agentId>/sessions`

### Single-agent mode (default)

If you do nothing, Clawdbot runs a single agent:

- `agentId` defaults to **`main`**.
- Sessions are keyed as `agent:main:<mainKey>`.
- Workspace defaults to `~/clawd` (or `~/clawd-<profile>` when `CLAWDBOT_PROFILE` is set).
- State defaults to `~/.clawdbot/agents/main/agent`.

## Agent helper

Use the agent wizard to add a new isolated agent:

```bash
clawdbot agents add work
```

Then add `routing.bindings` (or let the wizard do it) to route inbound messages.

Verify with:

```bash
clawdbot agents list --bindings
```

## Multiple agents = multiple people, multiple personalities

With **multiple agents**, each `agentId` becomes a **fully isolated persona**:

- **Different phone numbers/accounts** (per provider `accountId`).
- **Different personalities** (per-agent workspace files like `AGENTS.md` and `SOUL.md`).
- **Separate auth + sessions** (no cross-talk unless explicitly enabled).

This lets **multiple people** share one Gateway server while keeping their AI “brains” and data isolated.

## Routing rules (how messages pick an agent)

Bindings are **deterministic** and **most-specific wins**:

1. `peer` match (exact DM/group/channel id)
2. `guildId` (Discord)
3. `teamId` (Slack)
4. `accountId` match for a provider
5. provider-level match (`accountId: "*"`)
6. fallback to `routing.defaultAgentId` (default: `main`)

## Multiple accounts / phone numbers

Providers that support **multiple accounts** (e.g. WhatsApp) use `accountId` to identify
each login. Each `accountId` can be routed to a different agent, so one server can host
multiple phone numbers without mixing sessions.

## Concepts

- `agentId`: one “brain” (workspace, per-agent auth, per-agent session store).
- `accountId`: one provider account instance (e.g. WhatsApp account `"personal"` vs `"biz"`).
- `binding`: routes inbound messages to an `agentId` by `(provider, accountId, peer)` and optionally guild/team ids.
- Direct chats collapse to `agent:<agentId>:<mainKey>` (per-agent “main”; `session.mainKey`).

## Example: two WhatsApps → two agents

`~/.clawdbot/clawdbot.json` (JSON5):

```js
{
  routing: {
    defaultAgentId: "home",

    agents: {
      home: {
        name: "Home",
        workspace: "~/clawd-home",
        agentDir: "~/.clawdbot/agents/home/agent",
      },
      work: {
        name: "Work",
        workspace: "~/clawd-work",
        agentDir: "~/.clawdbot/agents/work/agent",
      },
    },

    // Deterministic routing: first match wins (most-specific first).
    bindings: [
      { agentId: "home", match: { provider: "whatsapp", accountId: "personal" } },
      { agentId: "work", match: { provider: "whatsapp", accountId: "biz" } },

      // Optional per-peer override (example: send a specific group to work agent).
      {
        agentId: "work",
        match: {
          provider: "whatsapp",
          accountId: "personal",
          peer: { kind: "group", id: "1203630...@g.us" },
        },
      },
    ],

    // Off by default: agent-to-agent messaging must be explicitly enabled + allowlisted.
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },

  whatsapp: {
    accounts: {
      personal: {
        // Optional override. Default: ~/.clawdbot/credentials/whatsapp/personal
        // authDir: "~/.clawdbot/credentials/whatsapp/personal",
      },
      biz: {
        // Optional override. Default: ~/.clawdbot/credentials/whatsapp/biz
        // authDir: "~/.clawdbot/credentials/whatsapp/biz",
      },
    },
  },
}
```

## Per-Agent Sandbox and Tool Configuration

Starting with v2026.1.6, each agent can have its own sandbox and tool restrictions:

```js
{
  routing: {
    agents: {
      personal: {
        workspace: "~/clawd-personal",
        sandbox: {
          mode: "off",  // No sandbox for personal agent
        },
        // No tool restrictions - all tools available
      },
      family: {
        workspace: "~/clawd-family",
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
          deny: ["bash", "write", "edit"],    // Deny others
        },
      },
    },
  },
}
```

**Benefits:**
- **Security isolation**: Restrict tools for untrusted agents
- **Resource control**: Sandbox specific agents while keeping others on host
- **Flexible policies**: Different permissions per agent

See [Multi-Agent Sandbox & Tools](/multi-agent-sandbox-tools) for detailed examples.
