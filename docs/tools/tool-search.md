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

When enabled for OpenClaw runs, the model automatically receives a bounded
directory of the available trusted tool names and descriptions. By default, it
also receives one `tool_search_code` tool, plus any direct-only tools whose
structured results cannot cross the compact bridge. The code tool runs a short
JavaScript body in an isolated Node subprocess with an `openclaw.tools` bridge:

```js
const hits = await openclaw.tools.search("create a GitHub issue");
const tool = await openclaw.tools.describe(hits[0].id);
return await openclaw.tools.call(tool.id, {
  title: "Crash on startup",
  body: "Steps to reproduce...",
});
```

The catalog can include catalog-eligible OpenClaw tools, plugin tools, MCP
tools, and client-provided tools. The directory gives the model an idea of
which trusted capabilities it can discover without exposing every cataloged
schema up front. It also explains that policy-approved MCP and client tools
may be discoverable. Their untrusted names and descriptions are not copied into
the system prompt. Instead, the model searches compact descriptors, describes
one selected tool when it needs the exact schema, and calls that tool through
OpenClaw. Direct-only tools remain model-visible and are not added to the
catalog.

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
5. Keep core coding primitives and direct-only tools model-visible and index
   compact descriptors for the remaining catalog-eligible tools.
6. Add a deterministic, bounded, policy-filtered capability directory to the
   cache-stable system-prompt prefix.
7. Expose the OpenClaw code bridge, the structured fallback tools, or the
   compact directory surface alongside those stable, directly callable tools.

At execution time every real tool call returns to OpenClaw. The isolated Node
runtime does not hold plugin implementations, MCP client objects, or secrets.
`openclaw.tools.call(...)` crosses the bridge back into the Gateway, where the
normal policy, approval, hook, logging, and result handling still apply.

## Modes

`tools.toolSearch` has three model-facing modes:

- `code`: exposes `tool_search_code`, the default compact JavaScript bridge,
  alongside the capability directory and direct-only tools.
- `tools`: exposes `tool_search`, `tool_describe`, and `tool_call` as plain
  structured tools for providers that should not receive code, alongside the
  capability directory and direct-only tools.
- `directory`: exposes `tool_search`, `tool_describe`, and `tool_call` plus a
  bounded, cache-stable prompt directory. Core coding primitives, direct-only
  tools, and tools required by the run's delivery policy remain visible; other
  schemas stay deferred.

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
- Tool Search code mode: the model sees one compact code tool, a bounded
  capability directory, a short API contract, and any direct-only tools
- Tool Search tools mode: the model sees three compact structured fallback
  tools, the same capability directory, and any direct-only tools
- Tool Search directory mode: the model sees a bounded directory plus
  search/describe/call controls, policy-required direct tools, and any
  direct-only tools
- during the turn: the model can load remaining schemas as needed

Direct tool exposure is still the right default for small catalogs. Tool Search
is best when one run can see many tools, especially from MCP servers or
client-provided app tools.

The capability directory is sorted by tool name, limited to 18,000 characters,
and built from the already policy-filtered catalog. OpenClaw reuses the
rendered directory for an unchanged catalog snapshot and places it above the
system-prompt cache boundary. User messages, per-turn tool guesses, session
identifiers, and untrusted MCP or client metadata do not enter the directory.
This keeps repeated turns eligible for prompt KV-cache reuse. When the
authorized catalog changes, OpenClaw builds a new directory for the new
snapshot.

## API

`openclaw.tools.search(query, options?)`

Searches the effective catalog for the current run.

Queries must be written in English. Ranking is lexical (Okapi BM25 over tool
names, descriptions, and first-party parameter names and descriptions), with
light English stemming so `scheduling` reaches a tool described as `Schedule a
recurring task`, and a small intent expansion so `look up the price` reaches one
described as `Search the web`. Tool names and descriptions are written in English,
so a query in another language will usually match nothing. It is not rejected —
a catalog may legitimately describe a tool in another script — but it is also no
longer answered with an arbitrary slice of the catalog presented as if it were
ranked, which is what the previous scorer did whenever a query produced no
usable terms. Both `tool_search` and the code-mode bridge state this
requirement in their model-facing descriptions.

Untrusted parameter schemas are never indexed. MCP and client tools are matched
on name and description only, which is the same boundary that defers their input
signatures as `input: "unknown"`.

Results are compact and safe
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
`result.details`. OpenClaw validates a trusted core or plugin tool's declared
input schema before execution. Missing required arguments, incorrect types,
and forbidden properties return actionable tool errors instead of executing
the tool; misspelled properties include a suggested parameter when available.
If a trusted tool also declares `outputSchema`, OpenClaw compiles that schema
before execution and validates final `details` after normal tool hooks before
returning the catalog call. MCP and client-owned schemas remain deferred to
their owning execution boundary.

In structured mode, `tool_call` also repairs flattened target arguments from
local models. It preserves target fields such as `id` and `name`, and rejects
ambiguous tool selectors instead of calling the wrong tool. Nest target
arguments under `args` when a target field matches another cataloged tool.

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

It also keeps core file and shell primitives, client-provided tools, direct-only
tools, and policy-required delivery tools directly visible. Other authorized
tool schemas stay deferred rather than changing with each user prompt. MCP tools
cannot impersonate a directly visible core or policy-required delivery tool. If
the bounded directory omits entries, use `tool_search` to find them and
`tool_describe` to retrieve their full schemas. If the model requests an exact
hidden directory tool name directly, OpenClaw resolves it from the authorized
catalog before normal execution.
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

Code mode attaches a `telemetry` object to every `tool_search_code` result:

- `catalogSize`: number of catalog entries the runtime resolved
- `sources`: catalog entry counts split into `openclaw`, `mcp`, and `client`
- `searchCount`, `describeCount`, `callCount`: running totals for the catalog
  session, carried across calls rather than reset per call

`tools` and `directory` mode emit no telemetry object; their `tool_search`,
`tool_describe`, and `tool_call` results carry only the catalog data for that
operation. OpenClaw does not record serialized tool or prompt byte counts. The
[E2E scenario](#e2e-validation) measures provider payload bytes separately from
the mock provider lane, not from the runtime.

Regardless of mode, target tool calls are projected into the session transcript
as normal tool call and tool result pairs, and search, describe, and call
results carry each tool's `id` and `source`. Session logs therefore still
answer:

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
