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
**Status:** Experimental. Added in 2026.1.9.
</Note>

## Overview

Broadcast Groups enable multiple agents to process and respond to the same message simultaneously. This allows you to create specialized agent teams that work together in a single WhatsApp group or DM — all using one phone number.

Current scope: **WhatsApp only** (web channel).

Broadcast groups are evaluated after channel allowlists and group activation rules. In WhatsApp groups, this means broadcasts happen when OpenClaw would normally reply (for example: on mention, depending on your group settings).

## Use cases

<AccordionGroup>
  <Accordion title="1. Specialized agent teams">
    Deploy multiple agents with atomic, focused responsibilities:

    ```
    Group: "Development Team"
    Agents:
      - CodeReviewer (reviews code snippets)
      - DocumentationBot (generates docs)
      - SecurityAuditor (checks for vulnerabilities)
      - TestGenerator (suggests test cases)
    ```

    Each agent processes the same message and provides its specialized perspective.

  </Accordion>
  <Accordion title="2. Multi-language support">
    ```
    Group: "International Support"
    Agents:
      - Agent_EN (responds in English)
      - Agent_DE (responds in German)
      - Agent_ES (responds in Spanish)
    ```
  </Accordion>
  <Accordion title="3. Quality assurance workflows">
    ```
    Group: "Customer Support"
    Agents:
      - SupportAgent (provides answer)
      - QAAgent (reviews quality, only responds if issues found)
    ```
  </Accordion>
  <Accordion title="4. Task automation">
    ```
    Group: "Project Management"
    Agents:
      - TaskTracker (updates task database)
      - TimeLogger (logs time spent)
      - ReportGenerator (creates summaries)
    ```
  </Accordion>
</AccordionGroup>

## Configuration

### Basic setup

Add a top-level `broadcast` section (next to `bindings`). Keys are WhatsApp peer ids:

- group chats: group JID (e.g. `120363403215116621@g.us`)
- DMs: E.164 phone number (e.g. `+15551234567`)

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**Result:** When OpenClaw would reply in this chat, it will run all three agents.

### Processing strategy

Control how agents process messages:

<Tabs>
  <Tab title="parallel (default)">
    All agents process simultaneously:

    ```json
    {
      "broadcast": {
        "strategy": "parallel",
        "120363403215116621@g.us": ["alfred", "baerbel"]
      }
    }
    ```

  </Tab>
  <Tab title="sequential">
    Agents process in order (one waits for previous to finish):

    ```json
    {
      "broadcast": {
        "strategy": "sequential",
        "120363403215116621@g.us": ["alfred", "baerbel"]
      }
    }
    ```

  </Tab>
</Tabs>

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
  <Step title="Broadcast check">
    System checks if peer ID is in `broadcast`.
  </Step>
  <Step title="If in broadcast list">
    - All listed agents process the message.
    - Each agent has its own session key and isolated context.
    - Agents process in parallel (default) or sequentially.

  </Step>
  <Step title="If not in broadcast list">
    Normal routing applies (first matching binding).
  </Step>
</Steps>

<Note>
Broadcast groups do not bypass channel allowlists or group activation rules (mentions/commands/etc). They only change _which agents run_ when a message is eligible for processing.
</Note>

### Session isolation

Each agent in a broadcast group maintains completely separate:

- **Session keys** (`agent:alfred:whatsapp:group:120363...` vs `agent:baerbel:whatsapp:group:120363...`)
- **Conversation history** (agent doesn't see other agents' messages)
- **Workspace** (separate sandboxes if configured)
- **Tool access** (different allow/deny lists)
- **Memory/context** (separate IDENTITY.md, SOUL.md, etc.)
- **Group context buffer** (recent group messages used for context) is shared per peer, so all broadcast agents see the same context when triggered

This allows each agent to have:

- Different personalities
- Different tool access (e.g., read-only vs. read-write)
- Different models (e.g., opus vs. sonnet)
- Different skills installed

### Example: isolated sessions

In group `120363403215116621@g.us` with agents `["alfred", "baerbel"]`:

<Tabs>
  <Tab title="Alfred's context">
    ```
    Session: agent:alfred:whatsapp:group:120363403215116621@g.us
    History: [user message, alfred's previous responses]
    Workspace: /Users/user/openclaw-alfred/
    Tools: read, write, exec
    ```
  </Tab>
  <Tab title="Bärbel's context">
    ```
    Session: agent:baerbel:whatsapp:group:120363403215116621@g.us
    History: [user message, baerbel's previous responses]
    Workspace: /Users/user/openclaw-baerbel/
    Tools: read only
    ```
  </Tab>
</Tabs>

## Best practices

<AccordionGroup>
  <Accordion title="1. Keep agents focused">
    Design each agent with a single, clear responsibility:

    ```json
    {
      "broadcast": {
        "DEV_GROUP": ["formatter", "linter", "tester"]
      }
    }
    ```

    ✅ **Good:** Each agent has one job. ❌ **Bad:** One generic "dev-helper" agent.

  </Accordion>
  <Accordion title="2. Use descriptive names">
    Make it clear what each agent does:

    ```json
    {
      "agents": {
        "security-scanner": { "name": "Security Scanner" },
        "code-formatter": { "name": "Code Formatter" },
        "test-generator": { "name": "Test Generator" }
      }
    }
    ```

  </Accordion>
  <Accordion title="3. Configure different tool access">
    Give agents only the tools they need:

    ```json
    {
      "agents": {
        "reviewer": {
          "tools": { "allow": ["read", "exec"] } // Read-only
        },
        "fixer": {
          "tools": { "allow": ["read", "write", "edit", "exec"] } // Read-write
        }
      }
    }
    ```

  </Accordion>
  <Accordion title="4. Monitor performance">
    With many agents, consider:

    - Using `"strategy": "parallel"` (default) for speed
    - Limiting broadcast groups to 5-10 agents
    - Using faster models for simpler agents

  </Accordion>
  <Accordion title="5. Handle failures gracefully">
    Agents fail independently. One agent's error doesn't block others:

    ```
    Message → [Agent A ✓, Agent B ✗ error, Agent C ✓]
    Result: Agent A and C respond, Agent B logs error
    ```

  </Accordion>
</AccordionGroup>

## Compatibility

### Providers

Broadcast groups currently work with:

- ✅ WhatsApp (implemented)
- 🚧 Telegram (planned)
- 🚧 Discord (planned)
- 🚧 Slack (planned)

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

- `GROUP_A`: Only alfred responds (normal routing).
- `GROUP_B`: agent1 AND agent2 respond (broadcast).

<Note>
**Precedence:** `broadcast` takes priority over `bindings`.
</Note>

## Troubleshooting

<AccordionGroup>
  <Accordion title="Agents not responding">
    **Check:**

    1. Agent IDs exist in `agents.list`.
    2. Peer ID format is correct (e.g., `120363403215116621@g.us`).
    3. Agents are not in deny lists.

    **Debug:**

    ```bash
    tail -f ~/.openclaw/logs/gateway.log | grep broadcast
    ```

  </Accordion>
  <Accordion title="Only one agent responding">
    **Cause:** Peer ID might be in `bindings` but not `broadcast`.

    **Fix:** Add to broadcast config or remove from bindings.

  </Accordion>
  <Accordion title="Performance issues">
    If slow with many agents:

    - Reduce number of agents per group.
    - Use lighter models (sonnet instead of opus).
    - Check sandbox startup time.

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

    **User sends:** Code snippet.

    **Responses:**

    - code-formatter: "Fixed indentation and added type hints"
    - security-scanner: "⚠️ SQL injection vulnerability in line 12"
    - test-coverage: "Coverage is 45%, missing tests for error cases"
    - docs-checker: "Missing docstring for function `process_data`"

  </Accordion>
  <Accordion title="Example 2: Multi-language support">
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
  WhatsApp group JID, E.164 number, or other peer ID. Value is the array of agent IDs that should process messages.
</ParamField>

## Limitations

1. **Max agents:** No hard limit, but 10+ agents may be slow.
2. **Shared context:** Agents don't see each other's responses (by design).
3. **Message ordering:** Parallel responses may arrive in any order.
4. **Rate limits:** All agents count toward WhatsApp rate limits.

## Future enhancements

Planned features:

- [ ] Shared context mode (agents see each other's responses)
- [ ] Agent coordination (agents can signal each other)
- [ ] Dynamic agent selection (choose agents based on message content)
- [ ] Agent priorities (some agents respond before others)

## Related

- [Channel routing](/channels/channel-routing)
- [Groups](/channels/groups)
- [Multi-agent sandbox tools](/tools/multi-agent-sandbox-tools)
- [Pairing](/channels/pairing)
- [Session management](/concepts/session)
