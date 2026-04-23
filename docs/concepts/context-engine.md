---
summary: "Context engine: pluggable context assembly, compaction, and subagent lifecycle"
read_when:
  - You want to understand how OpenClaw assembles model context
  - You are switching between the legacy engine and a plugin engine
  - You are building a context engine plugin
title: "Context engine"
---

A **context engine** controls how OpenClaw builds model context for each run.
It decides which messages to include, how to summarize older history, and how
to manage context across subagent boundaries.

OpenClaw ships with a built-in `legacy` engine. Plugins can register
alternative engines that replace the active context-engine lifecycle.

## Quick start

Check which engine is active:

```bash
openclaw doctor
# or inspect config directly:
cat ~/.openclaw/openclaw.json | jq '.plugins.slots.contextEngine'
```

### Installing a context engine plugin

Context engine plugins are installed like any other OpenClaw plugin. Install
first, then select the engine in the slot:

```bash
# Install from npm
openclaw plugins install @martian-engineering/lossless-claw

# Or install from a local path (for development)
openclaw plugins install -l ./my-context-engine
```

Then enable the plugin and select it as the active engine in your config:

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

To switch back to the built-in engine, set `contextEngine` to `"legacy"` (or
remove the key entirely — `"legacy"` is the default).

## How it works

Every time OpenClaw runs a model prompt, the context engine participates at
four lifecycle points:

1. **Ingest** — called when a new message is added to the session. The engine
   can store or index the message in its own data store.
2. **Assemble** — called before each model run. The engine returns an ordered
   set of messages (and an optional `systemPromptAddition`) that fit within
   the token budget.
3. **Compact** — called when the context window is full, or when the user runs
   `/compact`. The engine summarizes older history to free space.
4. **After turn** — called after a run completes. The engine can persist state,
   trigger background compaction, or update indexes.

### Subagent lifecycle (optional)

OpenClaw calls two optional subagent lifecycle hooks:

- **prepareSubagentSpawn** — prepare shared context state before a child run
  starts. The hook receives parent/child session keys, `contextMode`
  (`isolated` or `fork`), available transcript ids/files, and optional TTL.
  If it returns a rollback handle, OpenClaw calls it when spawn fails after
  preparation succeeds.
- **onSubagentEnded** — clean up when a subagent session completes or is swept.

### System prompt addition

The `assemble` method can return a `systemPromptAddition` string. OpenClaw
prepends this to the system prompt for the run. This lets engines inject
dynamic recall guidance, retrieval instructions, or context-aware hints
without requiring static workspace files.

## The legacy engine

The built-in `legacy` engine preserves OpenClaw's original behavior:

- **Ingest**: no-op (the session manager handles message persistence directly).
- **Assemble**: pass-through (the existing sanitize → validate → limit pipeline
  in the runtime handles context assembly).
- **Compact**: delegates to the built-in summarization compaction, which creates
  a single summary of older messages and keeps recent messages intact.
- **After turn**: no-op.

The legacy engine does not register tools or provide a `systemPromptAddition`.

When no `plugins.slots.contextEngine` is set (or it's set to `"legacy"`), this
engine is used automatically.

## Plugin engines

A plugin can register a context engine using the plugin API:

```ts
import { buildMemorySystemPromptAddition } from "openclaw/plugin-sdk/core";

export default function register(api) {
  api.registerContextEngine("my-engine", () => ({
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

- `messages` — the ordered messages to send to the model.
- `estimatedTokens` (required, `number`) — the engine's estimate of total
  tokens in the assembled context. OpenClaw uses this for compaction threshold
  decisions and diagnostic reporting.
- `systemPromptAddition` (optional, `string`) — prepended to the system prompt.

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

`ownsCompaction` controls whether Pi's built-in in-attempt auto-compaction stays
enabled for the run:

- `true` — the engine owns compaction behavior. OpenClaw disables Pi's built-in
  auto-compaction for that run, and the engine's `compact()` implementation is
  responsible for `/compact`, overflow recovery compaction, and any proactive
  compaction it wants to do in `afterTurn()`.
- `false` or unset — Pi's built-in auto-compaction may still run during prompt
  execution, but the active engine's `compact()` method is still called for
  `/compact` and overflow recovery.

`ownsCompaction: false` does **not** mean OpenClaw automatically falls back to
the legacy engine's compaction path.

That means there are two valid plugin patterns:

- **Owning mode** — implement your own compaction algorithm and set
  `ownsCompaction: true`.
- **Delegating mode** — set `ownsCompaction: false` and have `compact()` call
  `delegateCompactionToRuntime(...)` from `openclaw/plugin-sdk/core` to use
  OpenClaw's built-in compaction behavior.

A no-op `compact()` is unsafe for an active non-owning engine because it
disables the normal `/compact` and overflow-recovery compaction path for that
engine slot.

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

The slot is exclusive at run time — only one registered context engine is
resolved for a given run or compaction operation. Other enabled
`kind: "context-engine"` plugins can still load and run their registration
code; `plugins.slots.contextEngine` only selects which registered engine id
OpenClaw resolves when it needs a context engine.

## Relationship to compaction and memory

- **Compaction** is one responsibility of the context engine. The legacy engine
  delegates to OpenClaw's built-in summarization. Plugin engines can implement
  any compaction strategy (DAG summaries, vector retrieval, etc.).
- **Memory plugins** (`plugins.slots.memory`) are separate from context engines.
  Memory plugins provide search/retrieval; context engines control what the
  model sees. They can work together — a context engine might use memory
  plugin data during assembly. Plugin engines that want the active memory
  prompt path should prefer `buildMemorySystemPromptAddition(...)` from
  `openclaw/plugin-sdk/core`, which converts the active memory prompt sections
  into a ready-to-prepend `systemPromptAddition`. If an engine needs lower-level
  control, it can still pull raw lines from
  `openclaw/plugin-sdk/memory-host-core` via
  `buildActiveMemoryPromptSection(...)`.
- **Session pruning** (trimming old tool results in-memory) still runs
  regardless of which context engine is active.

## Tips

- Use `openclaw doctor` to verify your engine is loading correctly.
- If switching engines, existing sessions continue with their current history.
  The new engine takes over for future runs.
- Engine errors are logged and surfaced in diagnostics. If a plugin engine
  fails to register or the selected engine id cannot be resolved, OpenClaw
  does not fall back automatically; runs fail until you fix the plugin or
  switch `plugins.slots.contextEngine` back to `"legacy"`.
- For development, use `openclaw plugins install -l ./my-engine` to link a
  local plugin directory without copying.

See also: [Compaction](/concepts/compaction), [Context](/concepts/context),
[Plugins](/tools/plugin), [Plugin manifest](/plugins/manifest).

## Related

- [Context](/concepts/context) — how context is built for agent turns
- [Plugin Architecture](/plugins/architecture) — registering context engine plugins
- [Compaction](/concepts/compaction) — summarizing long conversations
