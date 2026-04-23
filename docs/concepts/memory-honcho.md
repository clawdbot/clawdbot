---
summary: "AI-native cross-session memory via the Honcho plugin"
title: "Honcho memory"
read_when:
  - You want persistent memory that works across sessions and channels
  - You want AI-powered recall and user modeling
---

[Honcho](https://honcho.dev) adds AI-native memory to OpenClaw. It persists
conversations to a dedicated service and builds user and agent models over time,
giving your agent cross-session context that goes beyond workspace Markdown
files.

## What it provides

- **Cross-session memory** -- conversations are persisted after every turn, so
  context carries across session resets, compaction, and channel switches.
- **User modeling** -- Honcho maintains a profile for each user (preferences,
  facts, communication style) and for the agent (personality, learned
  behaviors).
- **Semantic search** -- search over observations from past conversations, not
  just the current session.
- **Multi-agent awareness** -- parent agents automatically track spawned
  sub-agents, with parents added as observers in child sessions.

## Available tools

Honcho registers tools that the agent can use during conversation:

**Data retrieval (fast, no LLM call):**

| Tool                        | What it does                                           |
| --------------------------- | ------------------------------------------------------ |
| `honcho_context`            | Full user representation across sessions               |
| `honcho_search_conclusions` | Semantic search over stored conclusions                |
| `honcho_search_messages`    | Find messages across sessions (filter by sender, date) |
| `honcho_session`            | Current session history and summary                    |

**Q&A (LLM-powered):**

| Tool         | What it does                                                              |
| ------------ | ------------------------------------------------------------------------- |
| `honcho_ask` | Ask about the user. `depth='quick'` for facts, `'thorough'` for synthesis |

## Getting started

Install the plugin and run setup:

```bash
openclaw plugins install @honcho-ai/openclaw-honcho
openclaw honcho setup
openclaw gateway --force
```

The setup command prompts for your API credentials, writes the config, and
optionally migrates existing workspace memory files.

<Info>
Honcho can run entirely locally (self-hosted) or via the managed API at
`api.honcho.dev`. No external dependencies are required for the self-hosted
option.
</Info>

## Configuration

Settings live under `plugins.entries["openclaw-honcho"].config`:

```json5
{
  plugins: {
    entries: {
      "openclaw-honcho": {
        config: {
          apiKey: "your-api-key", // omit for self-hosted
          workspaceId: "openclaw", // memory isolation
          baseUrl: "https://api.honcho.dev",
        },
      },
    },
  },
}
```

For self-hosted instances, point `baseUrl` to your local server (for example
`http://localhost:8000`) and omit the API key.

## Migrating existing memory

If you have existing workspace memory files (`USER.md`, `MEMORY.md`,
`IDENTITY.md`, `memory/`, `canvas/`), `openclaw honcho setup` detects and
offers to migrate them.

<Info>
Migration is non-destructive -- files are uploaded to Honcho. Originals are
never deleted or moved.
</Info>

## How it works

After every AI turn, the conversation is persisted to Honcho. Both user and
agent messages are observed, allowing Honcho to build and refine its models over
time.

During conversation, Honcho tools query the service in the `before_prompt_build`
phase, injecting relevant context before the model sees the prompt. This ensures
accurate turn boundaries and relevant recall.

## Honcho vs builtin memory

|                   | Builtin / QMD                | Honcho                              |
| ----------------- | ---------------------------- | ----------------------------------- |
| **Storage**       | Workspace Markdown files     | Dedicated service (local or hosted) |
| **Cross-session** | Via memory files             | Automatic, built-in                 |
| **User modeling** | Manual (write to MEMORY.md)  | Automatic profiles                  |
| **Search**        | Vector + keyword (hybrid)    | Semantic over observations          |
| **Multi-agent**   | Not tracked                  | Parent/child awareness              |
| **Dependencies**  | None (builtin) or QMD binary | Plugin install                      |

Honcho and the builtin memory system can work together. When QMD is configured,
additional tools become available for searching local Markdown files alongside
Honcho's cross-session memory.

## CLI commands

```bash
openclaw honcho setup                        # Configure API key and migrate files
openclaw honcho status                       # Check connection status
openclaw honcho ask <question>               # Query Honcho about the user
openclaw honcho search <query> [-k N] [-d D] # Semantic search over memory
```

## Further reading

- [Plugin source code](https://github.com/plastic-labs/openclaw-honcho)
- [Honcho documentation](https://docs.honcho.dev)
- [Honcho OpenClaw integration guide](https://docs.honcho.dev/v3/guides/integrations/openclaw)
- [Memory](/concepts/memory) -- OpenClaw memory overview
- [Context Engines](/concepts/context-engine) -- how plugin context engines work
