---
summary: "Context engine: pluggable context assembly, compaction, and subagent lifecycle"
read_when:
  - You want to understand how OpenClaw assembles model context
  - You are switching between the legacy engine and a plugin engine
  - You are building a context engine plugin
title: "Context engine"
sidebarTitle: "Context engine"
---

A **context engine** controls how OpenClaw builds model context for each run: which messages to include, how to summarize older history, and how to manage context across subagent boundaries.

OpenClaw ships with a built-in `legacy` engine and uses it by default — most users never need to change this. Install and select a plugin engine only when you want different assembly, compaction, or cross-session recall behavior.

## Quick start

<Steps>
  <Step title="Check which engine is active">
    ```bash
    openclaw doctor
    # or inspect config directly:
    cat ~/.openclaw/openclaw.json | jq '.plugins.slots.contextEngine'
    ```
  </Step>
  <Step title="Install a plugin engine">
    Context engine plugins are installed like any other OpenClaw plugin.

    <Tabs>
      <Tab title="From npm">
        ```bash
        openclaw plugins install @martian-engineering/lossless-claw
        ```
      </Tab>
      <Tab title="From a local path">
        ```bash
        openclaw plugins install -l ./my-context-engine
        ```
      </Tab>
    </Tabs>

  </Step>
  <Step title="Enable and select the engine">
    ```json5
    // openclaw.json
    {
      plugins: {
        slots: {
          contextEngine: "lossless-claw", // must match the plugin's registered engine id
        },
        entries: {
          "lossless-claw": {
            enabled: true,
            // Plugin-specific config goes here (see the plugin's docs)
          },
        },
      },
    }
    ```

    Restart the gateway after installing and configuring.

  </Step>
  <Step title="Switch back to legacy (optional)">
    Set `contextEngine` to `"legacy"` (or remove the key entirely — `"legacy"` is the default).
  </Step>
</Steps>

## How it works

Every time OpenClaw runs a model prompt, the context engine participates at four lifecycle points:

<AccordionGroup>
  <Accordion title="1. Ingest">
    Called when a new message is added to the session. The engine can store or index the message in its own data store.
  </Accordion>
  <Accordion title="2. Assemble">
    Called before each model run. The engine returns an ordered set of messages (and an optional `systemPromptAddition`) that fit within the token budget.
  </Accordion>
  <Accordion title="3. Compact">
    Called when the context window is full, or when the user runs `/compact`. The engine summarizes older history to free space.
  </Accordion>
  <Accordion title="4. After turn">
    Called after a run completes. The engine can persist state, trigger background compaction, or update indexes.
  </Accordion>
</AccordionGroup>

For the bundled non-ACP Codex harness, OpenClaw applies the same lifecycle by projecting assembled context into Codex developer instructions and the current turn prompt. Codex still owns its native thread history and native compactor.

### Subagent lifecycle (optional)

OpenClaw calls two optional subagent lifecycle hooks:

<ParamField path="prepareSubagentSpawn" type="method">
  Prepare shared context state before a child run starts. The hook receives parent/child session keys, `contextMode` (`isolated` or `fork`), available transcript ids/files, and optional TTL. If it returns a rollback handle, OpenClaw calls it when spawn fails after preparation succeeds.
</ParamField>
<ParamField path="onSubagentEnded" type="method">
  Clean up when a subagent session completes or is swept.
</ParamField>

### System prompt addition

The `assemble` method can return a `systemPromptAddition` string. OpenClaw prepends this to the system prompt for the run. This lets engines inject dynamic recall guidance, retrieval instructions, or context-aware hints without requiring static workspace files.

## The legacy engine

The built-in `legacy` engine preserves OpenClaw's original behavior:

- **Ingest**: no-op (the session manager handles message persistence directly).
- **Assemble**: pass-through (the existing sanitize → validate → limit pipeline in the runtime handles context assembly).
- **Compact**: delegates to the built-in summarization compaction, which creates a single summary of older messages and keeps recent messages intact.
- **After turn**: no-op.

The legacy engine does not register tools or provide a `systemPromptAddition`.

When no `plugins.slots.contextEngine` is set (or it's set to `"legacy"`), this engine is used automatically.

## Plugin engines

A plugin can register a context engine using the plugin API:

```ts
import { buildMemorySystemPromptAddition } from "openclaw/plugin-sdk/core";

export default function register(api) {
  api.registerContextEngine("my-engine", (ctx) => ({
    info: {
      id: "my-engine",
      name: "My Context Engine",
      ownsCompaction: true,
    },

    async ingest({ sessionId, message, isHeartbeat }) {
      // Store the message in your data store
      return { ingested: true };
    },

    async assemble({ sessionId, messages, tokenBudget, availableTools, citationsMode }) {
      // Return messages that fit the budget
      return {
        messages: buildContext(messages, tokenBudget),
        estimatedTokens: countTokens(messages),
        systemPromptAddition: buildMemorySystemPromptAddition({
          availableTools: availableTools ?? new Set(),
          citationsMode,
        }),
      };
    },

    async compact({ sessionId, force }) {
      // Summarize older context
      return { ok: true, compacted: true };
    },
  }));
}
```

The factory `ctx` includes optional `config`, `agentDir`, and `workspaceDir`
values so plugins can initialize per-agent or per-workspace state before the
first lifecycle hook runs.

Then enable it in config:

```json5
{
  plugins: {
    slots: {
      contextEngine: "my-engine",
    },
    entries: {
      "my-engine": {
        enabled: true,
      },
    },
  },
}
```

### The ContextEngine interface

Required members:

| Member             | Kind     | Purpose                                                  |
| ------------------ | -------- | -------------------------------------------------------- |
| `info`             | Property | Engine id, name, version, and whether it owns compaction |
| `ingest(params)`   | Method   | Store a single message                                   |
| `assemble(params)` | Method   | Build context for a model run (returns `AssembleResult`) |
| `compact(params)`  | Method   | Summarize/reduce context                                 |

`assemble` returns an `AssembleResult` with:

<ParamField path="messages" type="Message[]" required>
  The ordered messages to send to the model.
</ParamField>
<ParamField path="estimatedTokens" type="number" required>
  The engine's estimate of total tokens in the assembled context. OpenClaw uses this for compaction threshold decisions and diagnostic reporting.
</ParamField>
<ParamField path="systemPromptAddition" type="string">
  Prepended to the system prompt.
</ParamField>

`compact` returns a `CompactResult`. When compaction rotates the active
transcript, `result.sessionId` and `result.sessionFile` identify the successor
session that the next retry or turn must use.

Optional members:

| Member                         | Kind   | Purpose                                                                                                         |
| ------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------- |
| `bootstrap(params)`            | Method | Initialize engine state for a session. Called once when the engine first sees a session (e.g., import history). |
| `ingestBatch(params)`          | Method | Ingest a completed turn as a batch. Called after a run completes, with all messages from that turn at once.     |
| `afterTurn(params)`            | Method | Post-run lifecycle work (persist state, trigger background compaction).                                         |
| `prepareSubagentSpawn(params)` | Method | Set up shared state for a child session before it starts.                                                       |
| `onSubagentEnded(params)`      | Method | Clean up after a subagent ends.                                                                                 |
| `dispose()`                    | Method | Release resources. Called during gateway shutdown or plugin reload — not per-session.                           |

### ownsCompaction

`ownsCompaction` controls whether Pi's built-in in-attempt auto-compaction stays enabled for the run:

<AccordionGroup>
  <Accordion title="ownsCompaction: true">
    The engine owns compaction behavior. OpenClaw disables Pi's built-in auto-compaction for that run, and the engine's `compact()` implementation is responsible for `/compact`, overflow recovery compaction, and any proactive compaction it wants to do in `afterTurn()`. OpenClaw may still run the pre-prompt overflow safeguard; when it predicts the full transcript will overflow, the recovery path calls the active engine's `compact()` before submitting another prompt.
  </Accordion>
  <Accordion title="ownsCompaction: false or unset">
    Pi's built-in auto-compaction may still run during prompt execution, but the active engine's `compact()` method is still called for `/compact` and overflow recovery.
  </Accordion>
</AccordionGroup>

<Warning>
`ownsCompaction: false` does **not** mean OpenClaw automatically falls back to the legacy engine's compaction path.
</Warning>

That means there are two valid plugin patterns:

<Tabs>
  <Tab title="Owning mode">
    Implement your own compaction algorithm and set `ownsCompaction: true`.
  </Tab>
  <Tab title="Delegating mode">
    Set `ownsCompaction: false` and have `compact()` call `delegateCompactionToRuntime(...)` from `openclaw/plugin-sdk/core` to use OpenClaw's built-in compaction behavior.
  </Tab>
</Tabs>

A no-op `compact()` is unsafe for an active non-owning engine because it disables the normal `/compact` and overflow-recovery compaction path for that engine slot.

## Configuration reference

```json5
{
  plugins: {
    slots: {
      // Select the active context engine. Default: "legacy".
      // Set to a plugin id to use a plugin engine.
      contextEngine: "legacy",
    },
  },
}
```

<Note>
The slot is exclusive at run time — only one registered context engine is resolved for a given run or compaction operation. Other enabled `kind: "context-engine"` plugins can still load and run their registration code; `plugins.slots.contextEngine` only selects which registered engine id OpenClaw resolves when it needs a context engine.
</Note>

<Note>
**Plugin uninstall:** when you uninstall the plugin currently selected as `plugins.slots.contextEngine`, OpenClaw resets the slot back to the default (`legacy`). The same reset behavior applies to `plugins.slots.memory`. No manual config edit is required.
</Note>

## Relationship to compaction and memory

<AccordionGroup>
  <Accordion title="Compaction">
    Compaction is one responsibility of the context engine. The legacy engine delegates to OpenClaw's built-in summarization. Plugin engines can implement any compaction strategy (DAG summaries, vector retrieval, etc.).
  </Accordion>
  <Accordion title="Memory plugins">
    Memory plugins (`plugins.slots.memory`) are separate from context engines. Memory plugins provide search/retrieval; context engines control what the model sees. They can work together — a context engine might use memory plugin data during assembly. Plugin engines that want the active memory prompt path should prefer `buildMemorySystemPromptAddition(...)` from `openclaw/plugin-sdk/core`, which converts the active memory prompt sections into a ready-to-prepend `systemPromptAddition`. If an engine needs lower-level control, it can still pull raw lines from `openclaw/plugin-sdk/memory-host-core` via `buildActiveMemoryPromptSection(...)`.
  </Accordion>
  <Accordion title="Session pruning">
    Trimming old tool results in-memory still runs regardless of which context engine is active.
  </Accordion>
</AccordionGroup>

## Tips

- Use `openclaw doctor` to verify your engine is loading correctly.
- If switching engines, existing sessions continue with their current history. The new engine takes over for future runs.
- Engine errors are logged and surfaced in diagnostics. If a plugin engine fails to register or the selected engine id cannot be resolved, OpenClaw does not fall back automatically; runs fail until you fix the plugin or switch `plugins.slots.contextEngine` back to `"legacy"`.
- For development, use `openclaw plugins install -l ./my-engine` to link a local plugin directory without copying.

## Related

- [Compaction](/concepts/compaction) — summarizing long conversations
- [Context](/concepts/context) — how context is built for agent turns
- [Plugin Architecture](/plugins/architecture) — registering context engine plugins
- [Plugin manifest](/plugins/manifest) — plugin manifest fields
- [Plugins](/tools/plugin) — plugin overview
