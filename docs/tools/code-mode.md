---
summary: "Use OpenClaw Code Mode to discover, call, and combine large tool catalogs in compact JavaScript or TypeScript workflows"
title: "Code Mode"
sidebarTitle: "Code Mode"
read_when:
  - You want to enable OpenClaw code mode for an agent run
  - You need to explain why Code Mode is different from Codex Code Mode
  - You are reviewing the compact tool contract, QuickJS-WASI sandbox, TypeScript transform, or hidden tool-catalog bridge
  - You are reviewing the MCP namespace bridge or virtual API declarations
---

Code mode is an experimental, opt-in OpenClaw agent-runtime feature. When
enabled, the model no longer sees every enabled tool schema; instead, it sees
`exec`, `wait`, and any direct-only tool whose structured result cannot cross
the JSON-only guest bridge. The model writes a small JavaScript or TypeScript
program that searches, describes, and calls the hidden tool catalog.

<Note>
OpenClaw Code Mode is off by default. To try it, open **Settings → Agents &
Tools → Labs** and turn on **Code Mode**. The Labs switch writes the `"auto"`
tier, which engages only for models marked as preferred Code Mode performers.
This is the global default; agent and model overrides take precedence.
</Note>

This page documents OpenClaw code mode, not Codex Code Mode. The two features
share a name and the same control-tool names (`exec`, `wait`), but they are
separate implementations:

- Codex Code Mode runs inside the Codex coding harness. Its `exec` tool is a
  freeform-grammar tool: the model writes raw JavaScript source (optionally
  prefixed by a `// @exec: {...}` pragma line for execution options), executed
  in Codex's in-process V8 Code Mode runtime.
- OpenClaw code mode runs in the generic OpenClaw agent runtime and is
  enabled through global, agent, or model activation settings. Its `exec`
  tool takes a JSON `{ code, language }` payload, executed in a QuickJS-WASI
  worker.

Both are JavaScript execution surfaces, not shell-command surfaces. Treat them
as independent, differently-implemented features that happen to expose
identically-named `exec`/`wait` tools.

In OpenClaw code mode, `command` is a JavaScript or TypeScript alias for
`code`, not a shell command. For shell or file operations, call the appropriate
async tool global from guest JavaScript. Recognizable shell
commands are rejected before the QuickJS worker starts with actionable
`invalid_input` guidance.

## What it does

- The model-visible tool list becomes `exec`, `wait`, plus any direct-only tool
  such as `computer` or the native-vision `view_image` loader whose image result
  cannot survive the guest bridge.
- `exec` evaluates model-generated JavaScript or TypeScript in an isolated
  QuickJS-WASI worker thread.
- Every catalog-eligible enabled non-MCP tool (OpenClaw core, plugin, client) is
  hidden as a standalone model tool and exposed inside the guest program as an
  async global function. MCP stays under the `MCP` namespace.
- The `exec` description carries a bounded quick index of final callable names,
  compact input hints, and compact declared output hints when a
  trusted tool provides an output schema. It omits descriptions, full schemas,
  MCP entries, and overflow entries; callable `catalog.search(...)` results are
  the fallback.
- Guest code calls globals directly or searches the hidden catalog for callable
  handles. A handle exposes bounded metadata and `describe()`, but never the
  exact internal catalog id. Calls use the same execution path as normal agent
  turns (policy, approvals, hooks, telemetry all still apply).
- MCP tools are grouped under the `MCP` namespace; in code mode this is the
  only supported way to call them.
- `wait` resumes a suspended code-mode run when nested tool calls are still
  pending.

Call `wait` only when the outer code-mode result has `status: "waiting"`, using
its top-level `runId`. A completed cell can return a background shell operation
with its own `sessionId` inside `value`; use the enabled process-control tool
inside a new `exec` to poll that operation. Its `sessionId` is not a code-mode
run ID.

Code mode changes the model-facing orchestration surface only. It does not
replace tools, plugin tools, MCP tools, auth, approval policy, channel
behavior, or model selection.

## Why use it

- Smaller prompt surface: providers get two control tools, a bounded native-tool
  index, and only the few required direct tools instead of dozens or hundreds
  of full tool schemas.
- Better orchestration: the model can use loops, joins, small transforms,
  conditional logic, and parallel nested tool calls inside one code cell.
- Fewer model round trips: a declared output contract lets the model call and
  transform a tool result in one `exec`; unknown outputs remain raw-first.
- Provider neutral: works for OpenClaw, plugin, MCP, and client tools without
  depending on provider-native code execution.
- Fails closed: if code mode is enabled but the QuickJS-WASI runtime is
  unavailable, the run fails instead of silently falling back to broad direct
  tool exposure.

Most useful for agents with a large enabled tool catalog, or workflows where
the model needs to search, combine, and call several tools before answering.

Keep direct tool exposure for a small catalog or a model that does not reliably
write short programs. Use [Tool Search](/tools/tool-search) when you want a
compact catalog but prefer structured search/describe/call controls instead of
the QuickJS-WASI guest.

## Quickstart

### Enable code mode

The recommended path is **Settings → Agents & Tools → Labs → Code Mode**. The
switch takes effect for future agent runs without restarting the Gateway and
selects the `"auto"` tier.

To enable the same tier without the Control UI, set it in config:

```json5
{
  tools: {
    codeMode: "auto",
  },
}
```

To default code mode on for every tool-capable run, regardless of model:

```json5
{
  tools: {
    codeMode: true,
  },
}
```

Object form works too: `tools.codeMode.enabled` accepts the same `false`,
`true`, and `"auto"` values. Code mode stays off when `tools.codeMode` is
omitted, `false`, or an object without an explicit `enabled` value, unless an
agent or model override enables it. Configuring limits or other Code Mode
options does not enable it.

See [Automatic per-model activation](#automatic-per-model-activation) for the
exact semantics and the shipped model list.

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

### Override one model

Set `codeMode: true` or `codeMode: false` on an exact `provider/model` entry in
`agents.defaults.models`. Omit `codeMode` to inherit the parent activation
setting, including its `"auto"` behavior. The model field accepts only a
boolean; `"auto"` belongs on the global or per-agent `tools.codeMode` setting.
Wildcard rows such as `"openai/*"` may configure runtime policy, but cannot set
`codeMode`; config validation rejects them instead of ignoring the override.

```json5
{
  tools: { codeMode: "auto" },
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.6-luna": {
          agentRuntime: { id: "openclaw" },
          codeMode: true,
        },
      },
    },
    entries: {
      research: {
        models: {
          "openai/gpt-5.6-luna": { codeMode: false },
        },
      },
    },
  },
}
```

The example enables Code Mode for this model except on the `research` agent.
Activation resolves from the first explicit setting in this order:

1. `agents.entries.<agent>.models["provider/model"].codeMode`.
2. `agents.entries.<agent>.tools.codeMode.enabled` (or its boolean/`"auto"` shorthand).
3. `agents.defaults.models["provider/model"].codeMode`.
4. `tools.codeMode.enabled` (or its shorthand), defaulting to `false`.

In the Control UI, open **Settings → Agents → Agent defaults**, show **Advanced**
settings, and find **Models** under **Agent Defaults**. Each model has a
**Code Mode** selector beside its runtime: **Default** removes the override,
**On** saves `true`, and **Off** saves `false`. For agent-specific overrides,
expand **Agent List**, then the agent's **Agent Model Overrides**. Unsupported fields remain
marked for **Raw** editing without hiding the supported settings beside them.

Overrides affect the selected model on future runs, including fallback models;
they do not enable tools on a tool-free run or change runtime selection. The
example separately selects `agentRuntime.id: "openclaw"` because OpenAI routes
may otherwise use Codex. These settings do not control Codex native Code Mode.
Model overrides change activation only; limits still come from the global and
per-agent `tools.codeMode` options.

### What the model does

For a tool with a declared output such as
`Array<{ id: string; paid: boolean; tons: number }>`, one guest program can
select, call, and transform it:

```javascript
const [shipmentTool] = await catalog.search("list shipments");
const shipments = await shipmentTool({});
return shipments.filter((shipment) => !shipment.paid && shipment.tons > 10);
```

Declared output fields may feed later calls in that same `exec`; do not spend a
second `exec` merely inspecting them.

When a quick-index line ends in `-> ?`, the output shape is unknown. The first
`exec` must return the final async tool call unchanged. Do not feed the unknown
value into guessed field-dependent logic in the same program. Observe the raw
value, then use a later `exec` for dependent composition. This costs an extra
model turn, but prevents the model from guessing field names.

### Recover from tool errors

Nested tool failures are ordinary JavaScript errors. Guest code can catch them
and return the information needed to choose the next action:

```javascript
try {
  return await terminal({ action: "list" });
} catch (error) {
  return { status: "unavailable", error: error.message };
}
```

Await every tool call or handle its rejection explicitly. OpenClaw drains
dispatched calls before completing a cell; an unhandled rejection, including
one from an unawaited call or timer callback, fails the cell instead of silently
reporting success. Handlers attached after a suspension still handle their
original promises.

JavaScript syntax errors, TypeScript transform errors, and tool failures proven
to occur before execution become failed `exec` results that the model can read
and correct across successive turns. A failed `exec` or `wait` does not automatically
end the agent run when OpenClaw's host execution record proves that no potentially
mutating nested action started, including before a suspended run resumed.

An exec host-policy rejection can carry this proof even after hooks, approval
resolution, and tool implementation entry: the host owns the narrower fact that
no command process or remote dispatch started. A corrected call runs the ordinary
hooks and approvals again. Consumed voice confirmations stay consumed; recovery
does not restore a grant or authorize replay.

Catalog search, handle `describe()`, `skills.list()`, and `skills.read()` are
read-only discovery. A guest error after only these operations still allows
ordinary recovery from a failed `exec`; discovery does not count as a mutation.

OpenClaw does not automatically replay a failed program. If earlier calls
may have changed state or a failed call may have partially applied, OpenClaw
deliberately permits one temporary read-only recovery attempt to inspect the
current state. The internal instruction identifies OpenClaw as its source. It does
not expose writes, sends, shell commands, or other mutations during that
reconciliation. Cancellation, explicitly terminal tool outcomes, sandbox
restrictions, approval requirements, and tool-policy denials retain their
existing behavior.

### Verify the active surface

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

## Use Swarm for agent fan-out

[Swarm](/tools/swarm) adds `agents.run()`, `phase()`, and `log()` guest globals
for orchestrating concurrent sub-agents from Code Mode scripts. Enable
`tools.swarm`, and ensure Code Mode engages through `"auto"` or `true`, then use
normal JavaScript control flow for fan-out, decision gates, and structured
collection. Swarm is a separate opt-in gate; engaging Code Mode alone does not
expose the `agents.*` API.

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

`tools.codeMode.enabled` sets the global activation default. It defaults to
`false`, including when the Code Mode object configures other fields. Set
`true` or `"auto"` explicitly, or use an [agent or model override](#override-one-model).

| Field                 | Default                        | Clamp                                           |
| --------------------- | ------------------------------ | ----------------------------------------------- |
| `enabled`             | `false`                        | `false`, `true`, or `"auto"` (per-model)        |
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
for that run; it does not silently expose normal tools as a fallback. This
holds for `true` and for `"auto"` runs where the model resolves as preferred:
an engaged run never silently falls back to broad direct tool exposure.

## Automatic per-model activation

`tools.codeMode.enabled` accepts three values:

- `false` (default): code mode is off unless an agent or model override enables it.
- `true`: code mode engages for tool-capable runs unless an override disables it.
- `"auto"`: code mode engages only when the run's model is flagged as a
  preferred code-mode performer in its provider catalog.

These values supply the default when no agent or model override takes
precedence. `"auto"` uses catalog capability; an explicit per-model boolean
bypasses that capability preference.

### The `compat.codeMode` catalog flag

Provider catalogs can tier a model with `compat.codeMode` on its model entry,
next to flags like `compat.supportsTools`:

- `"preferred"`: the model reliably writes short orchestration programs and
  benefits from the compact code-mode surface; `"auto"` engages code mode.
- `"capable"` (or absent): the model can run code mode when forced with
  `enabled: true`, but `"auto"` keeps normal tool exposure.

Models without tool support cannot use code mode at all; there is no separate
"unsupported" tier. The flag is capability metadata owned by the provider
plugin's catalog; core only reads the generic compat field.

### Shipped preferred models

Bundled provider catalogs currently flag these models as `"preferred"`:

| Provider  | Models                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| anthropic | `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-mythos-5`, `claude-opus-4-8`, `claude-haiku-4-5`                                                   |
| deepseek  | `deepseek-v4-pro`, `deepseek-v4-flash`                                                                                                                           |
| google    | `gemini-3-flash-preview`, `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.6-flash`, `gemini-3.7-flash` |
| kimi      | `k3`, `k3-256k`                                                                                                                                                  |
| minimax   | `MiniMax-M3`                                                                                                                                                     |
| moonshot  | `kimi-k3`                                                                                                                                                        |
| openai    | `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-pro`                                                                              |
| xiaomi    | `mimo-v2.5`                                                                                                                                                      |
| zai       | `glm-5.3`, `glm-5.2`, `glm-5.1`                                                                                                                                  |

Everything else, including all Ollama-served local models, stays unflagged and
keeps normal tool exposure under `"auto"`.

### Models shipped by more than one provider

Several vendors are reachable through more than one provider id: a subscription
endpoint next to an API endpoint, or a gateway that resells another vendor's
model. Because `"auto"` resolves the tier from whichever catalog served the run,
two catalogs describing the same upstream model must not disagree by accident.

Every catalog row for a shared model therefore states its tier explicitly once
any sibling row states one. Rows are matched on the vendor's own name for the
weights, so a catalog that republishes a model under a namespaced id or
different casing is matched automatically: `novita/moonshotai/kimi-k3`,
`nvidia/z-ai/glm-5.2`, and `together/deepseek-ai/DeepSeek-V4-Pro` all group with
the first-party rows without anyone declaring anything. Only genuinely different
names need the manifest's `upstreamModel` marker, as the `kimi` catalog uses for
`moonshot/kimi-k3`.

Reseller and aggregator catalogs such as `baseten`, `deepinfra`,
`github-copilot`, `gmi`, `novita`, `nvidia`, `ollama-cloud`, `opencode`,
`opencode-go`, `qianfan`, `together`, `venice`, and `volcengine-plan` currently
declare `"capable"` for the models first-party catalogs flag `"preferred"`: the
preferred tier came from evaluations on the first-party endpoints, and those
runs have not been repeated per reseller. Promoting one of those rows is a
deliberate, evidence-backed change rather than an oversight.

For OpenAI models, the flag matters only when the run resolves to the OpenClaw
embedded agent runtime. Default OpenAI routing uses the Codex-style harness
surface, where OpenClaw code mode does not apply; the catalog flag never
changes that routing decision.

### Choosing when to enable

In A/B evaluations on the preferred models above, code mode reduced total
token usage by roughly 30-50% at equal-or-better task pass rates, mostly by
replacing many full tool schemas and per-tool round trips with one compact
program surface. Models below the preferred tier showed no consistent win and
sometimes regressed, which is why `"auto"` leaves them on direct tools.

Use `"auto"` when agents switch between models: strong models get the compact
surface, weaker or local ones keep the exposure they handle best. Use `true`
on an exact model entry when you have verified an unflagged model performs well
with code mode. For open-weight or uncached serving where every prompt token is billed or
recomputed, prefer enabling per model (via `"auto"` or an explicit model override)
rather than globally, since the token savings depend on the model actually
using the program surface well.

## Activation

Code mode is evaluated after the effective tool policy is known and before the
final model request is assembled:

1. Resolve the agent, model, provider, sandbox, channel, sender, and run
   policy.
2. Build the effective OpenClaw tool list, adding eligible plugin, MCP, and
   client tools.
3. Apply allow/deny policy.
4. Resolve activation using the [agent and model precedence](#override-one-model).
   If it is `false`, or `"auto"` and the run's model is not catalog-preferred,
   continue with normal tool exposure.
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
  restartSafe?: boolean;
};
```

Rules:

- One of `code` or `command` must be non-empty.
- `code` is the documented model-facing field.
- `command` is accepted as an exec-compatible alias for hook policies and
  trusted rewrites (the normal OpenClaw shell exec tool also uses a `command`
  field). Blank caller aliases are treated as absent; a hook or trusted policy
  that invalidates one populated alias (blank or non-string) invalidates both so
  execution fails closed. When both aliases are non-empty, their values must match.
- `language` defaults to `"javascript"`; the schema exposes it as a flat
  string enum (`"javascript" | "typescript"`), not a `oneOf`/`anyOf` union,
  since some providers reject those shapes.
- If `language` is `"typescript"`, OpenClaw transpiles before evaluation.
- Do not set `restartSafe` on a new `exec`. Set it to `true` only when OpenClaw
  explicitly requests replay after a gateway restart, and never for `write`,
  `edit`, `exec`, or any mutation. Every catalog call must be explicitly
  replay-safe. OpenClaw rejects unmarked catalog tools and namespace
  surfaces that are not proven replay-safe, and restart-safe runs do not
  auto-drain pending calls. A generic exec surface is not replay-safe merely
  because one command appears read-only; use audited read, grep, or find tools.
  Suspended results are marked replay-safe so
  [restart recovery](/gateway/restart-recovery) can reconstruct an interrupted
  turn from its transcript instead of restoring the process-local snapshot.
  Recovery remains limited to audited read-only core tools and explicitly
  replay-safe plugin tools. Leave the field omitted for ordinary calls.
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

`exec` returns `waiting` when the guest suspends with resumable state that still
needs a model-visible continuation — an explicit `yield_control(...)`, or a
bridge tool call that has not resolved within the exec deadline. The result
includes a `runId` for `wait`. Native-channel exec approvals are different:
while the operator decision is pending, OpenClaw suspends both the Code Mode
execution budget and the owning agent-run budget. The original `exec` remains
in flight, then resumes with exactly its unused budget after approval resolves;
it does not return `pending_tools` or require model polling through `wait`.
Bridge requests — `catalog.search`, handle `describe()`, callable tool handles,
and namespace calls including MCP — are auto-drained inside the same
`exec`/`wait` call while they resolve within the deadline, so a compact code
block that awaits several tools runs to completion in one model turn instead of
forcing one model tool call per await.

`exec` returns `completed` only when the guest VM has no pending work and the
final value is JSON-compatible after OpenClaw's output adapter runs.

### Source in session history

In the built-in OpenClaw runtime, the JSON Code Mode tool executes the original
input. Session history preserves computations such as `const API_TOKEN = computeToken();`
and boolean or null initializers in the outer call's JavaScript or TypeScript
`code` and `command` fields, while masking credential literals, recognizable
tokens, registered secrets, and configured redaction patterns. Credential
assignments use full masks so repeated storage redaction stays stable.

This treatment does not extend to shell commands, nested tool calls, unrelated
argument strings, or assistant prose. Large or unrecognized source syntax
remains subject to diagnostic masking. Stored source is a redacted record, not
a place to recover credentials; no additional setting is required.
This applies to new calls; already-redacted source cannot be reconstructed.
The Copilot runtime's separate transcript journal does not yet preserve this
source structure. Native Codex uses a separate freeform source path; this
behavior does not describe its storage.

## `wait`

`wait` continues a suspended code-mode VM.

Input:

```typescript
type CodeModeWaitInput = {
  runId: string;
};
```

Output is the same `CodeModeResult` union returned by `exec`.

`wait` exists because nested OpenClaw tools can be slow, interactive, or stream
partial updates; the model should not need to keep one long `exec` call open
while the host waits for ordinary external work. Native-channel exec approvals
are the exception: they stay inside the original `exec` so approval authority
remains bound to the admitted run.

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
One cell owner spans initial execution, suspension, and every resume. Canceling
the owning run or current tool call, or closing its tool catalog at attempt
teardown, cancels active workers and pending host work and releases parked
snapshots, even if no `wait` call follows. Catalog description refreshes and
client tool additions do not close the owner. An external operation that ignores
cancellation may still finish, but cannot resume the closed guest, emit later
guest output, or start another guest tool call.

The process-wide limit of 64 slots applies to suspended cells and their reserved
resume slots. A resume keeps its slot until it completes or parks again; an
initial execution that completes without suspending does not consume a slot.

`wait` fails (as a `failed` result) when:

- `runId` is unknown or its snapshot already expired.
- the caller is not in the same run/session scope as the suspended run.
- a `wait` is already in flight for that `runId`.
- QuickJS-WASI restore fails.
- resuming would exceed `maxSnapshotBytes`. Ordinary oversized successful output is truncated and remains successful.

## Guest runtime API

```typescript
declare const catalog: ToolCatalog;
declare const MCP: Record<string, unknown>;
declare const namespaces: Record<string, unknown>;

declare function setTimeout(
  callback: (...args: unknown[]) => void,
  delay?: number,
  ...args: unknown[]
): number;
declare function clearTimeout(id: number): void;
declare function text(value: unknown): void;
declare function json(value: unknown): void;
declare function yield_control(reason?: string): Promise<void>;
```

Guest timers are bridged through the host, so they survive QuickJS snapshot/resume and remain bounded by the Code Mode execution and snapshot limits.
`clearTimeout` also cancels a timer created before an earlier suspension; this
applies to interactive Code Mode and headless automation scripts.

Every effective non-MCP tool is also installed as an async global function.
The model-visible `exec` description includes a bounded, deterministic subset
of final callable names, compact input hints, and trusted declared output hints.
Descriptions remain deferred so adversarial catalog prose cannot steer the
model. When that index omits a tool, call `catalog.search(...)`; its results are
callable functions.

The arrow in each quick-index line describes the callable function's value.
`-> Array<{ id: string }>` is a declared output hint; `-> ?` is output unknown.
Unknown outputs stay raw-first: return the value unchanged, observe it, then
filter or map it in a later `exec` instead of feeding guessed fields into
dependent logic in the same program. This also
applies when a declared-output read feeds a final `-> ?` call: return that
call's raw value without wrapping it in the requested answer shape.

```typescript
type ToolCatalogMetadata = {
  callableName: string;
  toolName: string;
  label?: string;
  description: string;
  source: "openclaw" | "client";
  input?: string;
  output?: string;
};

type ToolCatalogHandle = ((input?: unknown) => Promise<unknown>) &
  ToolCatalogMetadata & {
    describe(): Promise<ToolCatalogDescription>;
    toJSON(): ToolCatalogMetadata;
  };
```

Returning `await catalog.search(...)` or `catalog.all()` serializes each
callable handle to this bounded metadata. Serialization does not call
`describe()` or start another bridge request; inside the same program, the
handle remains callable.

`input` is a bounded TypeScript-style signature for the common case. Use
the handle's `describe()` when the exact full schema is still needed. Client
entries use `input: "unknown"` so their untrusted schemas stay deferred until
`describe()`. `output` is
present only for a complete compact hint derived from a trusted OpenClaw core
or plugin `outputSchema`. MCP and client output-schema claims are not promoted
into this trusted catalog hint.

Plugin tools use `source: "openclaw"`; there is no separate `"plugin"` source
value. MCP entries are excluded from generic catalog discovery and remain
available only through `MCP`.

Full schema is loaded only on demand:

```typescript
type ToolCatalogDescription = Omit<ToolCatalogMetadata, "toolName"> & {
  name: string;
  parameters: unknown;
  outputSchema?: unknown;
};
```

Catalog helpers:

```typescript
type ToolCatalog = {
  search(query: string, options?: { limit?: number }): Promise<ToolCatalogHandle[]>;
  all(): readonly ToolCatalogHandle[];
};
```

`catalog.search(...)` returns a frozen array of callable handles, or an empty
array when no tools match. If the matching callable names exceed the output
budget, search rejects with guidance to narrow the query or lower `limit`.
It never silently substitutes an empty or partial match list. A narrower search
remains available after the error.

Paired Gateway nodes are available through the `nodes` global:

```typescript
const available = await nodes.list();
const node = await nodes.get(available[0].id);
const status = await node.invoke("device.status");
```

`nodes.list()` returns paired node ids, names, platforms, connection state, and
advertised commands. `nodes.get(idOrName)` resolves an exact id before a display
name and returns a handle with `id`, `name`, and `invoke(command, params?)`.
Invocation uses the normal `nodes` tool path, so pairing, command policy, scopes,
approvals, timeouts, hooks, and telemetry are unchanged. A handle includes
`listDir(path)` only when the node advertises `fs.listDir`. It does not include
`exec`: the generic nodes surface reserves `system.run` for the normal shell
`exec` tool with a node host.

Call quick-index globals directly, or use callable catalog handles when lookup
is needed:

```typescript
const content = await read({ path: "README.md" });

const [tool] = await catalog.search("...");
const result = await tool({ query: "OpenClaw" });

const [search] = await catalog.search("search the web", { limit: 1 });
const schema = await search.describe();
const hits = await search({ query: "OpenClaw code mode" });
```

Calling a global or catalog handle returns the normal tool's JSON `details`
value directly. Exact catalog ids and raw `{ tool, result }` envelopes are not
guest-visible.

## Declared output contracts

OpenClaw tools can declare `outputSchema` for the structured value placed in
`AgentToolResult.details`. This is useful for Code Mode and Tool Search; it is
not a provider-native tool response schema and does not change direct tool
exposure.

For a tool made with `defineToolPlugin`, declare the schema beside
`parameters`:

```typescript
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

const Shipment = Type.Object(
  {
    id: Type.String(),
    paid: Type.Boolean(),
    tons: Type.Number(),
  },
  { additionalProperties: false },
);

export default defineToolPlugin({
  id: "shipping",
  name: "Shipping",
  description: "Shipment tools.",
  tools: (tool) => [
    tool({
      name: "shipping_list",
      description: "List shipments.",
      parameters: Type.Object({}),
      outputSchema: Type.Array(Shipment),
      execute: async () => loadShipments(),
    }),
  ],
});
```

For `api.registerTool(...)` or a factory tool, put the same `outputSchema`
property on the returned `AnyAgentTool` object.

Current built-in contracts include `agents_list`, `apply_patch`,
`conversations_list`, `conversations_send`, `conversations_turn`, `edit`,
`openclaw`, `read`, `screen`,
`sessions_history`, `sessions_list`, `sessions_search`, `sessions_send`,
`session_status`, `suggest_task`, `terminal`, `web_fetch`, and `web_search`.
Exact passthroughs can reuse their owning protocol schema instead of
duplicating a model-only contract. For example, the conversation tools expose
the same Gateway result schemas used by `conversations.list`,
`conversations.send`, and `conversations.turn`; `web_fetch` owns a tool-local
schema whose hint exposes stable metadata, text, cache state, and nested spill
metadata; `web_search` declares its exact normalized results/answer/error/raw
union as a complete quick-index hint. Filesystem contracts return structured
read text, image, truncation, and optional-not-found outcomes; explicit edit
change state plus diff/patch data; and apply-patch path summaries. Missing
canonical daily notes (`memory/YYYY-MM-DD.md`) return an optional `not_found`
result even when `optional` is omitted; other missing paths throw unless
`optional: true` is explicitly supplied. When the quick index declares the
fields, one cell can compose discovery and delivery without a separate
inspection turn:

```javascript
const listed = await conversations_list({ query: "build bot" });
const target = listed.conversations.find((item) => item.label === "Build bot");
if (!target) throw new Error("conversation not found");
return await conversations_send({
  conversationRef: target.conversationRef,
  message: "Build finished.",
});
```

The nested calls still use normal tool policy, hooks, and approvals. If a full
contract is exact but too large for the bounded quick index, it remains
available through the callable handle's `describe()` and the arrow stays
`-> ?`.

The contract rules are strict:

- Describe the exact JSON-compatible `details` value, not rendered `content`
  blocks or a provider envelope.
- Include every non-throwing success or error variant. Omit `outputSchema` when
  the tool has no stable structured result.
- Close object layers with `{ additionalProperties: false }` for a complete
  quick-index hint. Open, oversized, or otherwise partial schemas stay
  available through handle `describe()` but do not enable one-turn field use.
- OpenClaw compiles the schema before running the tool, then validates final
  `details` after normal tool hooks and before a catalog call returns. An
  invalid schema cannot run the tool; a mismatch fails without printing the
  value.
- Compact hints are deterministic and bounded. Handle `describe()` exposes
  the full trusted schema when the compact hint is insufficient.
- Installed plugin code is already trusted local code. Remote MCP and client
  metadata remains untrusted and cannot opt into these quick-index hints.

See [Tool plugins](/plugins/tool-plugins#output-contracts) for plugin authoring
details.

MCP catalog entries are not exposed as bare globals or through generic
`catalog` discovery; they are available only through the generated `MCP`
namespace. TypeScript-style declaration files
are available through the read-only `API` virtual file surface, so agents can
inspect MCP signatures without adding MCP schemas to the prompt:

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
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
};

type McpResourcesListResult = { resources: unknown[]; nextCursor?: string };
type McpResourcesReadResult = { contents: unknown[] };
type McpPromptsListResult = { prompts: unknown[]; nextCursor?: string };
type McpPromptsGetResult = { messages: unknown[]; description?: string };

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

MCP tool calls return their original JSON-safe content blocks, including block
annotations and block-level `_meta`, plus top-level `structuredContent` and
`isError` when provided. Top-level MCP `_meta` and private app metadata never
enter the guest. An MCP application failure with `isError: true` still resolves
as a result, so guest code can inspect and recover from it. Resource and prompt
operations instead return their native MCP shapes: `resources.list()` returns
`resources`, `resources.read()` returns `contents`, `prompts.list()` returns
`prompts`, and `prompts.get()` returns `messages` with an optional `description`.

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

## Output API

- `text(value)` appends human-readable output to the `output` array.
- `json(value)` appends a structured output item after JSON-compatible
  serialization.
- The guest code's final returned value becomes `value` in a `completed`
  result.

```typescript
type CodeModeOutput = { type: "text"; text: string } | { type: "json"; value: unknown };
```

Output order matches guest calls. Each nested tool result is bounded separately
by `maxOutputBytes`. Cumulative guest output and the final value or failure
diagnostic share one `maxOutputBytes` serialized UTF-8 budget across all waits. Oversized errors retain their leading cause and end
with `[error truncated]`; truncation does not turn a failure into success.
Catalog search rejects when its callable-name array cannot fit this budget;
narrow the query or lower `limit` and retry. For other successful results that
exceed the budget, OpenClaw returns a bounded value
with `truncated: true`, a UTF-8-safe `prefix`, `omittedBytes`, and guidance to
rerun with narrower arguments. Treat that marker as a successful partial result:
reduce the search scope, paginate, select fewer files, or return a smaller
projection. Non-serializable values are converted to plain strings or errors;
binary values are not supported. Images and files travel through ordinary
OpenClaw tools, not through the code-mode bridge.

Marker prefixes and omitted-byte counts describe the original compact JSON after
normalization, including array brackets, separators, and JSON escaping. Ordinary
output is delivered incrementally. An unchanged cumulative summary is not repeated;
new output or a changed final-value/error reservation can produce a replacement
summary of that same original output.

## Tool catalog

The hidden catalog includes tools after effective policy filtering, in this
order: OpenClaw core tools, bundled plugin tools, external plugin tools, MCP
tools, then client-provided tools for the current run.

Catalog ids remain opaque host-only routing identities. They are stable within
one run and deterministic across equivalent tool sets when possible, but they
are never included in the prompt, guest metadata, handle descriptions, or
errors. Policy, approvals, telemetry, replay safety, and namespace dispatch
continue to use them internally.

Before the worker starts, OpenClaw projects one effective winner per exact tool
name and computes its final guest callable name. This matches direct-mode
precedence: later client tools win an exact-name shadow, while plugin conflict
enforcement remains unchanged. The finalized projection is carried through
bridge calls and snapshot resume; consumers do not reconstruct it from the
catalog.

The catalog omits code-mode control tools (`exec`, `wait`, `tool_search_code`,
`tool_search`, `tool_describe`, `tool_call`) and direct-only tools. Controls
must not recurse through the catalog; direct-only tools remain model-visible
because their structured results cannot cross the QuickJS bridge.

MCP entries stay in the run-scoped catalog so policy, approvals, hooks,
telemetry, transcript projection, and exact tool ids remain shared with
normal tool execution. Generic guest `catalog.search(...)` and `catalog.all()`
omit MCP entries. The generated `MCP.<server>.<tool>({ ...input })` namespace
resolves to its host-only entry and dispatches through the same executor path.

## Tool Search interaction

Code mode supersedes the OpenClaw Tool Search model surface for runs where it
is active.

When Code Mode engages through forced `true` or `"auto"` activation:

- OpenClaw does not expose `tool_search_code`, `tool_search`, `tool_describe`,
  or `tool_call` as model-visible tools.
- The same cataloging idea moves inside the guest runtime.
- The guest runtime receives bare async globals plus callable search/describe
  handles for non-MCP tools.
- MCP calls use the generated `MCP` namespace and its `$api()` headers instead
  of generic catalog discovery.
- Nested calls dispatch through the same OpenClaw executor path that Tool
  Search uses.

See [Tool Search](/tools/tool-search) for the OpenClaw compact catalog bridge
that code mode supersedes for active runs.

## Tool names and collisions

The model-visible `exec` tool is the code-mode tool. If the normal OpenClaw
shell `exec` tool is enabled, it is hidden from the model and cataloged like
any other tool.

Inside the guest runtime:

- An exact JavaScript-safe tool name stays exact: `web_search(...)` and
  `sessions_spawn(...)`.
- Invalid identifier characters become `_`; a still-invalid first character
  gets the `tool_` prefix. For example, `llm-task` becomes `llm_task` when that
  name is free.
- JavaScript reserved words, specialized globals, and normalized collisions
  receive a deterministic short suffix derived from the host-only identity.
- Exact safe names win their unsuffixed spelling. A raw tool never overwrites
  `catalog`, `MCP`, `API`, `nodes`, `skills`, `namespaces`, output/timer helpers,
  or optional Swarm globals.
- The normal shell `exec` tool is callable as the `exec(...)` guest global when
  policy allows it. The code-mode control `exec` is not recursively available
  inside the guest.

## Nested tool execution

Every nested tool call crosses the host bridge and re-enters OpenClaw,
preserving: active agent id, session id and key, sender and channel context,
sandbox policy, approval policy, plugin `before_tool_call` hooks, abort
signal, streaming updates where available, and trajectory/audit events.

Completed nested calls persist as bounded, redacted display-only activity, retaining
their original parent and invocation ids across history reloads. Provider replay
contains only the actual model calls; child activity adds no synthetic model turns.
Starts and partial updates remain transient. Older missing child history cannot be
reconstructed from source code or outer results.

Nested tool failures cross into the guest as catchable JavaScript errors. If
guest code does not catch an error, `exec` or `wait` returns a failed tool
result. Proven no-start failures and errors after only audited read-only work
allow ordinary model recovery, including when `wait` resumes a suspended cell.
This proof covers the cell's entire execution, not just the latest resume.
Failed waits without that host proof remain terminal; serialized result fields
cannot grant recovery. Possible nested side effects in a failed `exec` require
authorized read-only reconciliation before any further action. Network-controlled
tool output and errors retain their existing untrusted-content wrapping and
sanitization; recovering from a failure does not grant new permissions or replay
completed side effects.

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
  survives a restart: this is transient runtime state).
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
- reserves specialized globals and resolves callable-name collisions before the
  worker starts

The sandbox is one security layer; operators may still need OS-level
hardening for high-risk deployments.

## Error codes

```typescript
type CodeModeErrorCode =
  | "invalid_input"
  | "runtime_unavailable"
  | "aborted"
  | "timeout"
  | "output_limit_exceeded"
  | "snapshot_limit_exceeded"
  | "internal_error";
```

`invalid_input` covers bad `exec`/`wait` arguments, disabled languages,
rejected module access, TypeScript transform failures, unknown/expired/
wrong-scope `runId` values, and too many suspended runs. `runtime_unavailable`
covers a QuickJS worker that fails to start or exits non-zero.
`aborted` means the caller cancelled an active `exec` or `wait`; OpenClaw
terminates the worker or drops the suspended run, so that `runId` cannot be
resumed. It is distinct from `timeout`, which means an execution deadline was
exceeded.
`output_limit_exceeded` is reserved for a result that cannot be serialized into
the bounded projection; ordinary oversized successful results are truncated and
remain successful.

Errors returned to the guest are plain data; host `Error` instances, stack
objects, prototypes, and host functions do not cross into QuickJS.

## Telemetry

Each result's `telemetry` field reports: hidden catalog size and a source
breakdown (`openclaw`/`mcp`/`client` counts), cumulative search/describe/call
counts for the run's catalog, and the code-mode control tool names (`exec` and
`wait`).
The `counterScope` identifies one counter lifetime, changing when a catalog is
replaced or restored but remaining stable when tools are appended or prompt
policy narrows that catalog.

Catalog teardown retains only these final aggregate diagnostics, not executable
tools or VM state. If teardown closes a suspended run while `wait` is observing
pending work, that wait returns `failed` with `code: "aborted"` and the final
telemetry; pending calls are canceled and the snapshot is dropped. Retained
diagnostics grant no authority to resume or repair the closed run.

The run metadata (`meta.agentMeta` in `openclaw agent --json`, mirrored on the
`agent exec --json` envelope) adds per-run stats:

- `codeModeEngaged`: `true` only when code mode actually owned the model tool
  surface. This is the reliable engagement signal — do not infer engagement
  from config or tool names: the shell tool is also named `exec`, and the
  `"auto"` tier engages per model capability. Harnesses that bridge OpenClaw's
  tool surface (Copilot) report their resolved gate, so
  `codeModeEngaged: false` with `tools.codeMode.enabled=true` makes a silent
  no-op observable. Harnesses that run their own native tool surface (Codex)
  never engage OpenClaw code mode, so they always read `false`; an attempt that
  reports nothing is normalized to `false` for the same reason. Codex's own
  `codeModeOnly` is a separate native feature that this field does not track.
- `assistantTurns`: completed assistant/provider round trips across the run.
- `bridgeCalls`: the run's cumulative inner bridge counts
  (`{ search, describe, call }`). These calls never reach the provider;
  provider-visible outer tool calls remain in `meta.toolSummary.calls`.
- `costUsd`: estimated USD cost from the run's accumulated usage and the
  model's cost config (cache read/write tiers included); omitted when the
  model has no cost data.

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

- disabled config without an enabling override leaves existing tool exposure unchanged
- omitted `enabled`, including object config that sets other fields, stays
  disabled unless an agent or model override enables it
- per-model `true`, `false`, and unset values preserve activation precedence,
  fallback-model selection, and limits from the enclosing options
- enabled config exposes `exec`, `wait`, and only required direct-only tools to
  the model when tools are active for the run
- raw no-tool runs, `disableTools`, and empty allowlists do not trigger
  code-mode payload enforcement
- every catalog-eligible effective non-MCP name has one callable winner
- direct-only tools stay model-visible and do not appear in `catalog`
- denied tools have no global or catalog handle
- bare globals, callable `catalog.search` results, `catalog.all`, and handle
  `describe()` work for OpenClaw and client tools without exposing exact ids
- `API.list("mcp")` and `API.read("mcp/<server>.d.ts")` expose TypeScript-style
  MCP declarations without a bridge/tool call
- MCP namespace `$api()` remains available as an inline fallback for schemas
- MCP namespace calls work for visible MCP tools with one object input, while
  direct MCP entries are absent from generic `catalog` discovery
- Tool Search control tools are hidden from both the model surface and the
  hidden catalog
- nested calls preserve approval and hook behavior
- caught and uncaught nested failures remain recoverable without replaying
  previously executed side effects
- network-controlled failures retain untrusted-content wrapping and sanitization
- shell `exec` is hidden from the model but callable as a guest global when
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
7. In `exec`, call safe bare globals and assert normalized, reserved, and
   colliding names match the quick index.
8. Search `catalog`, inspect handle metadata/`describe()`, and call
   OpenClaw/plugin/client handles without observing exact ids.
9. In `exec`, call `API.list("mcp")` and `API.read("mcp/<server>.d.ts")` and
   assert the declaration files describe visible MCP tools.
10. In `exec`, call MCP tools through `MCP.<server>.<tool>({ ...input })` and
    assert direct MCP entries are absent from `catalog.search()` and
    `catalog.all()`.
11. Assert denied tools are absent and cannot be called by guessed id.
12. Start a nested tool call that resolves after `exec` returns `waiting`.
13. Call `wait` and assert the restored VM receives the tool result.
14. Assert the final answer contains output produced after restore.
15. Assert timeout, abort, and snapshot expiry clean up runtime state.
16. Export trajectory and assert nested calls are visible under the parent
    code-mode call.

Docs-only changes to this page should still run `pnpm check:docs`.

## Related

- [Swarm](/tools/swarm) for fan-out agent orchestration from Code Mode scripts
- [Tool Search](/tools/tool-search)
- [Agent runtimes](/concepts/agent-runtimes)
- [Exec tool](/tools/exec)
- [Code execution](/tools/code-execution)
