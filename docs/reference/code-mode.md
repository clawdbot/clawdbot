---
summary: "OpenClaw code mode: an opt-in compact tool surface backed by QuickJS-WASI and a hidden run-scoped tool catalog"
title: "Code mode"
sidebarTitle: "Code mode"
read_when:
  - You want to enable OpenClaw code mode for an agent run
  - You need to explain why code mode is different from Codex Code mode
  - You are reviewing the compact tool contract, QuickJS-WASI sandbox, TypeScript transform, or hidden tool-catalog bridge
  - You are adding or reviewing an internal code-mode namespace registry integration
---

Code mode is an experimental, opt-in OpenClaw agent-runtime feature. When
enabled, the model no longer sees every enabled tool schema; instead, it sees
`exec`, `wait`, and any direct-only tool whose structured result cannot cross
the JSON-only guest bridge. The model writes a small JavaScript or TypeScript
program that searches, describes, and calls the hidden tool catalog.

This page documents OpenClaw code mode, not Codex Code Mode. The two features
share a name and the same control-tool names (`exec`, `wait`), but they are
separate implementations:

- Codex Code Mode runs inside the Codex coding harness. Its `exec` tool is a
  freeform-grammar tool: the model writes raw JavaScript source (optionally
  prefixed by a `// @exec: {...}` pragma line for execution options), executed
  in a Deno/V8 runtime.
- OpenClaw code mode runs in the generic OpenClaw agent runtime and is
  disabled unless `tools.codeMode.enabled: true` is configured. Its `exec`
  tool takes a JSON `{ code, language }` payload, executed in a QuickJS-WASI
  worker.

Both are JavaScript execution surfaces, not shell-command surfaces. Treat them
as independent, differently-implemented features that happen to expose
identically-named `exec`/`wait` tools.

## What it does

- The model-visible tool list becomes `exec`, `wait`, plus any direct-only tool
  such as `computer` whose image result cannot survive the guest bridge.
- `exec` evaluates model-generated JavaScript or TypeScript in an isolated
  QuickJS-WASI worker thread.
- Every catalog-eligible enabled tool (OpenClaw core, plugin, MCP, client) is hidden from
  the model prompt and exposed inside the guest program through `ALL_TOOLS`
  and `tools`.
- Guest code searches the hidden catalog, describes a tool's schema, and calls
  a tool through the same execution path used by normal agent turns (policy,
  approvals, hooks, telemetry all still apply).
- MCP tools are grouped under the `MCP` namespace; in code mode this is the
  only supported way to call them.
- `wait` resumes a suspended code-mode run when nested tool calls are still
  pending.

Code mode changes the model-facing orchestration surface only. It does not
replace tools, plugin tools, MCP tools, auth, approval policy, channel
behavior, or model selection.

## Why use it

- Smaller prompt surface: providers get two control tools and only the few
  required direct tools instead of dozens or hundreds of full tool schemas.
- Better orchestration: the model can use loops, joins, small transforms,
  conditional logic, and parallel nested tool calls inside one code cell.
- Provider neutral: works for OpenClaw, plugin, MCP, and client tools without
  depending on provider-native code execution.
- Fails closed: if code mode is enabled but the QuickJS-WASI runtime is
  unavailable, the run fails instead of silently falling back to broad direct
  tool exposure.

Most useful for agents with a large enabled tool catalog, or workflows where
the model needs to search, combine, and call several tools before answering.

## Enable it

```json5
{
  tools: {
    codeMode: {
      enabled: true,
    },
  },
}
```

Shorthand:

```json5
{
  tools: {
    codeMode: true,
  },
}
```

Code mode stays off when `tools.codeMode` is omitted, `false`, or an object
without `enabled: true`.

If you use sandboxed agents with configured MCP servers, also allow the
bundled MCP plugin in the sandbox tool policy, for example
`tools.sandbox.tools.alsoAllow: ["bundle-mcp"]`. See
[Configuration - tools and custom providers](/gateway/config-tools#mcp-and-plugin-tools-inside-sandbox-tool-policy).

Set explicit limits for tighter bounds:

```json5
{
  tools: {
    codeMode: {
      enabled: true,
      timeoutMs: 10000,
      memoryLimitBytes: 67108864,
      maxOutputBytes: 65536,
      maxSnapshotBytes: 10485760,
      maxPendingToolCalls: 16,
      snapshotTtlSeconds: 900,
      searchDefaultLimit: 8,
      maxSearchLimit: 50,
    },
  },
}
```

To confirm the model payload shape while debugging, run the Gateway with
targeted logging:

```bash
OPENCLAW_DEBUG_CODE_MODE=1 \
OPENCLAW_DEBUG_MODEL_TRANSPORT=1 \
OPENCLAW_DEBUG_MODEL_PAYLOAD=tools \
openclaw gateway
```

With code mode active, the logged model-facing tool names should be `exec` and
`wait`. For the full redacted provider payload, add
`OPENCLAW_DEBUG_MODEL_PAYLOAD=full-redacted` for a short debugging session.

## Technical tour

The rest of this page covers the runtime contract and implementation details,
for maintainers, plugin authors debugging tool exposure, and operators
validating high-risk deployments.

## Runtime status

|                     |                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Runtime             | [`quickjs-wasi`](https://github.com/vercel-labs/quickjs-wasi)                               |
| Default state       | disabled                                                                                    |
| Stability           | experimental OpenClaw surface (Codex Code Mode is a separate, stable Codex harness surface) |
| Target surface      | generic OpenClaw agent runs                                                                 |
| Security posture    | model code is hostile                                                                       |
| User-facing promise | enabling code mode never silently falls back to broad direct tool exposure                  |

## Scope

Code mode owns the model-facing orchestration shape for a prepared run. It
does not own model selection, channel behavior, auth, tool policy, or tool
implementations.

In scope: model-visible control/direct tool definitions, hidden tool catalog
construction, JavaScript/TypeScript guest execution, the QuickJS-WASI worker
runtime, host callbacks for search/describe/call, resumable state for
suspended guest programs, output/timeout/memory/pending-call/snapshot limits,
and telemetry/trajectory projection for nested tool calls.

Out of scope: provider-native remote code execution, shell execution
semantics, changing existing tool authorization, persistent user-authored
scripts, package manager/file/network/module access in guest code, and direct
reuse of Codex Code Mode internals.

Provider-owned tools such as remote Python sandboxes are separate tools. See
[Code execution](/tools/code-execution).

## Terms

- **Code mode**: the OpenClaw runtime mode that hides catalog-compatible model
  tools and exposes `exec`, `wait`, plus required direct-only tools.
- **Guest runtime**: the QuickJS-WASI JavaScript VM that evaluates model code.
- **Host bridge**: the narrow JSON-compatible callback surface from guest code
  back into OpenClaw.
- **Catalog**: the run-scoped list of effective tools after normal tool
  policy, plugin, MCP, and client-tool resolution.
- **Nested tool call**: a tool call made from guest code through the host
  bridge.
- **Snapshot**: serialized QuickJS-WASI VM state saved so `wait` can continue
  a suspended code-mode run.

## Configuration

`tools.codeMode.enabled` is the activation gate; setting other fields does not
enable the feature on its own.

| Field                 | Default                        | Clamp                                           |
| --------------------- | ------------------------------ | ----------------------------------------------- |
| `enabled`             | `false`                        | boolean; only `true` enables code mode          |
| `runtime`             | `"quickjs-wasi"`               | only supported value                            |
| `mode`                | `"only"`                       | exposes control/direct tools, catalogs the rest |
| `languages`           | `["javascript", "typescript"]` | any subset of the two                           |
| `timeoutMs`           | `10000`                        | `100`-`60000`                                   |
| `memoryLimitBytes`    | `67108864`                     | `1048576`-`1073741824`                          |
| `maxOutputBytes`      | `65536`                        | `1024`-`10485760`                               |
| `maxSnapshotBytes`    | `10485760`                     | `1024`-`268435456`                              |
| `maxPendingToolCalls` | `16`                           | `1`-`128`                                       |
| `snapshotTtlSeconds`  | `900`                          | `1`-`86400`                                     |
| `searchDefaultLimit`  | `8`                            | clamped to `maxSearchLimit`                     |
| `maxSearchLimit`      | `50`                           | `1`-`50`                                        |

If code mode is enabled but QuickJS-WASI cannot load, OpenClaw fails closed
for that run; it does not silently expose normal tools as a fallback.

## Activation

Code mode is evaluated after the effective tool policy is known and before the
final model request is assembled:

1. Resolve the agent, model, provider, sandbox, channel, sender, and run
   policy.
2. Build the effective OpenClaw tool list, adding eligible plugin, MCP, and
   client tools.
3. Apply allow/deny policy.
4. If `tools.codeMode.enabled` is false, continue with normal tool exposure.
5. If enabled and tools are active for the run, retain required direct-only
   tools and register every catalog-eligible effective tool in the code-mode
   catalog.
6. Remove the cataloged tools from the model-visible list; add `exec` and
   `wait` alongside the retained direct-only tools.

Runs that intentionally have no tools (raw model calls, `disableTools: true`,
or an empty `tools.allow` list) do not activate the code-mode surface even
when `tools.codeMode.enabled: true` is configured. Code mode and OpenClaw Tool
Search are mutually exclusive for a run; if code mode activates, Tool Search's
compaction does not.

The code-mode catalog is run-scoped and must not leak tools from another
agent, session, sender, or run.

## Model-visible tools

When code mode is active, the model sees `exec`, `wait`, and any required
direct-only tool. Every other enabled tool is hidden from the model-facing
tool list and registered in the code-mode catalog.

Use `exec` for tool orchestration, data joining, loops, parallel nested calls,
and structured transforms. Use `wait` only when `exec` returns a resumable
`waiting` result.

## `exec`

`exec` starts a code-mode cell and returns one result. Input code is model
generated and must be treated as hostile.

Input:

```typescript
type CodeModeExecInput = {
  code?: string;
  command?: string;
  language?: "javascript" | "typescript";
};
```

Rules:

- One of `code` or `command` must be non-empty.
- `code` is the documented model-facing field.
- `command` is accepted as an exec-compatible alias for hook policies and
  trusted rewrites (the normal OpenClaw shell exec tool also uses a `command`
  field); when both are present, the values must match.
- `language` defaults to `"javascript"`; the schema exposes it as a flat
  string enum (`"javascript" | "typescript"`), not a `oneOf`/`anyOf` union,
  since some providers reject those shapes.
- If `language` is `"typescript"`, OpenClaw transpiles before evaluation.
- `exec` rejects `import`, `require`, dynamic import, and module-loader
  patterns.
- `exec` never exposes the normal shell `exec` implementation recursively.
- Outer code-mode `exec` hook events carry `toolKind: "code_mode_exec"` and
  `toolInputKind: "javascript" | "typescript"` (when known), so policies can
  distinguish code-mode cells from shell-style `exec` calls that share the
  same tool name.

Result:

```typescript
type CodeModeResult = CodeModeCompletedResult | CodeModeWaitingResult | CodeModeFailedResult;

type CodeModeCompletedResult = {
  status: "completed";
  value: unknown;
  output?: CodeModeOutput[];
  telemetry: CodeModeTelemetry;
};

type CodeModeWaitingResult = {
  status: "waiting";
  runId: string;
  reason: "pending_tools" | "yield";
  pendingToolCalls?: CodeModePendingToolCall[];
  output?: CodeModeOutput[];
  telemetry: CodeModeTelemetry;
};

type CodeModeFailedResult = {
  status: "failed";
  error: string;
  code?: CodeModeErrorCode;
  output?: CodeModeOutput[];
  telemetry: CodeModeTelemetry;
};
```

`exec` returns `waiting` when the QuickJS VM suspends with resumable state that
still needs a model-visible continuation; the result includes a `runId` for
`wait`. Namespace bridge calls, including MCP namespace calls, are auto-drained
inside the same `exec`/`wait` call while they are ready, so a compact code
block can call an MCP tool without forcing one model tool call per namespace
await.

`exec` returns `completed` only when the guest VM has no pending work and the
final value is JSON-compatible after OpenClaw's output adapter runs.

## `wait`

`wait` continues a suspended code-mode VM.

Input:

```typescript
type CodeModeWaitInput = {
  runId: string;
};
```

Output is the same `CodeModeResult` union returned by `exec`.

`wait` exists because nested OpenClaw tools can be slow, interactive, approval
gated, or stream partial updates; the model should not need to keep one long
`exec` call open while the host waits for external work.

QuickJS-WASI snapshot/restore is the resume mechanism:

1. `exec` evaluates code until completion, failure, or suspension.
2. On suspension, OpenClaw snapshots the QuickJS VM and records pending host
   work.
3. When pending work settles, `wait` restores the VM snapshot and
   re-registers host callbacks by stable names.
4. OpenClaw delivers nested tool results into the restored VM and drains
   QuickJS pending jobs.
5. `wait` returns `completed`, `failed`, or another `waiting` result.

Snapshots are runtime state, not user artifacts: they live only in an
in-process map (no database or disk write), are size-limited, expire, and are
scoped to the run and session that created them.

`wait` fails (as a `failed` result) when:

- `runId` is unknown or its snapshot already expired.
- the caller is not in the same run/session scope as the suspended run.
- a `wait` is already in flight for that `runId`.
- QuickJS-WASI restore fails.
- resuming would exceed `maxOutputBytes` or `maxSnapshotBytes`.

## Guest runtime API

```typescript
declare const ALL_TOOLS: ToolCatalogEntry[];
declare const tools: ToolCatalog;
declare const MCP: Record<string, unknown>;
declare const namespaces: Record<string, unknown>;

declare function text(value: unknown): void;
declare function json(value: unknown): void;
declare function yield_control(reason?: string): Promise<void>;
```

`ALL_TOOLS` is compact metadata for the run-scoped catalog; it does not
contain full schemas by default.

```typescript
type ToolCatalogEntry = {
  id: string;
  name: string;
  label?: string;
  description: string;
  source: "openclaw" | "mcp" | "client";
  sourceName?: string;
};
```

Plugin tools use `source: "openclaw"` with `sourceName` set to the owning
plugin id; there is no separate `"plugin"` source value. `source: "mcp"` is
used only for MCP entries in `sourceName`/`mcp` metadata (and is filtered out
of `ALL_TOOLS`/`tools.*`, see below).

Full schema is loaded only on demand:

```typescript
type ToolCatalogEntryWithSchema = ToolCatalogEntry & {
  parameters: unknown;
};
```

Catalog helpers:

```typescript
type ToolCatalog = {
  search(query: string, options?: { limit?: number }): Promise<ToolCatalogEntry[]>;
  describe(id: string): Promise<ToolCatalogEntryWithSchema>;
  call(id: string, input?: unknown): Promise<unknown>;
  [safeToolName: string]: unknown;
};
```

Convenience tool functions are installed only for unambiguous safe names:

```typescript
const files = await tools.search("read local file");
const fileRead = await tools.describe(files[0].id);
const content = await tools.call(fileRead.id, { path: "README.md" });

// If the hidden catalog has an unambiguous `web_search` entry:
const hits = await tools.web_search({ query: "OpenClaw code mode" });
```

MCP catalog entries are not callable through `tools.call(...)` or convenience
functions in code mode; they are exposed only through the generated `MCP`
namespace. TypeScript-style declaration files are available through the
read-only `API` virtual file surface, so agents can inspect MCP signatures
without adding MCP schemas to the prompt:

```typescript
const files = await API.list("mcp");
const githubApi = await API.read("mcp/github.d.ts");

const issue = await MCP.github.createIssue({
  owner: "openclaw",
  repo: "openclaw",
  title: "Investigate gateway logs",
});

const snapshot = await MCP.chromeDevtools.takeSnapshot({ output: "markdown" });
const resource = await MCP.docs.resources.read({ uri: "memo://one" });
const prompt = await MCP.docs.prompts.get({
  name: "brief",
  arguments: { topic: "release" },
});
```

`API.read("mcp/<server>.d.ts")` returns compact declarations inferred from MCP
tool metadata:

```typescript
type McpToolResult = {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
};

declare namespace MCP.github {
  /** Return this TypeScript-style API header. */
  function $api(toolName?: string, options?: { schema?: boolean }): Promise<McpApiHeader>;

  /**
   * Create a GitHub issue.
   * @param owner Repository owner
   * @param repo Repository name
   * @param title Issue title
   */
  function createIssue(input: {
    owner: string;
    repo: string;
    title: string;
    body?: string;
  }): Promise<McpToolResult>;
}
```

Declaration files are virtual, not written under the workspace or state
directory. For each code-mode `exec` call, OpenClaw builds the run-scoped tool
catalog, keeps the visible MCP entries, renders `mcp/index.d.ts` plus one
`mcp/<server>.d.ts` per visible server, and injects that small read-only table
into the QuickJS worker. Guest code sees only the `API` object:
`API.list(prefix?)` returns file metadata and `API.read(path)` returns the
selected declaration content. Unknown paths and `.`/`..` segments are
rejected.

This keeps large MCP schemas out of the model prompt: the agent learns the
virtual API exists from the `exec` tool description, reads only the needed
declaration file, then calls `MCP.<server>.<tool>()` with one object argument.
`MCP.<server>.$api()` remains available as an inline fallback for a
single-tool schema response inside the program.

The guest runtime never sees host objects directly. Inputs and outputs cross
the bridge as JSON-compatible values with explicit size caps.

## Internal namespaces

Internal namespaces give code mode a concise domain API without adding more
model-visible tools. A loader-owned integration registers a namespace such as
`Issues` or `Calendar`; guest code then calls that namespace inside the
QuickJS program while the model still sees the compact control/direct surface.

Namespaces are internal for now. There is no public plugin SDK namespace API:
external plugin namespaces need a loader-owned contract so plugin identity,
installed manifests, auth state, and cached catalog descriptors cannot drift
from the plugin tools that back the namespace. Core code mode owns only the
sandbox, serialization, catalog gating, and bridge dispatch.

Guest code can use either the direct global or the `namespaces` map:

```javascript
const open = await Issues.list({ state: "open" });
const alsoOpen = await namespaces.Issues.list({ state: "open" });
return { count: open.length, alsoCount: alsoOpen.length };
```

### Registry lifecycle

The namespace registry is process-local and keyed by namespace id:

1. A trusted loader calls `registerCodeModeNamespaceForPlugin(pluginId, registration)`.
2. Code mode creates the hidden `ToolSearchRuntime` for the run and reads its
   run-scoped catalog.
3. `createCodeModeNamespaceRuntime(ctx, catalog)` keeps only registrations
   whose `requiredToolNames` are all visible and owned by the same `pluginId`.
4. Each visible namespace calls `createScope(ctx)` for the current run,
   receiving run context such as `agentId`, `sessionKey`, `sessionId`,
   `runId`, config, and abort state.
5. Scope data is serialized into a plain descriptor and injected into QuickJS
   as direct globals and `namespaces.<globalName>`.
6. Guest calls suspend through the worker bridge, resolve the namespace path
   on the host, map the call to a declared plugin-owned catalog tool, and
   execute that tool through `ToolSearchRuntime.callExactId`.
7. Ready namespace bridge calls are auto-drained inside the active
   `exec`/`wait` call; if namespace work is still pending at the timeout or
   the guest yields explicitly, `wait` resumes the same namespace runtime
   later.
8. Plugin rollback or uninstall calls
   `clearCodeModeNamespacesForPlugin(pluginId)` so stale globals do not
   survive a failed plugin load.

Namespace calls are catalog tool calls: they use the same policy hooks,
approvals, abort handling, telemetry, transcript projection, and
suspend/resume behavior as `tools.call(...)`.

### Registration shape

Register namespaces from the integration that owns the backing tools. Keep
the scope small and only expose domain verbs that map to declared catalog
tools.

```typescript
import {
  createCodeModeNamespaceTool,
  registerCodeModeNamespaceForPlugin,
} from "../agents/code-mode-namespaces.js";

const pluginId = "github";

registerCodeModeNamespaceForPlugin(pluginId, {
  id: "github-issues",
  globalName: "Issues",
  description: "GitHub issue helpers for the current repository.",
  requiredToolNames: ["github_list_issues", "github_update_issue"],
  prompt: "Use Issues.list(params) and Issues.update(number, patch).",
  createScope: (ctx) => ({
    repository: ctx.config,
    list: createCodeModeNamespaceTool("github_list_issues", ([params]) => params ?? {}),
    update: createCodeModeNamespaceTool("github_update_issue", ([number, patch]) => ({
      number,
      patch,
    })),
  }),
});
```

`createCodeModeNamespaceTool(toolName, inputMapper)` marks a scope member as a
callable namespace function. The optional `inputMapper` receives the guest
arguments and returns the input object for the backing catalog tool; without
one, the first guest argument is used, or `{}` when omitted.

Raw host functions are rejected before guest code runs:

```typescript
createScope: () => ({
  // Wrong: this bypasses the catalog tool lifecycle and will be rejected.
  list: async () => githubClient.listIssues(),
});
```

### Ownership and visibility

Namespace ownership is bound to the registration caller's `pluginId`.
`requiredToolNames` is both a visibility gate and an ownership check:

- every required tool must exist in the run catalog
- every required tool must have `sourceName === pluginId`
- the namespace is hidden when any required tool is absent or owned by
  another plugin
- each callable path may target only a tool named in `requiredToolNames`

This prevents another plugin from exposing a namespace by registering a
same-named tool, and keeps namespaces aligned with ordinary agent policy: if
the run cannot see the backing tools, it cannot see the namespace.

For example, a GitHub namespace should live behind a GitHub-owned plugin that
owns GitHub auth, REST/GraphQL clients, rate limits, write approvals, and
tests. Core code mode should not embed GitHub-specific APIs, token handling,
or provider policy.

### Scope serialization rules

`createScope(ctx)` may return a plain object containing JSON-compatible
values, arrays, nested objects, and `createCodeModeNamespaceTool(...)` call
markers. Host objects never enter QuickJS directly.

The serializer rejects:

- raw functions
- circular object graphs
- unsafe path segments: `__proto__`, `constructor`, `prototype`, empty keys,
  or keys containing the internal path separator
- `globalName` values that are not JavaScript identifiers
- `globalName` collisions with built-in code-mode globals such as `tools`,
  `namespaces`, `text`, `json`, `yield_control`, `MCP`, `API`, `ALL_TOOLS`, or
  `__openclaw*`

Values that cannot be JSON-serialized are converted to JSON-safe fallback
values before crossing the bridge. Binary data, handles, sockets, clients, and
class instances should stay behind ordinary catalog tools.

### Prompts

The namespace `description` and optional `prompt` are appended to the model
visible `exec` schema only when the namespace is visible for that run. Use
them to teach the smallest useful surface:

```typescript
{
  description: "Fiction production service helpers.",
  prompt:
    "Use Fictions.riskAudit(), Fictions.promoteIfReady(id, status), and Fictions.unpaidOver(amount).",
}
```

Keep prompts about the namespace contract, not auth setup, implementation
history, or unrelated plugin behavior.

### Cleanup

Namespaces are process-local registrations. Remove them when the owning
plugin is disabled, uninstalled, or rolled back:

```typescript
clearCodeModeNamespacesForPlugin(pluginId);
```

Code-mode cleanup is plugin-owned; clear the plugin's namespace registrations
when its lifecycle ends instead of keeping per-namespace teardown handles.
Tests can call `clearCodeModeNamespacesForTest()` to avoid leaking
registrations across cases.

### Test checklist

Namespace changes should cover the security boundary and the guest behavior:

- namespace prompt text appears only when backing tools are visible
- same-named tools from another `sourceName` do not expose the namespace
- raw scope functions are rejected
- forged namespace ids and forged paths are rejected
- callable paths cannot target undeclared tools
- nested objects and shared references serialize correctly
- namespace calls execute through catalog tools and return JSON-safe details
- failures can be caught by guest code
- suspended namespace calls resume through `wait`
- plugin rollback clears the owning namespace registrations

Namespaces complement the generic `tools.search`/`tools.call` catalog: use the
catalog for arbitrary enabled OpenClaw, plugin, and client tools; use `MCP`
for MCP tools; use other namespaces for plugin-owned, documented domain APIs
where concise code is more reliable than repeated schema lookups.

## Output API

- `text(value)` appends human-readable output to the `output` array.
- `json(value)` appends a structured output item after JSON-compatible
  serialization.
- The guest code's final returned value becomes `value` in a `completed`
  result.

```typescript
type CodeModeOutput = { type: "text"; text: string } | { type: "json"; value: unknown };
```

Rules: output order matches guest calls; output is capped by
`maxOutputBytes`; non-serializable values are converted to plain strings or
errors; binary values are not supported. Images and files travel through
ordinary OpenClaw tools, not through the code-mode bridge.

## Tool catalog

The hidden catalog includes tools after effective policy filtering, in this
order: OpenClaw core tools, bundled plugin tools, external plugin tools, MCP
tools, then client-provided tools for the current run.

Catalog ids are stable within one run and deterministic across equivalent
tool sets when possible. Actual shape:

```text
<source>:<owner>:<tool-name>
```

where `<source>` is `openclaw`, `mcp`, or `client` (plugin tools use
`openclaw` with the plugin id as `<owner>`; core tools use `openclaw:core:*`).
Examples:

```text
openclaw:core:message
openclaw:browser:browser_request
mcp:github:create_issue
client:app:select_file
```

The catalog omits code-mode control tools (`exec`, `wait`, `tool_search_code`,
`tool_search`, `tool_describe`, `tool_call`) and direct-only tools. Controls
must not recurse through the catalog; direct-only tools remain model-visible
because their structured results cannot cross the QuickJS bridge.

MCP entries stay in the run-scoped catalog so policy, approvals, hooks,
telemetry, transcript projection, and exact tool ids remain shared with
normal tool execution. The guest-facing `ALL_TOOLS`, `tools.search(...)`,
`tools.describe(...)`, and `tools.call(...)` views omit MCP entries. The
generated `MCP.<server>.<tool>({ ...input })` namespace resolves back to the
exact catalog id and dispatches through the same executor path.

## Tool Search interaction

Code mode supersedes the OpenClaw Tool Search model surface for runs where it
is active.

When `tools.codeMode.enabled` is true and code mode activates:

- OpenClaw does not expose `tool_search_code`, `tool_search`, `tool_describe`,
  or `tool_call` as model-visible tools.
- The same cataloging idea moves inside the guest runtime.
- The guest runtime receives compact `ALL_TOOLS` metadata and search/describe/
  call helpers for non-MCP tools.
- MCP calls use the generated `MCP` namespace and its `$api()` headers instead
  of `tools.call(...)`.
- Nested calls dispatch through the same OpenClaw executor path that Tool
  Search uses.

See [Tool Search](/tools/tool-search) for the OpenClaw compact catalog bridge
that code mode supersedes for active runs.

## Tool names and collisions

The model-visible `exec` tool is the code-mode tool. If the normal OpenClaw
shell `exec` tool is enabled, it is hidden from the model and cataloged like
any other tool.

Inside the guest runtime:

- `tools.call("openclaw:core:exec", input)` can call the shell exec tool if
  policy allows it.
- `tools.exec(...)` is installed only if the shell exec catalog entry has an
  unambiguous safe name.
- the code-mode `exec` tool is never recursively available through `tools`.

If two tools normalize to the same safe convenience name, OpenClaw omits the
convenience function and requires `tools.call(id, input)`.

## Nested tool execution

Every nested tool call crosses the host bridge and re-enters OpenClaw,
preserving: active agent id, session id and key, sender and channel context,
sandbox policy, approval policy, plugin `before_tool_call` hooks, abort
signal, streaming updates where available, and trajectory/audit events.

Nested calls project into the transcript as real tool calls so support
bundles show what happened, with the projection identifying the parent
code-mode tool call and the nested tool id.

Parallel nested calls are allowed up to `maxPendingToolCalls`.

## Run and snapshot lifecycle

Each code-mode run is tracked in an in-process map keyed by `runId` (not
persisted to disk or a database). `exec`/`wait` return one of three result
statuses: `completed`, `waiting`, or `failed`.

- A `waiting` result stores the QuickJS snapshot, pending bridge requests, and
  scoping metadata (agent run id, session id/key) until `wait` resumes it or
  it expires.
- Expiry, wrong-session, wrong-run, and unknown/already-resuming `runId`
  values do not produce a distinct terminal status; they surface as a
  `failed` result (`code: "invalid_input"`) with a message such as `code mode
run is unavailable or expired.` or `code mode run belongs to a different
session.`.
- A run's snapshot is removed from the map as soon as it settles to
  `completed` or `failed`, or is dropped on Gateway shutdown (nothing
  survives a restart, by design: this is transient runtime state).
- OpenClaw caps the number of concurrently suspended runs per process (64) and
  rejects new suspensions past that cap with `too many suspended code mode
runs.`.

Snapshot storage is bounded by `maxSnapshotBytes` per run, the per-process
suspended-run cap above, and `snapshotTtlSeconds`.

## QuickJS-WASI runtime

OpenClaw loads `quickjs-wasi` as a direct dependency in the owning package; it
does not rely on a transitive copy installed for an unrelated dependency.

Runtime responsibilities: compile/load the QuickJS-WASI WebAssembly module;
create one isolated VM per code-mode run or resume; register host callbacks
by stable names; set memory and interrupt limits; evaluate JavaScript; drain
pending jobs; snapshot suspended VM state; restore snapshots for `wait`;
dispose VM handles and snapshots after terminal states.

The runtime executes in a Node.js worker thread, outside OpenClaw's main
event loop. A guest infinite loop must not block the Gateway process
indefinitely; the worker's interrupt handler enforces the wall-clock timeout
independent of guest code cooperating.

## TypeScript

TypeScript support is a source transform only: accepted input is one
TypeScript code string; output is a JavaScript string evaluated by
QuickJS-WASI. There is no typechecking, no module resolution, and no
`import`/`require`. Diagnostics are returned as `failed` results.

The TypeScript compiler is loaded lazily only for TypeScript cells; plain
JavaScript cells and disabled code mode never load it.

## Security boundary

Model code is hostile. The runtime uses defense in depth:

- runs QuickJS-WASI outside the main event loop, in a worker thread
- loads `quickjs-wasi` as a direct dependency, not through Codex or a
  transitive package
- no filesystem, network, subprocess, module import, environment variables,
  or host global objects in the guest
- uses QuickJS memory and interrupt limits plus a parent-process wall-clock
  timeout
- enforces output, snapshot, log, and pending-call caps
- serializes host bridge values through a narrow JSON adapter
- converts host errors into plain guest errors, never host realm objects
- drops snapshots on timeout, abort, session end, or expiry
- rejects recursive access to `exec`, `wait`, and Tool Search control tools
- prevents convenience-name collisions from shadowing catalog helpers

The sandbox is one security layer; operators may still need OS-level
hardening for high-risk deployments.

## Error codes

```typescript
type CodeModeErrorCode =
  | "invalid_input"
  | "runtime_unavailable"
  | "timeout"
  | "output_limit_exceeded"
  | "snapshot_limit_exceeded"
  | "internal_error";
```

`invalid_input` covers bad `exec`/`wait` arguments, disabled languages,
rejected module access, TypeScript transform failures, unknown/expired/
wrong-scope `runId` values, and too many suspended runs. `runtime_unavailable`
covers a QuickJS worker that fails to start or exits non-zero.

Errors returned to the guest are plain data; host `Error` instances, stack
objects, prototypes, and host functions do not cross into QuickJS.

## Telemetry

Each result's `telemetry` field reports: hidden catalog size and a source
breakdown (`openclaw`/`mcp`/`client` counts), cumulative search/describe/call
counts for the run's catalog, and the model-visible tool names (`exec`,
`wait`, and retained direct-only tools).

Telemetry must not include secrets, raw environment values, or unredacted
tool inputs beyond existing OpenClaw trajectory policy.

## Debugging

Use targeted model transport logging when code mode behaves differently from
a normal tool run:

```bash
OPENCLAW_DEBUG_CODE_MODE=1 \
OPENCLAW_DEBUG_MODEL_TRANSPORT=1 \
OPENCLAW_DEBUG_MODEL_PAYLOAD=tools \
OPENCLAW_DEBUG_SSE=events \
openclaw gateway
```

For payload-shape debugging, use `OPENCLAW_DEBUG_MODEL_PAYLOAD=full-redacted`.
This logs a capped, redacted JSON snapshot of the model request; use it only
while debugging, since prompts and message text can still appear.

For stream debugging, use `OPENCLAW_DEBUG_SSE=peek` to log the first five
redacted SSE events. Code mode also fails closed if the final provider
payload does not contain exactly one `exec`, one `wait`, and only approved
direct-only tools after the code-mode surface has activated.

## Implementation layout

- config contract: `tools.codeMode`
- catalog builder: effective tools to compact entries and id map
- model-surface adapter: replace visible tools with control/direct tools
- QuickJS-WASI runtime adapter: load, eval, snapshot, restore, dispose
- worker supervisor: timeout, abort, crash isolation
- bridge adapter: JSON-safe host callbacks and result delivery
- TypeScript transform adapter
- snapshot store: TTL, size caps, run/session scoping
- trajectory projection for nested tool calls
- telemetry counters and diagnostics

The implementation reuses catalog and executor concepts from Tool Search, but
does not use a `node:vm` child as the sandbox.

## Validation checklist

Code mode coverage should prove:

- disabled config leaves existing tool exposure unchanged
- object config without `enabled: true` leaves code mode disabled
- enabled config exposes `exec`, `wait`, and only required direct-only tools to
  the model when tools are active for the run
- raw no-tool runs, `disableTools`, and empty allowlists do not trigger
  code-mode payload enforcement
- all catalog-eligible effective non-MCP tools appear in `ALL_TOOLS`
- direct-only tools stay model-visible and do not appear in `ALL_TOOLS`
- denied tools do not appear in `ALL_TOOLS`
- `tools.search`, `tools.describe`, and `tools.call` work for OpenClaw tools
- `API.list("mcp")` and `API.read("mcp/<server>.d.ts")` expose TypeScript-style
  MCP declarations without a bridge/tool call
- MCP namespace `$api()` remains available as an inline fallback for schemas
- MCP namespace calls work for visible MCP tools with one object input, while
  direct MCP catalog entries are absent from `tools.*`
- Tool Search control tools are hidden from both the model surface and the
  hidden catalog
- nested calls preserve approval and hook behavior
- shell `exec` is hidden from the model but callable by catalog id when
  allowed
- recursive code-mode `exec` and `wait` are not callable from guest code
- TypeScript input is transformed and evaluated without loading TypeScript on
  disabled or JavaScript-only paths
- `import`, `require`, filesystem, network, and environment access fail
- infinite loops time out and cannot block the Gateway
- memory cap failures terminate the guest VM
- output and snapshot caps are enforced for completed and suspended calls
- `wait` resumes a suspended snapshot and returns the final value
- expired, aborted, wrong-session, and unknown `runId` values fail
- transcript replay and persistence preserve code-mode control calls
- transcript and telemetry show nested tool calls clearly

## E2E test plan

Run these as integration or end-to-end tests when changing the runtime:

1. Start a Gateway with `tools.codeMode.enabled: false`.
2. Send an agent turn with a small direct tool set.
3. Assert the model-visible tools are unchanged.
4. Restart with `tools.codeMode.enabled: true`.
5. Send an agent turn with OpenClaw, plugin, MCP, and client test tools.
6. Assert the model-visible tool list is `exec`, `wait`, plus only configured
   direct-only tools.
7. In `exec`, read `ALL_TOOLS` and assert the catalog-eligible effective test
   tools are present while direct-only tools are absent.
8. In `exec`, call OpenClaw/plugin/client tools through `tools.search`,
   `tools.describe`, and `tools.call`.
9. In `exec`, call `API.list("mcp")` and `API.read("mcp/<server>.d.ts")` and
   assert the declaration files describe visible MCP tools.
10. In `exec`, call MCP tools through `MCP.<server>.<tool>({ ...input })` and
    assert direct MCP catalog entries are absent from `ALL_TOOLS` and
    `tools.*`.
11. Assert denied tools are absent and cannot be called by guessed id.
12. Start a nested tool call that resolves after `exec` returns `waiting`.
13. Call `wait` and assert the restored VM receives the tool result.
14. Assert the final answer contains output produced after restore.
15. Assert timeout, abort, and snapshot expiry clean up runtime state.
16. Export trajectory and assert nested calls are visible under the parent
    code-mode call.

Docs-only changes to this page should still run `pnpm check:docs`.

## Related

- [Tool Search](/tools/tool-search)
- [Agent runtimes](/concepts/agent-runtimes)
- [Exec tool](/tools/exec)
- [Code execution](/tools/code-execution)
