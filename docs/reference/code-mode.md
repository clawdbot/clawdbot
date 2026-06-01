---
summary: "OpenClaw code mode: an opt-in exec/wait tool surface backed by QuickJS-WASI and a hidden run-scoped tool catalog"
title: "Code mode"
sidebarTitle: "Code mode"
read_when:
  - You want to enable OpenClaw code mode for an agent run
  - You need to explain why code mode is different from Codex Code mode
  - You are reviewing the exec/wait contract, QuickJS-WASI sandbox, TypeScript transform, or hidden tool-catalog bridge
  - You are adding or reviewing an internal code-mode namespace registry integration
---

Code mode is an experimental OpenClaw agent-runtime feature. It is off by
default. When you enable it, OpenClaw changes what the model sees for one run:
instead of exposing every enabled tool schema directly, the model sees only
`exec` and `wait`.

This page documents OpenClaw code mode. It is not Codex Code mode. The two
features share a name, but they are implemented by different runtimes and expose
different `exec` contracts:

- Codex Code Mode is enabled for Codex app-server threads unless restricted
  tool policy disables native code mode. It runs in the Codex coding harness,
  where the model writes shell commands through an `exec.command` contract.
- OpenClaw code mode is disabled unless `tools.codeMode.enabled: true` is
  configured. It runs in the OpenClaw generic agent runtime, where the model
  writes JavaScript or TypeScript programs through an `exec.code` contract.

Codex Code Mode and Codex-native dynamic tool search are stable Codex harness
surfaces. OpenClaw code mode is an OpenClaw-owned experimental tool-surface
adapter for generic OpenClaw runs. It uses `quickjs-wasi`, a hidden OpenClaw
tool catalog, and the normal OpenClaw tool executor.

## What is this?

OpenClaw code mode lets the model write a small JavaScript or TypeScript program
instead of choosing directly from a long list of tools.

When code mode is active:

- The model-visible tool list is exactly `exec` and `wait`.
- `exec` evaluates model-generated JavaScript or TypeScript in a constrained
  QuickJS-WASI worker.
- Normal OpenClaw tools are hidden from the model prompt and exposed inside the
  guest program through `ALL_TOOLS` and `tools`.
- Guest code can search the hidden catalog, describe a tool, and call a tool
  through the same OpenClaw execution path used by normal agent turns.
- MCP tools are grouped under the `MCP` namespace. In code mode, this namespace
  is the only supported way to call MCP tools.
- `wait` resumes a suspended code-mode run when nested tool calls are still
  pending.

The important distinction: code mode changes the model-facing orchestration
surface. It does not replace OpenClaw tools, plugin tools, MCP tools, auth,
approval policy, channel behavior, or model selection.

## Why is this good?

Code mode makes large tool catalogs easier for models to use.

- Smaller prompt surface: providers receive two control tools instead of dozens
  or hundreds of full tool schemas.
- Better orchestration: the model can use loops, joins, small transforms,
  conditional logic, and parallel nested tool calls inside one code cell.
- Provider neutral: it works for OpenClaw, plugin, MCP, and client tools without
  depending on provider-native code execution.
- Existing policy stays in force: nested tool calls still go through OpenClaw
  policy, approvals, hooks, session context, and audit paths.
- Clear failure mode: when code mode is explicitly enabled and the runtime is
  unavailable, OpenClaw fails closed instead of falling back to broad direct tool
  exposure.

Code mode is especially useful for agents with a large enabled tool catalog or
for workflows where the model repeatedly needs to search, combine, and call
tools before producing an answer.

## How to enable it

Add `tools.codeMode.enabled: true` to the agent or runtime config:

```json5
{
  tools: {
    codeMode: {
      enabled: true,
    },
  },
}
```

The shorthand is also accepted:

```json5
{
  tools: {
    codeMode: true,
  },
}
```

Code mode remains off when `tools.codeMode` is omitted, `false`, or an object
without `enabled: true`.

When you use sandboxed agents with configured MCP servers, also make sure the
sandbox tool policy allows the bundled MCP plugin, for example with
`tools.sandbox.tools.alsoAllow: ["bundle-mcp"]`. See
[Configuration - tools and custom providers](/gateway/config-tools#mcp-and-plugin-tools-inside-sandbox-tool-policy).

Use explicit limits when you want tighter bounds:

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
`wait`. If you need the redacted provider payload, add
`OPENCLAW_DEBUG_MODEL_PAYLOAD=full-redacted` for a short debugging session.

## Technical tour

The rest of this page describes the runtime contract and implementation details.
It is intended for maintainers, plugin authors debugging tool exposure, and
operators validating high-risk deployments.

## Runtime status

- Runtime: [`quickjs-wasi`](https://github.com/vercel-labs/quickjs-wasi).
- Default state: disabled.
- Stability: experimental OpenClaw surface; Codex Code mode is a separate stable
  Codex harness surface.
- Target surface: generic OpenClaw agent runs.
- Security posture: model code is hostile.
- User-facing promise: enabling code mode never silently falls back to broad
  direct tool exposure.

## Scope

Code mode owns the model-facing orchestration shape for a prepared run. It does
not own model selection, channel behavior, auth, tool policy, or tool
implementations.

In scope:

- model-visible `exec` and `wait` tool definitions
- hidden tool catalog construction
- JavaScript and TypeScript guest execution
- QuickJS-WASI worker runtime
- host callbacks for catalog search, schema describe, and tool call
- resumable state for suspended guest programs
- output, timeout, memory, pending-call, and snapshot limits
- telemetry and trajectory projection for nested tool calls

Out of scope:

- provider-native remote code execution
- shell execution semantics
- changing existing tool authorization
- persistent user-authored scripts
- package manager, file, network, or module access in guest code
- direct reuse of Codex Code mode internals

Provider-owned tools such as remote Python sandboxes remain separate tools. See
[Code execution](/tools/code-execution).

## Terms

**Code mode** is the OpenClaw runtime mode that hides normal model tools and
exposes only `exec` and `wait`.

**Guest runtime** is the QuickJS-WASI JavaScript VM that evaluates model code.

**Host bridge** is the narrow JSON-compatible callback surface from guest code
back into OpenClaw.

**Catalog** is the run-scoped list of effective tools after normal tool policy,
plugin, MCP, and client-tool resolution.

**Nested tool call** is a tool call made from guest code through the host bridge.

**Snapshot** is serialized QuickJS-WASI VM state saved so `wait` can continue a
suspended code-mode run.

## Configuration

`tools.codeMode.enabled` is the activation gate. Setting other code-mode fields
does not enable the feature.

Supported fields:

- `enabled`: boolean. Default `false`. Enables code mode only when `true`.
- `runtime`: `"quickjs-wasi"`. Only supported runtime.
- `mode`: `"only"`. Exposes `exec` and `wait`, hides normal model tools.
- `languages`: array of `"javascript"` and `"typescript"`. Default includes
  both.
- `timeoutMs`: wall-clock cap for one `exec` or `wait`. Default `10000`.
  Runtime clamp: `100` to `60000`.
- `memoryLimitBytes`: QuickJS heap cap. Default `67108864`. Runtime clamp:
  `1048576` to `1073741824`.
- `maxOutputBytes`: cap for returned text, JSON, and logs. Default `65536`.
  Runtime clamp: `1024` to `10485760`.
- `maxSnapshotBytes`: cap for serialized VM snapshots. Default `10485760`.
  Runtime clamp: `1024` to `268435456`.
- `maxPendingToolCalls`: cap for concurrent nested tool calls. Default `16`.
  Runtime clamp: `1` to `128`.
- `snapshotTtlSeconds`: how long a suspended VM can be resumed. Default `900`.
  Runtime clamp: `1` to `86400`.
- `searchDefaultLimit`: default hidden-catalog search result count. Default `8`.
  Runtime clamps this to `maxSearchLimit`.
- `maxSearchLimit`: maximum hidden-catalog search result count. Default `50`.
  Runtime clamp: `1` to `50`.

If code mode is enabled but QuickJS-WASI cannot load, OpenClaw fails closed for
that run. It does not silently expose normal tools as a fallback.

## Activation

Code mode is evaluated after the effective tool policy is known and before the
final model request is assembled.

Activation order:

1. Resolve the agent, model, provider, sandbox, channel, sender, and run policy.
2. Build the effective OpenClaw tool list.
3. Add eligible plugin, MCP, and client tools.
4. Apply allow and deny policy.
5. If `tools.codeMode.enabled` is false, continue with normal tool exposure.
6. If enabled and tools are active for the run, register the effective tools in
   the code-mode catalog.
7. Remove all normal tools from the model-visible tool list.
8. Add code-mode `exec` and `wait`.

Runs that intentionally have no tools, such as raw model calls, `disableTools`,
or an empty allowlist, do not activate the code-mode surface even if the config
contains `tools.codeMode.enabled: true`.

The code-mode catalog is run-scoped. It must not leak tools from another agent,
session, sender, or run.

## Model-visible tools

When code mode is active, the model sees exactly these top-level tools:

- `exec`
- `wait`

All other enabled tools are hidden from the model-facing tool list and registered
in the code-mode catalog.

The model should use `exec` for tool orchestration, data joining, loops,
parallel nested calls, and structured transformations. The model should use
`wait` only when `exec` returns a resumable `waiting` result.

## `exec`

`exec` starts a code-mode cell and returns one result. The input code is model
generated and must be treated as hostile.

Input:

```typescript
type CodeModeExecInput = {
  code?: string;
  command?: string;
  language?: "javascript" | "typescript";
};
```

Input rules:

- One of `code` or `command` must be non-empty.
- `code` is the documented model-facing field.
- `command` is accepted as an exec-compatible alias for hook policies and
  trusted rewrites; when both are present, the values must match.
- Outer code-mode `exec` hook events include `toolKind: "code_mode_exec"` and
  include `toolInputKind: "javascript" | "typescript"` when the input language
  is known, so policies can distinguish code-mode cells from shell-style `exec`
  calls that share the same tool name.
- `language` defaults to `"javascript"`.
- If `language` is `"typescript"`, OpenClaw transpiles before evaluation.
- `exec` rejects `import`, `require`, dynamic import, and module-loader patterns
  in v1.
- `exec` does not expose the normal shell `exec` implementation recursively.

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
still needs a model-visible continuation. The result includes a `runId` for
`wait`. Namespace bridge calls, including MCP namespace calls, are auto-drained
inside the same `exec`/`wait` call while they are ready, so a compact code block
can inspect `$api()` and call an MCP tool without forcing one model tool call per
namespace await.

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

The output is the same `CodeModeResult` union returned by `exec`.

`wait` exists because nested OpenClaw tools can be slow, interactive, approval
gated, or stream partial updates. The model should not need to keep one long
`exec` call open while the host waits for external work.

QuickJS-WASI snapshot and restore is the v1 resume mechanism:

1. `exec` evaluates code until completion, failure, or suspension.
2. On suspension, OpenClaw snapshots the QuickJS VM and records pending host
   work.
3. When pending work settles, `wait` restores the VM snapshot.
4. OpenClaw re-registers host callbacks by stable names.
5. OpenClaw delivers nested tool results into the restored VM.
6. OpenClaw drains QuickJS pending jobs.
7. `wait` returns `completed`, `failed`, or another `waiting` result.

Snapshots are runtime state, not user artifacts. They are size-limited, expired,
and scoped to the run and session that created them.

`wait` fails when:

- `runId` is unknown.
- the snapshot expired.
- the parent run or session was aborted.
- the caller is not in the same run/session scope.
- QuickJS-WASI restore fails.
- restoring would exceed configured limits.

## Guest runtime API

The guest runtime exposes a small global API:

```typescript
declare const ALL_TOOLS: ToolCatalogEntry[];
declare const tools: ToolCatalog;
declare const MCP: Record<string, unknown>;
declare const namespaces: Record<string, unknown>;

declare function text(value: unknown): void;
declare function json(value: unknown): void;
declare function yield_control(reason?: string): Promise<void>;
```

`ALL_TOOLS` is compact metadata for the run-scoped catalog. It does not contain
full schemas by default.

```typescript
type ToolCatalogEntry = {
  id: string;
  name: string;
  label?: string;
  description: string;
  source: "openclaw" | "plugin" | "mcp" | "client";
  sourceName?: string;
};
```

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
functions in code mode. They are exposed only through the generated `MCP`
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

The declaration files are virtual, not files written under the workspace or
state directory. For each code-mode `exec` call, OpenClaw builds the run-scoped
tool catalog, keeps the visible MCP entries, renders `mcp/index.d.ts` plus one
`mcp/<server>.d.ts` declaration per visible server, and injects that small
read-only table into the QuickJS worker. Guest code sees only the `API` object:
`API.list(prefix?)` returns file metadata and `API.read(path)` returns the
selected declaration content. Unknown paths and `.` / `..` segments are rejected.

This keeps large MCP schemas out of the model prompt. The agent learns that the
virtual API exists from the `exec` tool description, reads only the needed
declaration file, and then calls `MCP.<server>.<tool>()` with one object argument.
`MCP.<server>.$api()` remains available as an inline fallback when the agent
needs a single-tool schema response inside the program.

The guest runtime must not expose host objects directly. Inputs and outputs cross
the bridge as JSON-compatible values with explicit size caps.

## Internal namespaces

Internal namespaces give code mode a concise domain API without adding more
model-visible tools. A loader-owned integration can register a namespace such
as `Issues`, `Fictions`, or `Calendar`; guest code then calls that namespace
inside the QuickJS program while OpenClaw still shows only `exec` and `wait` to
the model.

Namespaces are internal for now. There is no public plugin SDK namespace API:
external plugin namespaces need a loader-owned contract so plugin identity,
installed manifests, auth state, and cached catalog descriptors cannot drift
from the plugin tools that back the namespace. Core code mode owns only the
sandbox, serialization, catalog gating, and bridge dispatch.

Guest code can then use either the direct global or the `namespaces` map:

```javascript
const open = await Issues.list({ state: "open" });
const alsoOpen = await namespaces.Issues.list({ state: "open" });
return { count: open.length, alsoCount: alsoOpen.length };
```

### Registry lifecycle

The namespace registry is process-local and keyed by namespace id. A typical
run follows this path:

1. A trusted loader calls `registerCodeModeNamespaceForPlugin(pluginId, registration)`.
2. Code mode creates the hidden `ToolSearchRuntime` for the run and reads its
   run-scoped catalog.
3. `createCodeModeNamespaceRuntime(ctx, catalog)` keeps only registrations
   whose `requiredToolNames` are all visible and owned by the same `pluginId`.
4. Each visible namespace calls `createScope(ctx)` for the current run. The
   scope receives run context such as `agentId`, `sessionKey`, `sessionId`,
   `runId`, config, and abort state.
5. Scope data is serialized into a plain descriptor and injected into QuickJS as
   direct globals and `namespaces.<globalName>`.
6. Guest calls suspend through the worker bridge, resolve the namespace path on
   the host, map the call to a declared plugin-owned catalog tool, and execute
   that tool through `ToolSearchRuntime.call`.
7. OpenClaw auto-drains ready namespace bridge calls inside the active
   `exec`/`wait` tool call. If namespace work is still pending at the timeout or
   the guest yields explicitly, `wait` resumes the same namespace runtime later.
8. Plugin rollback or uninstall calls `clearCodeModeNamespacesForPlugin(pluginId)`
   so stale globals do not survive a failed plugin load.

The important invariant: namespace calls are catalog tool calls. They use the
same policy hooks, approvals, abort handling, telemetry, transcript projection,
and suspend/resume behavior as `tools.call(...)`.

### Registration shape

Register namespaces from the integration that owns the backing tools. Keep the
scope small and only expose domain verbs that map to declared catalog tools.

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
arguments and returns the input object for the backing catalog tool. Without an
input mapper, the first guest argument is used, or `{}` when omitted.

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
- the namespace is hidden when any required tool is absent or owned by another
  plugin
- each callable path may target only a tool named in `requiredToolNames`

This prevents another plugin from exposing a namespace by registering a
same-named tool. It also keeps namespaces aligned with ordinary agent policy:
if the run cannot see the backing tools, it cannot see the namespace.

For example, a GitHub namespace should live behind a GitHub-owned extension that
owns GitHub auth, REST or GraphQL clients, rate limits, write approvals, and
tests. Core code mode should not embed GitHub-specific APIs, token handling, or
provider policy.

### Scope serialization rules

`createScope(ctx)` may return a plain object containing JSON-compatible values,
arrays, nested objects, and `createCodeModeNamespaceTool(...)` call markers.
Host objects never enter QuickJS directly.

The serializer rejects:

- raw functions
- circular object graphs
- unsafe path segments: `__proto__`, `constructor`, `prototype`, empty keys, or
  keys containing the internal path separator
- `globalName` values that are not JavaScript identifiers
- `globalName` collisions with built-in code-mode globals such as `tools`,
  `namespaces`, `text`, `json`, `yield_control`, or `__openclaw*`

Values that cannot be JSON-serialized are converted to JSON-safe fallback
values before crossing the bridge. Binary data, handles, sockets, clients, and
class instances should stay behind ordinary catalog tools.

### Prompts

The namespace `description` and optional `prompt` are appended to the model
visible `exec` schema only when the namespace is visible for that run. Use them
to teach the smallest useful surface:

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

Namespaces are process-local registrations. Remove them when the owning plugin
is disabled, uninstalled, or rolled back:

```typescript
clearCodeModeNamespacesForPlugin(pluginId);
```

Use `unregisterCodeModeNamespace(namespaceId)` only when removing one known
namespace. Tests can call `clearCodeModeNamespacesForTest()` to avoid leaking
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

Namespaces complement the generic `tools.search` / `tools.call` catalog. Use the
catalog for arbitrary enabled OpenClaw, plugin, and client tools; use `MCP` for
MCP tools; use other namespaces for plugin-owned, documented domain APIs where
concise code is more reliable than repeated schema lookups.

## Output API

`text(value)` appends human-readable output to the `output` array.

`json(value)` appends a structured output item after JSON-compatible
serialization.

The guest code's final returned value becomes `value` in a `completed` result.

Output item:

```typescript
type CodeModeOutput = { type: "text"; text: string } | { type: "json"; value: unknown };
```

Output rules:

- output order matches guest calls
- output is capped by `maxOutputBytes`
- non-serializable values are converted to plain strings or errors
- binary values are not supported in v1
- images and files travel through ordinary OpenClaw tools, not through the
  code-mode bridge

## Tool catalog

The hidden catalog includes tools after effective policy filtering:

1. OpenClaw core tools.
2. Bundled plugin tools.
3. External plugin tools.
4. MCP tools.
5. Client-provided tools for the current run.

Catalog ids are stable within one run and deterministic across equivalent tool
sets when possible.

Recommended id shape:

```text
<source>:<owner>:<tool-name>
```

Examples:

```text
openclaw:core:message
plugin:browser:browser_request
mcp:github:create_issue
client:app:select_file
```

The catalog omits code-mode control tools:

- `exec`
- `wait`
- `tool_search_code`
- `tool_search`
- `tool_describe`
- `tool_call`

This prevents recursion and keeps the model-facing contract narrow.

MCP entries stay in the run-scoped catalog so policy, approvals, hooks,
telemetry, transcript projection, and exact tool ids remain shared with normal
tool execution. The guest-facing `ALL_TOOLS`, `tools.search(...)`,
`tools.describe(...)`, and `tools.call(...)` views omit MCP entries. The
generated `MCP.<server>.<tool>({ ...input })` namespace resolves back to the
exact catalog id and then dispatches through the same executor path.

## Tool Search interaction

Code mode supersedes the OpenClaw Tool Search model surface for runs where it is
active.

When `tools.codeMode.enabled` is true and code mode activates:

- OpenClaw does not expose `tool_search_code`, `tool_search`, `tool_describe`,
  or `tool_call` as model-visible tools.
- The same cataloging idea moves inside the guest runtime.
- The guest runtime receives compact `ALL_TOOLS` metadata and search, describe,
  and call helpers for non-MCP tools.
- MCP calls use the generated `MCP` namespace and its `$api()` headers instead
  of `tools.call(...)`.
- Nested calls dispatch through the same OpenClaw executor path that Tool Search
  uses.

The existing [Tool Search](/tools/tool-search) page describes the OpenClaw compact
catalog bridge. Code mode is the generic OpenClaw alternative for runs that can
use `exec` and `wait`.

## Tool names and collisions

The model-visible `exec` tool is the code-mode tool. If the normal OpenClaw
shell `exec` tool is enabled, it is hidden from the model and cataloged like any
other tool.

Inside the guest runtime:

- `tools.call("openclaw:core:exec", input)` can call the shell exec tool if
  policy allows it.
- `tools.exec(...)` is installed only if the shell exec catalog entry has an
  unambiguous safe name.
- the code-mode `exec` tool is never recursively available through `tools`.

If two tools normalize to the same safe convenience name, OpenClaw omits the
convenience function and requires `tools.call(id, input)`.

## Nested tool execution

Every nested tool call crosses the host bridge and re-enters OpenClaw.

Nested execution preserves:

- active agent id
- session id and session key
- sender and channel context
- sandbox policy
- approval policy
- plugin `before_tool_call` hooks
- abort signal
- streaming updates where available
- trajectory and audit events

Nested calls project into the transcript as real tool calls so support bundles
can show what happened. The projection identifies the parent code-mode tool call
and the nested tool id.

Parallel nested calls are allowed up to `maxPendingToolCalls`.

## Runtime state

Each code-mode run has a state machine:

- `running`: VM is executing or nested calls are in flight.
- `waiting`: VM snapshot exists and can be resumed with `wait`.
- `completed`: final value returned; snapshot deleted.
- `failed`: error returned; snapshot deleted.
- `expired`: snapshot or pending state exceeded retention; cannot resume.
- `aborted`: parent run/session cancelled; snapshot deleted.

State is scoped by agent run, session, and tool call id. A `wait` call from a
different run or session fails.

Snapshot storage is bounded:

- maximum snapshot bytes per run
- maximum live snapshots per process
- snapshot TTL
- cleanup on run end
- cleanup on Gateway shutdown where persistence is not supported

## QuickJS-WASI runtime

OpenClaw loads `quickjs-wasi` as a direct dependency in the owning package. The
runtime does not rely on a transitive copy installed for proxy, PAC, or other
unrelated dependencies.

Runtime responsibilities:

- compile or load the QuickJS-WASI WebAssembly module
- create one isolated VM per code-mode run or resume
- register host callbacks by stable names
- set memory and interrupt limits
- evaluate JavaScript
- drain pending jobs
- snapshot suspended VM state
- restore snapshots for `wait`
- dispose VM handles and snapshots after terminal states

The runtime executes outside OpenClaw's main event loop in a worker. A guest
infinite loop must not block the Gateway process indefinitely.

## TypeScript

TypeScript support is a source transform only:

- accepted input: one TypeScript code string
- output: JavaScript string evaluated by QuickJS-WASI
- no typechecking
- no module resolution
- no `import` or `require` in v1
- diagnostics are returned as `failed` results

The TypeScript compiler is loaded lazily only for TypeScript cells. Plain
JavaScript cells and disabled code mode do not load the compiler.

The transform should preserve useful line numbers where feasible.

## Security boundary

Model code is hostile. The runtime uses defense in depth:

- run QuickJS-WASI outside the main event loop
- load `quickjs-wasi` as a direct dependency, not through Codex or a transitive
  package
- no filesystem, network, subprocess, module import, environment variables, or
  host global objects in the guest
- use QuickJS memory and interrupt limits
- enforce parent-process wall-clock timeout
- enforce output, snapshot, log, and pending-call caps
- serialize host bridge values through a narrow JSON adapter
- convert host errors into plain guest errors, never host realm objects
- drop snapshots on timeout, abort, session end, or expiry
- reject recursive access to `exec`, `wait`, and Tool Search control tools
- prevent convenience-name collisions from shadowing catalog helpers

The sandbox is one security layer. Operators can still need OS-level hardening
for high-risk deployments.

## Error codes

```typescript
type CodeModeErrorCode =
  | "runtime_unavailable"
  | "invalid_config"
  | "invalid_input"
  | "unsupported_language"
  | "typescript_transform_failed"
  | "module_access_denied"
  | "timeout"
  | "memory_limit_exceeded"
  | "output_limit_exceeded"
  | "snapshot_limit_exceeded"
  | "snapshot_expired"
  | "snapshot_restore_failed"
  | "too_many_pending_tool_calls"
  | "nested_tool_failed"
  | "aborted"
  | "internal_error";
```

Errors returned to the guest are plain data. Host `Error` instances, stack
objects, prototypes, and host functions do not cross into QuickJS.

## Telemetry

Code mode reports:

- visible tool names sent to the model
- hidden catalog size and source breakdown
- `exec` and `wait` counts
- nested search, describe, and call counts
- nested tool ids called
- timeout, memory, snapshot, and output cap failures
- snapshot lifecycle events

Telemetry must not include secrets, raw environment values, or unredacted tool
inputs beyond existing OpenClaw trajectory policy.

## Debugging

Use targeted model transport logging when code mode behaves differently from a
normal tool run:

```bash
OPENCLAW_DEBUG_CODE_MODE=1 \
OPENCLAW_DEBUG_MODEL_TRANSPORT=1 \
OPENCLAW_DEBUG_MODEL_PAYLOAD=tools \
OPENCLAW_DEBUG_SSE=events \
openclaw gateway
```

For payload-shape debugging, use `OPENCLAW_DEBUG_MODEL_PAYLOAD=full-redacted`.
This logs a capped, redacted JSON snapshot of the model request; it should only
be used while debugging because prompts and message text can still appear.

For stream debugging, use `OPENCLAW_DEBUG_SSE=peek` to log the first five
redacted SSE events. Code mode also fails closed if the final provider payload
does not contain exactly `exec` and `wait` after the code-mode surface has
activated.

## Implementation layout

Implementation units:

- config contract: `tools.codeMode`
- catalog builder: effective tools to compact entries and id map
- model-surface adapter: replace visible tools with `exec` and `wait`
- QuickJS-WASI runtime adapter: load, eval, snapshot, restore, dispose
- worker supervisor: timeout, abort, crash isolation
- bridge adapter: JSON-safe host callbacks and result delivery
- TypeScript transform adapter
- snapshot store: TTL, size caps, run/session scoping
- trajectory projection for nested tool calls
- telemetry counters and diagnostics

The implementation reuses catalog and executor concepts from Tool Search, but
does not use the `node:vm` child as the sandbox.

## Validation checklist

Code mode coverage should prove:

- disabled config leaves existing tool exposure unchanged
- object config without `enabled: true` leaves code mode disabled
- enabled config exposes only `exec` and `wait` to the model when tools are
  active for the run
- raw no-tool runs, `disableTools`, and empty allowlists do not trigger code-mode
  payload enforcement
- all effective non-MCP tools appear in `ALL_TOOLS`
- denied tools do not appear in `ALL_TOOLS`
- `tools.search`, `tools.describe`, and `tools.call` work for OpenClaw tools
- `API.list("mcp")` and `API.read("mcp/<server>.d.ts")` expose TypeScript-style
  MCP declarations without a bridge/tool call
- MCP namespace `$api()` remains available as an inline fallback for schemas
- MCP namespace calls work for visible MCP tools with one object input, while
  direct MCP catalog entries are absent from `tools.*`
- Tool Search control tools are hidden from both the model surface and the hidden
  catalog
- nested calls preserve approval and hook behavior
- shell `exec` is hidden from the model but callable by catalog id when allowed
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
6. Assert the model-visible tool list is exactly `exec`, `wait`.
7. In `exec`, read `ALL_TOOLS` and assert the effective test tools are present.
8. In `exec`, call OpenClaw/plugin/client tools through `tools.search`,
   `tools.describe`, and `tools.call`.
9. In `exec`, call `API.list("mcp")` and `API.read("mcp/<server>.d.ts")` and
   assert the declaration files describe visible MCP tools.
10. In `exec`, call MCP tools through `MCP.<server>.<tool>({ ...input })` and
    assert direct MCP catalog entries are absent from `ALL_TOOLS` and `tools.*`.
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
