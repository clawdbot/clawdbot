---
summary: "Tool Search: compact large OpenClaw tool catalogs behind search, describe, and call"
title: "Tool Search"
read_when:
  - You want OpenClaw agents to use a large tool catalog without adding every tool schema to the prompt
  - You want OpenClaw tools, MCP tools, and client tools exposed through one compact runtime surface
  - You are implementing or debugging tool discovery for OpenClaw runs
---

Tool Search is an experimental OpenClaw agent runtime feature. It gives agents one
compact way to discover and call large tool catalogs. It is useful when the run
has many available tools but the model is likely to need only a few of them.

This page documents OpenClaw Tool Search. It is not the Codex-native tool
search or dynamic-tools surface. Codex-native code mode, tool search, deferred
dynamic tools, and nested tool calls are stable Codex harness surfaces and do
not depend on `tools.toolSearch`.

For the generic OpenClaw runtime that exposes a QuickJS-WASI `exec`/`wait`
surface instead of Tool Search controls, see [Code Mode](/tools/code-mode).

When enabled for OpenClaw runs, the model receives one `tool_search_code` tool
by default, plus any direct-only tools whose structured results cannot cross
the compact bridge. The code tool runs a short JavaScript body in an isolated
Node subprocess with an `openclaw.tools` bridge:

```js
const hits = await openclaw.tools.search("create a GitHub issue");
const tool = await openclaw.tools.describe(hits[0].id);
return await openclaw.tools.call(tool.id, {
  title: "Crash on startup",
  body: "Steps to reproduce...",
});
```

The catalog can include catalog-eligible OpenClaw tools, plugin tools, MCP
tools, and client-provided tools. The model does not see every cataloged schema
up front. Instead, it searches compact descriptors, describes one selected
tool when it needs the exact schema, and calls that tool through OpenClaw.
Direct-only tools remain model-visible and are not added to the catalog.

Codex harness runs do not receive these experimental OpenClaw Tool Search
controls. OpenClaw passes product capabilities to Codex as dynamic tools, and
Codex owns the stable native code mode, native tool search, deferred dynamic
tools, and nested tool calls.

## How a turn runs

At planning time the OpenClaw embedded runner builds the effective catalog for the
run:

1. Resolve the active tool policy for the agent, profile, sandbox, and session.
2. List eligible OpenClaw and plugin tools.
3. List eligible MCP tools through the session MCP runtime.
4. Add eligible client tools supplied for the current run.
5. Keep direct-only tools model-visible and index compact descriptors for the
   remaining catalog-eligible tools.
6. Expose the OpenClaw code bridge, the structured fallback tools, or the
   compact directory surface alongside those direct-only tools.

At execution time every real tool call returns to OpenClaw. The isolated Node
runtime does not hold plugin implementations, MCP client objects, or secrets.
`openclaw.tools.call(...)` crosses the bridge back into the Gateway, where the
normal policy, approval, hook, logging, and result handling still apply.

## Modes

`tools.toolSearch` has three model-facing modes:

- `code`: exposes `tool_search_code`, the default compact JavaScript bridge,
  alongside direct-only tools.
- `tools`: exposes `tool_search`, `tool_describe`, and `tool_call` as plain
  structured tools for providers that should not receive code, alongside
  direct-only tools.
- `directory`: exposes `tool_search`, `tool_describe`, and `tool_call` plus a
  bounded prompt directory of available tool names and descriptions for
  providers that should see tool names without every full schema. OpenClaw can
  also expose a small bounded set of likely or required tool schemas directly
  for the current turn. Direct-only tools remain visible in this mode too.

All modes use the same policy-filtered catalog and normal OpenClaw execution
path. Tools marked `catalogMode: "direct-only"` stay outside that catalog and
remain model-visible. If the current runtime cannot launch the isolated Node code-mode child
process, the default `code` mode falls back to `tools` before catalog
compaction. In `directory` mode, client-provided tools stay directly visible
for the current run while OpenClaw tools, plugin tools, and MCP tools can be
compacted behind the directory catalog. A direct call to an exact hidden
directory name is hydrated from that same authorized catalog before execution.

All modes are experimental. Prefer direct tool exposure for small OpenClaw tool
catalogs, and prefer the Codex-native stable surfaces for Codex harness runs.

There is no separate source-selection config. When Tool Search is enabled, the
catalog includes catalog-eligible OpenClaw, MCP, and client tools after normal
policy filtering; direct-only tools are retained separately.

## Why this exists

Large catalogs are useful but expensive. Sending every tool schema to the model
makes the request larger, slows planning, and increases accidental tool
selection.

Tool Search changes the shape:

- direct tools: the model sees every selected schema before the first token
- Tool Search code mode: the model sees one compact code tool, a short API
  contract, and any direct-only tools
- Tool Search tools mode: the model sees three compact structured fallback
  tools plus any direct-only tools
- Tool Search directory mode: the model sees a bounded directory plus
  search/describe/call controls and a small bounded set of likely or required
  schemas, plus any direct-only tools
- during the turn: the model can load remaining schemas as needed

Direct tool exposure is still the right default for small catalogs. Tool Search
is best when one run can see many tools, especially from MCP servers or
client-provided app tools.

## API

`openclaw.tools.search(query, options?)`

Searches the effective catalog for the current run. Results are compact and safe
to put back into prompt context. Each hit includes a bounded TypeScript-style
`input` signature, such as `{ id: string; mode?: "drip" | "flood" }`, so the
model can skip `describe` when that signature is sufficient. A trusted
OpenClaw core or plugin tool may also include a compact `output` hint, such as
`Array<{ id: string; paid: boolean }>`. MCP and client output-schema claims are
not promoted into this trusted hint. Their untrusted input schemas are also
deferred as `input: "unknown"`; use `describe` before calling them. Open,
oversized, or otherwise partial output schemas omit the hint and remain
available through `describe` instead.

```js
const hits = await openclaw.tools.search("calendar event", { limit: 5 });
```

`openclaw.tools.describe(id)`

Loads full metadata for one search result, including the exact input schema and
the trusted full `outputSchema` when the tool declares one.

```js
const calendarCreate = await openclaw.tools.describe("mcp:calendar:create_event");
```

`openclaw.tools.call(id, args)`

Calls a selected tool through OpenClaw and returns the raw `{ tool, result }`
envelope. JSON-returning tools normally place their value in
`result.details`. If a trusted tool declares `outputSchema`, OpenClaw compiles
the schema before execution and validates final `details` after normal tool
hooks before returning the catalog call.

```js
await openclaw.tools.call(calendarCreate.id, {
  summary: "Planning",
  start: "2026-05-09T14:00:00Z",
});
```

Tool authors declare output contracts on the tool's `outputSchema` property.
It describes `AgentToolResult.details`, not rendered content blocks. Include
all non-throwing variants or omit it for unstable results. See
[Code Mode output contracts](/tools/code-mode#declared-output-contracts) and
[Tool plugins](/plugins/tool-plugins#output-contracts).

The structured fallback mode exposes the same operations as tools:

- `tool_search`
- `tool_describe`
- `tool_call`

Directory mode exposes:

- `tool_search`
- `tool_describe`
- `tool_call`

It also keeps client-provided tools and all direct-only tools directly visible,
and may expose a small bounded set of likely or required catalog tool schemas
directly for the current turn. If the bounded directory omits entries, use
`tool_search` to find them. If the model requests an exact hidden directory
tool name directly, OpenClaw hydrates it from the authorized catalog before
normal execution.
Directory-mode client tool names must not collide with OpenClaw, plugin, or MCP
tool names because exact deferred dispatch uses those names.

## Runtime boundary

The code bridge runs in a short-lived Node subprocess. The subprocess starts
with Node permission mode enabled, an empty environment, no filesystem or
network grants, and no child-process or worker grants. OpenClaw enforces a
parent-process wall-clock timeout and kills the subprocess on timeout, including
after async continuations.

The runtime exposes only:

- `console.log`, `console.warn`, and `console.error`
- `openclaw.tools.search`
- `openclaw.tools.describe`
- `openclaw.tools.call`

Normal OpenClaw behavior still applies to final calls:

- tool allow and deny policies
- per-agent and per-sandbox tool restrictions
- channel/runtime tool policy
- approval hooks
- plugin `before_tool_call` hooks
- session identity, logs, and telemetry

## Config

Enable Tool Search for OpenClaw runs with the default code bridge:

```bash
openclaw config set tools.toolSearch true
```

Equivalent JSON:

```json5
{
  tools: {
    toolSearch: true,
  },
}
```

Use the structured fallback tools instead for OpenClaw runs:

```json5
{
  tools: {
    toolSearch: {
      mode: "tools",
    },
  },
}
```

Use the compact directory surface instead for OpenClaw runs:

```json5
{
  tools: {
    toolSearch: {
      mode: "directory",
    },
  },
}
```

Tune code-mode timeout and search result limits (values shown are the defaults):

```json5
{
  tools: {
    toolSearch: {
      mode: "code",
      codeTimeoutMs: 10000,
      searchDefaultLimit: 8,
      maxSearchLimit: 20,
    },
  },
}
```

The runtime clamps `codeTimeoutMs` to 1000-60000, `maxSearchLimit` to 1-50, and
`searchDefaultLimit` to 1..`maxSearchLimit`.

Disable it:

```json5
{
  tools: {
    toolSearch: false,
  },
}
```

## Prompt and telemetry

Tool Search records enough telemetry to compare it with direct tool exposure:

- total serialized tool and prompt bytes sent to the harness
- catalog size and source breakdown
- search, describe, and call counts
- final tool calls executed through OpenClaw
- selected tool ids and sources

Session logs should make it possible to answer:

- how many tool schemas the model saw up front
- how many search and describe operations it performed
- which final tool was called
- whether the result came from OpenClaw, MCP, or a client tool

## E2E validation

The QA Lab gateway scenario proves both paths with the OpenClaw runtime:

```bash
pnpm openclaw qa suite --provider-mode mock-openai --scenario tool-search-gateway-e2e
```

It creates a temporary fake plugin with a large tool catalog, starts the mock
OpenAI provider, starts a Gateway once in direct mode and once with Tool Search
enabled, then compares provider request payloads and session logs.

The regression proves:

1. Direct mode can call the fake plugin tool.
2. Tool Search can call the same fake plugin tool.
3. Direct mode exposes the fake plugin tool schemas directly to the provider.
4. Tool Search exposes only the compact bridge plus any direct-only tools.
5. The Tool Search request payload is smaller for the large fake catalog.
6. Session logs show the expected tool-call counts and bridged call telemetry.

## Failure behavior

Tool Search should fail closed:

- if a tool is not in the effective policy, search should not return it
- if a selected tool becomes unavailable, `tool_call` should fail
- if policy or approval blocks execution, the call result should report that
  block instead of bypassing it
- if the code bridge cannot create an isolated runtime, use `mode: "tools"` or
  disable Tool Search for that deployment

## Related

- [Tools and plugins](/tools)
- [Multi-agent sandbox and tools](/tools/multi-agent-sandbox-tools)
- [Exec tool](/tools/exec)
- [ACP agents setup](/tools/acp-agents-setup)
- [Building plugins](/plugins/building-plugins)
