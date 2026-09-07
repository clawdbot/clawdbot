---
summary: "Run bounded agent group threads across messaging channels"
read_when:
  - Configuring broadcast groups
  - Configuring bounded agent group threads
  - Debugging multi-agent replies across channels
status: experimental
title: "Broadcast groups"
sidebarTitle: "Broadcast groups"
---

<Note>
**Status:** Experimental. Legacy WhatsApp broadcast arrays remain supported.
</Note>

## Overview

Agent group threads run **multiple agents** on the same inbound message, using the top-level `broadcast` config. Each agent runs in its own session. Channel-qualified entries can select participants by mention and allow a bounded number of follow-up rounds so agents can build on sibling replies.

Channel allowlists and group activation rules still apply. For qualified entries on Discord, Slack, and Telegram, an explicit mention of any configured participant can satisfy the room’s mention gate, even when that participant is not the ordinary routed agent. Legacy WhatsApp entries keep their existing admission behavior.

The live WhatsApp QA lane includes `whatsapp-broadcast-group-fanout`, which verifies that one mentioned group message can produce distinct visible replies from two configured agents.

## Configuration

### Agent group threads

Use a key in the form `"<channel>:<peerId>"`, such as
`"discord:123456789"`, `"slack:C0123"`, `"telegram:-100123"`, or
`"whatsapp:1203@g.us"`. The value can be an agent ID array or a strict object:

```json5
{
  agents: {
    entries: {
      reviewer: {
        name: "Reviewer",
        groupChat: { mentionPatterns: ["@reviewer\\b"] },
      },
      writer: {
        name: "Writer",
        groupChat: { mentionPatterns: ["@writer\\b"] },
      },
    },
  },
  bindings: [{ agentId: "reviewer", match: { channel: "telegram" } }],
  broadcast: {
    "telegram:-100123": {
      agents: ["reviewer", "writer"],
      mentionGating: true,
      maxRounds: 2,
      maxTurns: 4,
    },
  },
}
```

The ordinary channel route still needs an agent; the binding above selects
Reviewer for admission before group dispatch. After the room is allowed by its
channel config, send `@reviewer @writer Review
this draft`. Both participants can answer the initial message and, within the
budget, add something new in one follow-up round. Send `@writer` to select only
Writer for the initial round.

| Object field    | Default         | Contract                                                                       |
| --------------- | --------------- | ------------------------------------------------------------------------------ |
| `agents`        | Required        | Configured agent IDs; at most 16 participants.                                 |
| `mentionGating` | `true`          | Select explicitly mentioned participants; if none match, select all.           |
| `maxRounds`     | `1`             | Integer from 1 to 4, including the initial round.                              |
| `maxTurns`      | `agents.length` | Integer from 1 to 32; total participant turns started for one inbound message. |

Unknown object fields are rejected. Qualified arrays use the same defaults:
`"slack:C0123": ["reviewer", "writer"]` runs one initial round with mention
selection. A qualified WhatsApp key takes precedence over an unqualified key
for the same peer. Unqualified object entries are not supported.

`maxTurns` counts **agent runs started by the coordinator**, including runs
that pass or fail. Slots are reserved synchronously before parallel launch, so
parallel participants cannot overspend the budget. If the budget is smaller
than the eligible participant count, configured order determines which turns
start. A turn can produce multiple platform messages through chunks, previews,
or message-tool sends. Those deliveries are governed by the agent run and
channel transport; `maxTurns` does not count, buffer, or cap physical messages.

Telegram, Discord, and Slack disable their shared preview and progress drafts
for qualified group threads so concurrent participants do not overwrite each
other's drafts. Final replies, block replies, and message-tool sends remain
available.

The default turn budget covers one turn per configured agent. To let every
agent run twice, set `maxRounds: 2` and `maxTurns` to twice the participant count.

### Mention selection

Selection uses only explicit `@`-style matches in the current inbound text,
computed once for the participant set. A name in prose or a bare emoji does not
select a participant. Mention patterns resolve from the agent’s
`groupChat.mentionPatterns`, then `messages.groupChat.mentionPatterns`, then its
identity-derived patterns. Give participants distinct patterns when you want
to address them separately.

With `mentionGating: true`, a match selects only the matching participants for
round 1; no matches selects all. With `mentionGating: false`, all participants
are selected. This option does not turn off the channel’s `requireMention`
policy, sender allowlists, or command authorization.

### Bounded follow-up rounds

After a completed round, another round can run only within both `maxRounds`
and `maxTurns`. Eligible participants are those that produced a final reply
in the previous round or were addressed by name in a sibling’s final reply.
Each participant's final text is limited to 4,000 characters in the digest;
the combined sibling text is limited to 16,000 characters.
Each receives an attributed, size-bounded digest of sibling finals from that
round, with an instruction to reply only when adding something new and otherwise
return `NO_REPLY`. Passing does not produce a visible final reply.

All participants passing ends the thread. Reaching either limit or cancellation
also stops further turns. Each continuation has its own internal identity;
it is not a replay of the physical inbound message. Sequential strategy changes
launch order within a round; it does not turn that round into a pipeline where
each participant sees earlier replies from the same round.

Budget state is in memory, scoped to the channel, account, conversation, thread,
and root inbound message. It is not restart-resumable: a Gateway restart loses
the active round and budget state. Ordinary inbound deduplication remains a
separate protection.

### Participant labels

When a qualified entry configures more than one participant, Discord, Slack,
and Telegram replies begin with the participant name in bold. The configured
count controls labeling, even if mention selection, the turn budget, or silence
leaves only one responder. WhatsApp presentation remains unchanged.

### Basic setup

Legacy single-pass setup uses unqualified WhatsApp peer IDs as keys and arrays of agent IDs as values:

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

Every listed agent ID must exist in the configured roster: config validation rejects unknown IDs in both arrays and objects. Deleting an agent prunes it from both forms.

Runtime membership uses the canonical `agents.entries` roster when present, including an empty roster. Legacy `agents.list` is used only when `agents.entries` is absent.

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
    "entries": {
      "code-reviewer": {
        "default": true,
        "name": "Code Reviewer",
        "workspace": "/path/to/code-reviewer",
        "sandbox": { "mode": "all" }
      },
      "security-auditor": {
        "name": "Security Auditor",
        "workspace": "/path/to/security-auditor",
        "sandbox": { "mode": "all" }
      },
      "docs-generator": {
        "name": "Documentation Generator",
        "workspace": "/path/to/docs-generator",
        "sandbox": { "mode": "all" }
      }
    }
  },
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["code-reviewer", "security-auditor", "docs-generator"]
  }
}
```

## How it works

### Message flow

<Steps>
  <Step title="Incoming message arrives">
    A channel message arrives.
  </Step>
  <Step title="Route and admission">
    OpenClaw applies channel allowlists, group activation rules, and configured ACP binding ownership.
  </Step>
  <Step title="Broadcast check">
    If no configured ACP binding owns the route, OpenClaw checks the qualified channel/peer key, then the legacy peer key for WhatsApp.
  </Step>
  <Step title="If broadcast applies">
    - Selected participants process the message within the round and turn limits.
    - Each agent has its own session key and isolated context.
    - Agents process in parallel (default) or sequentially.
    - WhatsApp audio attachments are transcribed once before fan-out, so agents share one transcript instead of making separate STT calls.

  </Step>
  <Step title="If broadcast does not apply">
    OpenClaw dispatches the ordinary route or the configured ACP session route selected during routing.
  </Step>
</Steps>

<Note>
Group threads do not bypass channel allowlists, command authorization, or exclusive ACP bindings. Participant mention admission extends the room mention gate as described above.
</Note>

### Session isolation

Each agent in a broadcast group maintains completely separate:

- **Session keys** (`agent:alfred:whatsapp:group:120363...` vs `agent:baerbel:whatsapp:group:120363...`)
- **Conversation history** (sibling replies are shared only through bounded follow-up digests)
- **Workspace** (separate sandboxes if configured)
- **Tool access** (different allow/deny lists)
- **Memory/context** (separate `IDENTITY.md`, `SOUL.md`, etc.)

On WhatsApp, one input is shared on purpose: the **group context buffer** (recent group messages used for context) is shared per peer, so all broadcast agents see the same context when triggered. It is cleared once after the fan-out completes.

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
        "entries": {
          "security-scanner": { "default": true, "name": "Security Scanner" },
          "code-formatter": { "name": "Code Formatter" },
          "test-generator": { "name": "Test Generator" }
        }
      }
    }
    ```
  </Accordion>
  <Accordion title="3. Configure different tool access">
    ```json
    {
      "agents": {
        "entries": {
          "reviewer": {
            "default": true,
            "tools": { "allow": ["read", "exec"] }
          },
          "fixer": { "tools": { "allow": ["read", "write", "edit", "exec"] } }
        }
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

Channel-qualified entries use the shared core dispatch path across channel plugins. Discord, Slack, and Telegram additionally support participant mention admission and name labels. Legacy unqualified entries apply only to WhatsApp (web channel).

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
    2. The qualified channel/peer key matches the room. Legacy WhatsApp keys use a group JID like `120363403215116621@g.us`, or E.164 like `+15551234567` for DMs.
    3. The message passed normal gating (mention/activation rules still apply).

    **Debug:**

    ```bash
    openclaw logs --follow | grep -i broadcast
    ```

    A successful fan-out logs `Broadcasting message to <n> agents (<strategy>)`.

  </Accordion>
  <Accordion title="Only one agent responding">
    **Check:** explicit mentions may select one participant, `maxTurns` may allow only one run, or the others may pass. Also check whether the peer is only in ordinary route bindings or matches an exclusive configured ACP binding.

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
        "entries": {
          "code-formatter": {
            "default": true,
            "workspace": "~/agents/formatter",
            "tools": { "allow": ["read", "write"] }
          },
          "security-scanner": {
            "workspace": "~/agents/security",
            "tools": { "allow": ["read", "exec"] }
          },
          "test-coverage": {
            "workspace": "~/agents/testing",
            "tools": { "allow": ["read", "exec"] }
          },
          "docs-checker": { "workspace": "~/agents/docs", "tools": { "allow": ["read"] } }
        }
      }
    }
    ```

    One code snippet in the group can produce four perspectives: formatting fixes, a security finding, a coverage gap, and a docs nit.

  </Accordion>
  <Accordion title="Example 2: Multi-language pipeline">
    ```json
    {
      "broadcast": {
        "strategy": "sequential",
        "+15555550123": ["detect-language", "translator-en", "translator-de"]
      },
      "agents": {
        "entries": {
          "detect-language": { "default": true, "workspace": "~/agents/lang-detect" },
          "translator-en": { "workspace": "~/agents/translate-en" },
          "translator-de": { "workspace": "~/agents/translate-de" }
        }
      }
    }
    ```
  </Accordion>
</AccordionGroup>

## API reference

### Config schema

```typescript
type BroadcastGroupConfig = {
  agents: string[];
  mentionGating?: boolean;
  maxRounds?: number;
  maxTurns?: number;
};

type BroadcastConfig = {
  strategy?: "parallel" | "sequential";
  [key: string]: string[] | BroadcastGroupConfig | "parallel" | "sequential" | undefined;
};
```

### Fields

<ParamField path="strategy" type='"parallel" | "sequential"' default='"parallel"'>
  How to process eligible agents within each round. `parallel` launches reserved turns together; `sequential` runs them in configured order.
</ParamField>
<ParamField path="[channel:peerId]" type="string[] | BroadcastGroupConfig">
  Channel-qualified peer ID. Arrays use the group-thread defaults; objects configure mention selection, rounds, and participant-turn budgets. At most 16 agents.
</ParamField>
<ParamField path="[peerId]" type="string[]">
  Legacy WhatsApp group JID or E.164 phone number. Every listed agent processes one turn, with no internal follow-up rounds or participant selection.
</ParamField>

## Limitations

1. **Shared context:** follow-up digests contain bounded sibling finals, not full sibling sessions or tool histories.
2. **Message ordering:** parallel responses may arrive in any order.
3. **Rate limits:** participants share the channel account’s transport limits; one turn can produce several platform messages.
4. **Recovery:** round and turn-budget state is in memory and cannot resume after a Gateway restart.
5. **Control UI:** a dedicated team-thread session is not yet available. Each participant keeps its own session.

## Related

- [Channel routing](/channels/channel-routing)
- [Groups](/channels/groups)
- [Multi-agent sandbox tools](/tools/multi-agent-sandbox-tools)
- [Pairing](/channels/pairing)
- [Session management](/concepts/session)
