---
summary: "Broadcast a WhatsApp message to multiple agents"
read_when:
  - Configuring broadcast groups
  - Debugging multi-agent replies in WhatsApp
status: experimental
title: "Broadcast groups"
sidebarTitle: "Broadcast groups"
---

<Note>
**Status:** Experimental. Added in 2026.1.9. WhatsApp (web channel) only.
</Note>

## Overview

Broadcast groups run **multiple agents** on the same inbound message. Each agent processes the message in its own isolated session and posts its own reply, so one WhatsApp number can host a team of specialized agents in a single group chat or DM.

Broadcast groups are evaluated after channel allowlists and group activation rules. In WhatsApp groups, broadcasts happen when OpenClaw would normally reply (for example: on mention, depending on your group settings). They only change **which agents run**, never whether a message is eligible for processing.

The live WhatsApp QA lane includes `whatsapp-broadcast-group-fanout`, which verifies that one mentioned group message can produce distinct visible replies from two configured agents.

## Configuration

### Basic setup

Add a top-level `broadcast` section (next to `bindings`). Keys are WhatsApp peer ids, values are arrays of agent ids:

- group chats: group JID (e.g. `120363403215116621@g.us`)
- DMs: sender E.164 phone number (e.g. `+15551234567`)

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**Result:** when OpenClaw would reply in this chat, it runs all three agents.

Every listed agent id must exist in `agents.entries`: config validation reports unknown ids, and the runtime skips them with a `Broadcast agent <id> not found in agents.entries; skipping` warning.

### Processing strategy

`broadcast.strategy` sets how agents process the message:

| Strategy             | Behavior                                                              |
| -------------------- | --------------------------------------------------------------------- |
| `parallel` (default) | All agents process simultaneously; replies arrive in any order.       |
| `sequential`         | Agents process in array order; each waits for the previous to finish. |

```json
{
  "broadcast": {
    "strategy": "sequential",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

### Complete example

```json
{
  "agents": {
    "list": [
      {
        "id": "code-reviewer",
        "name": "Code Reviewer",
        "workspace": "/path/to/code-reviewer",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "security-auditor",
        "name": "Security Auditor",
        "workspace": "/path/to/security-auditor",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "docs-generator",
        "name": "Documentation Generator",
        "workspace": "/path/to/docs-generator",
        "sandbox": { "mode": "all" }
      }
    ]
  },
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["code-reviewer", "security-auditor", "docs-generator"],
    "120363424282127706@g.us": ["support-en", "support-de"],
    "+15555550123": ["assistant", "logger"]
  }
}
```

## How it works

### Message flow

<Steps>
  <Step title="Incoming message arrives">
    A WhatsApp group or DM message arrives.
  </Step>
  <Step title="Route and admission">
    OpenClaw applies channel allowlists, group activation rules, and configured ACP binding ownership.
  </Step>
  <Step title="Broadcast check">
    If no configured ACP binding owns the route, OpenClaw checks whether the peer ID is in `broadcast`.
  </Step>
  <Step title="If broadcast applies">
    - All listed agents process the message.
    - Each agent has its own session key and isolated context.
    - Agents process in parallel (default) or sequentially.
    - Audio attachments are transcribed once before fan-out, so agents share one transcript instead of making separate STT calls.

  </Step>
  <Step title="If broadcast does not apply">
    OpenClaw dispatches the ordinary route or the configured ACP session route selected during routing.
  </Step>
</Steps>

<Note>
Broadcast groups do not bypass channel allowlists or group activation rules (mentions/commands/etc). They only change _which agents run_ when a message is eligible for processing.
</Note>

### Session isolation

Each agent in a broadcast group maintains completely separate:

- **Session keys** (`agent:alfred:whatsapp:group:120363...` vs `agent:baerbel:whatsapp:group:120363...`)
- **Conversation history** (an agent does not see other agents' replies)
- **Workspace** (separate sandboxes if configured)
- **Tool access** (different allow/deny lists)
- **Memory/context** (separate `IDENTITY.md`, `SOUL.md`, etc.)

One exception is shared on purpose: the **group context buffer** (recent group messages used for context) is shared per peer, so all broadcast agents see the same context when triggered. It is cleared once after the fan-out completes.

This allows each agent to have different personalities, models, skills, and tool access (for example read-only vs. read-write).

### Example: isolated sessions

In group `120363403215116621@g.us` with agents `["alfred", "baerbel"]`:

<Tabs>
  <Tab title="Alfred's context">
    ```text
    Session: agent:alfred:whatsapp:group:120363403215116621@g.us
    History: [user message, alfred's previous responses]
    Workspace: ~/openclaw-alfred/
    Tools: read, write, exec
    ```
  </Tab>
  <Tab title="Baerbel's context">
    ```text
    Session: agent:baerbel:whatsapp:group:120363403215116621@g.us
    History: [user message, baerbel's previous responses]
    Workspace: ~/openclaw-baerbel/
    Tools: read only
    ```
  </Tab>
</Tabs>

## Use cases

- **Specialized agent teams**: a dev group where `code-reviewer`, `security-auditor`, `test-generator`, and `docs-checker` each answer the same message from their own angle.
- **Multi-language support**: one support chat with `support-en`, `support-de`, `support-es` responding in their languages.
- **Quality assurance**: `support-agent` answers while `qa-agent` reviews and only responds when it finds issues.
- **Task automation**: `task-tracker`, `time-logger`, and `report-generator` all consume the same status update.

## Best practices

<AccordionGroup>
  <Accordion title="1. Keep agents focused">
    Give each agent a single, clear responsibility (`formatter`, `linter`, `tester`) instead of one generic "dev-helper" agent.
  </Accordion>
  <Accordion title="2. Use descriptive ids and names">
    ```json
    {
      "agents": {
        "list": [
          { "id": "security-scanner", "name": "Security Scanner" },
          { "id": "code-formatter", "name": "Code Formatter" },
          { "id": "test-generator", "name": "Test Generator" }
        ]
      }
    }
    ```
  </Accordion>
  <Accordion title="3. Configure different tool access">
    ```json
    {
      "agents": {
        "list": [
          { "id": "reviewer", "tools": { "allow": ["read", "exec"] } },
          { "id": "fixer", "tools": { "allow": ["read", "write", "edit", "exec"] } }
        ]
      }
    }
    ```

    `reviewer` is read-only. `fixer` can read and write.

  </Accordion>
  <Accordion title="4. Monitor performance">
    With many agents, prefer `"strategy": "parallel"` (default), keep broadcast groups to a handful of agents, and use faster models for simpler agents.
  </Accordion>
  <Accordion title="5. Failures stay isolated">
    Agents fail independently. One agent's error is logged (`Broadcast agent <id> failed: ...`) and does not block the others.
  </Accordion>
</AccordionGroup>

## Compatibility

### Providers

Broadcast groups are currently implemented for WhatsApp (web channel) only. Other channels ignore the `broadcast` config.

### Routing

Broadcast groups work alongside existing routing:

```json
{
  "bindings": [
    {
      "match": { "channel": "whatsapp", "peer": { "kind": "group", "id": "GROUP_A" } },
      "agentId": "alfred"
    }
  ],
  "broadcast": {
    "GROUP_B": ["agent1", "agent2"]
  }
}
```

- `GROUP_A`: only alfred responds (normal routing).
- `GROUP_B`: agent1 AND agent2 respond (broadcast).

<Note>
**Precedence:** `broadcast` takes priority over ordinary route bindings. Configured ACP bindings (`bindings[].type="acp"`) are exclusive: when one matches, OpenClaw dispatches to the configured ACP session instead of fan-out broadcast.
</Note>

## Troubleshooting

<AccordionGroup>
  <Accordion title="Agents not responding">
    **Check:**

    1. Agent IDs exist in `agents.entries` (config validation rejects unknown ids).
    2. Peer ID format is correct (group JID like `120363403215116621@g.us`, or E.164 like `+15551234567` for DMs).
    3. The message passed normal gating (mention/activation rules still apply).

    **Debug:**

    ```bash
    openclaw logs --follow | grep -i broadcast
    ```

    A successful fan-out logs `Broadcasting message to <n> agents (<strategy>)`.

  </Accordion>
  <Accordion title="Only one agent responding">
    **Cause:** the peer ID might be in ordinary route bindings but not `broadcast`, or it might match an exclusive configured ACP binding.

    **Fix:** add ordinary route-bound peers to the broadcast config, or remove/change the configured ACP binding if fan-out broadcast is desired.

  </Accordion>
  <Accordion title="Performance issues">
    If slow with many agents: reduce the number of agents per group, use lighter models, and check sandbox startup time.
  </Accordion>
</AccordionGroup>

## Examples

<AccordionGroup>
  <Accordion title="Example 1: Code review team">
    ```json
    {
      "broadcast": {
        "strategy": "parallel",
        "120363403215116621@g.us": [
          "code-formatter",
          "security-scanner",
          "test-coverage",
          "docs-checker"
        ]
      },
      "agents": {
        "list": [
          {
            "id": "code-formatter",
            "workspace": "~/agents/formatter",
            "tools": { "allow": ["read", "write"] }
          },
          {
            "id": "security-scanner",
            "workspace": "~/agents/security",
            "tools": { "allow": ["read", "exec"] }
          },
          {
            "id": "test-coverage",
            "workspace": "~/agents/testing",
            "tools": { "allow": ["read", "exec"] }
          },
          { "id": "docs-checker", "workspace": "~/agents/docs", "tools": { "allow": ["read"] } }
        ]
      }
    }
    ```

    One code snippet in the group produces four replies: formatting fixes, a security finding, a coverage gap, and a docs nit.

  </Accordion>
  <Accordion title="Example 2: Multi-language pipeline">
    ```json
    {
      "broadcast": {
        "strategy": "sequential",
        "+15555550123": ["detect-language", "translator-en", "translator-de"]
      },
      "agents": {
        "list": [
          { "id": "detect-language", "workspace": "~/agents/lang-detect" },
          { "id": "translator-en", "workspace": "~/agents/translate-en" },
          { "id": "translator-de", "workspace": "~/agents/translate-de" }
        ]
      }
    }
    ```
  </Accordion>
</AccordionGroup>

## API reference

### Config schema

```typescript
interface OpenClawConfig {
  broadcast?: {
    strategy?: "parallel" | "sequential";
    [peerId: string]: string[];
  };
}
```

### Fields

<ParamField path="strategy" type='"parallel" | "sequential"' default='"parallel"'>
  How to process agents. `parallel` runs all agents simultaneously; `sequential` runs them in array order.
</ParamField>
<ParamField path="[peerId]" type="string[]">
  WhatsApp group JID or E.164 phone number. Value is the array of agent IDs that should all process messages from that peer.
</ParamField>

## Limitations

1. **Max agents:** no hard limit, but many agents (10+) can be slow.
2. **Shared context:** agents do not see each other's responses (by design).
3. **Message ordering:** parallel responses may arrive in any order.
4. **Rate limits:** all replies come from one WhatsApp account, so every agent's reply counts toward the same WhatsApp rate limits.

## Related

- [Channel routing](/channels/channel-routing)
- [Groups](/channels/groups)
- [Multi-agent sandbox tools](/tools/multi-agent-sandbox-tools)
- [Pairing](/channels/pairing)
- [Session management](/concepts/session)
