---
summary: "Experimental SDK surface for plugins that replace the low level embedded agent executor"
title: "Agent harness plugins"
sidebarTitle: "Agent Harness"
read_when:
  - You are changing the embedded agent runtime or harness registry
  - You are registering an agent harness from a bundled or trusted plugin
  - You need to understand how the Codex plugin relates to model providers
---

An **agent harness** is the low level executor for one prepared OpenClaw agent
turn. It is not a model provider, not a channel, and not a tool registry. For
the user-facing mental model, see [Agent runtimes](/concepts/agent-runtimes).

Use this surface only for bundled or trusted native plugins. The contract is
still experimental because the parameter types intentionally mirror the
current embedded runner.

## When to use a harness

Register an agent harness when a model family has its own native session
runtime and the normal OpenClaw provider transport is the wrong abstraction:

- a native coding-agent server that owns threads and compaction
- a local CLI or daemon that must stream native plan/reasoning/tool events
- a model runtime that needs its own resume id in addition to the OpenClaw
  session transcript

Do **not** register a harness just to add a new LLM API. For normal HTTP or
WebSocket model APIs, build a [provider plugin](/plugins/sdk-provider-plugins).

## What core still owns

Before a harness is selected, OpenClaw has already resolved:

- provider and model
- runtime auth state, unless the harness declares that it owns auth bootstrap
- thinking level and context budget
- the OpenClaw transcript/session file
- workspace, sandbox, and tool policy
- channel reply callbacks and streaming callbacks
- model fallback and live model switching policy

A harness runs a prepared attempt; it does not pick providers, replace channel
delivery, or silently switch models.

### Harness-owned auth bootstrap

By default, core resolves provider credentials before calling a harness. A
trusted harness that can authenticate through its own native runtime may set
`authBootstrap: "harness"` on its static `AgentHarness` registration. Core then
skips its generic provider credential bootstrap and missing-credential failure
for every attempt claimed by that harness.

Core still forwards a compatible, explicitly selected or ordered OpenClaw auth
profile and its scoped store when one exists. The harness must resolve that
profile or its native credentials before issuing model requests, keep secrets
scoped to the attempt, and surface actionable authentication failures. Do not
set this capability on a harness that only sometimes owns authentication.

### Verified setup runtime artifacts

A local harness that can supply inference for first-run setup must attest the
implementation that completed the probe. When
`params.captureRuntimeArtifact` is true, return an opaque
`result.runtimeArtifact` with a stable id and content fingerprint. Register a
matching `runtimeArtifact.validate(...)` capability that rechecks that binding
without loading a different harness or scanning unrelated plugins.

Verified OpenClaw continuations also pass `params.expectedRuntimeArtifact`.
The harness must compare it with the exact native process it acquired and fail
before starting or resuming a native thread if they differ. Ordinary agent
turns omit both fields, so content hashing stays out of the normal request hot
path. Remote/WebSocket harnesses need a server attestation contract before
they can participate; a version string alone is not an artifact identity.

The prepared attempt also includes `params.runtimePlan`, an OpenClaw-owned
policy bundle for runtime decisions that must stay shared across OpenClaw and
native harnesses:

- `runtimePlan.tools.normalize(...)` and `runtimePlan.tools.logDiagnostics(...)`
  for provider-aware tool schema policy
- `runtimePlan.transcript.resolvePolicy(...)` for transcript sanitization and
  tool-call repair policy
- `runtimePlan.delivery.isSilentPayload(...)` for shared `NO_REPLY` and media
  delivery suppression
- `runtimePlan.outcome.classifyRunResult(...)` for model fallback
  classification
- `runtimePlan.observability` for resolved provider/model/harness metadata

Harnesses may use the plan for decisions that need to match OpenClaw behavior,
but treat it as host-owned attempt state: do not mutate it or use it to switch
providers/models inside a turn.

### Request-transport contract

`supports(ctx)` receives the resolved model transport in `ctx.modelProvider`.
Two secret-free provider-owned facts describe the selected route:

- `runtimePolicy.compatibleIds` lists the runtime ids the provider declares
  compatible with that concrete route. An absent policy means the provider did
  not declare route-level compatibility; it is not permission to assume support.
- `requestTransportOverrides: "none"` means no authored provider/model request
  override must be reproduced. `"present"` means authored headers, auth
  transport, proxy, TLS, local-service, private-network behavior, or request
  parameters exist. The fact does not expose those values.

Return `{ supported: false, reason }` when the harness cannot reproduce the
prepared transport. Do not infer support by reading raw config after selection.
When auth preparation yields multiple retry routes, one harness must support
all of them before dispatch. Implicit selection uses OpenClaw if no plugin can
own the full set; an explicit or persisted plugin selection fails closed.

## Register a harness

**Import:** `openclaw/plugin-sdk/agent-harness`

```typescript
import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const myHarness: AgentHarness = {
  id: "my-harness",
  label: "My native agent harness",

  supports(ctx) {
    const routeSupportsHarness =
      ctx.modelProvider?.runtimePolicy?.compatibleIds.includes("my-harness") === true;
    const canReproduceRequest = ctx.modelProvider?.requestTransportOverrides !== "present";
    return ctx.provider === "my-provider" && routeSupportsHarness && canReproduceRequest
      ? { supported: true, priority: 100 }
      : { supported: false, reason: "effective route is not harness-compatible" };
  },

  async runAttempt(params) {
    // Start or resume your native thread.
    // Use params.prompt, params.tools, params.images, params.onPartialReply,
    // params.onAgentEvent, and the other prepared attempt fields.
    return await runMyNativeTurn(params);
  },
};

export default definePluginEntry({
  id: "my-native-agent",
  name: "My Native Agent",
  description: "Runs selected models through a native agent daemon.",
  register(api) {
    api.registerAgentHarness(myHarness);
  },
});
```

`authBootstrap` is intentionally absent from this generic example. Add
`authBootstrap: "harness"` only when the harness meets the contract above.

### Delegated execution

A harness owner may set `delegatedExecutionPluginIds` to the ids of trusted
plugins that need to execute an existing model-locked session, such as a voice
transport continuing a Codex-backed conversation. This is static owner consent,
not a core allowlist. Keep it narrow.

Delegates receive only work admission and embedded execution. OpenClaw requires
the exact stored session key, store path, and session id; `modelSelectionLocked:
true`; and matching `agentHarnessId` and `agentHarnessRuntimeOverride` values.
The run is then scoped through the harness owner. Session creation, patching,
reset, deletion, archive, and Gateway mutation remain owner-only.

## Selection policy

OpenClaw chooses a harness after provider/model resolution:

1. Model-scoped runtime policy wins.
2. Provider-scoped runtime policy comes next.
3. `auto` asks registered harnesses if they support the resolved effective
   route. Provider/model prefixes alone never select a harness.
4. If no registered harness matches, OpenClaw uses its embedded runtime.

Plugin harness failures surface as run failures. In `auto` mode, embedded
fallback only applies when no registered plugin harness supports the resolved
provider/model. Once a plugin harness has claimed a run, OpenClaw does not
replay that same turn through another runtime, because that can change
auth/runtime semantics or duplicate side effects.

Configured runtime policy remains authoritative about the desired runtime. A
persisted session `agentHarnessId` keeps ownership of its native transcript
while route/auth preparation is still pending. Neither makes an incompatible
route compatible: once prepared facts exist, the selected or pinned harness
must support them or the run fails closed. `/status` shows the effective runtime
selected from policy, persisted ownership, and route support.
Prepared status is explicit: missing `runtimePolicy` stays undeclared instead
of being inferred from whichever transport fields happen to be present.
When harness-owned auth leaves multiple physical routes unresolved, the
prepared support fact is the intersection of their compatible runtime ids and
reports request overrides if any candidate has them. One undeclared candidate
therefore makes native compatibility empty; `preparedAuth.source: "harness"`
is an auth owner, not permission to infer route support.

If the selected harness is surprising, enable `agents/harness` debug logging
and inspect the gateway's structured `agent harness selected` record: it
includes the selected harness id, selection reason, runtime/fallback policy,
and, in `auto` mode, each plugin candidate's support result.

The bundled Codex plugin registers `codex` as its harness id. Core treats that
as an ordinary plugin harness id; Codex-specific aliases belong in the plugin
or operator config, not in the shared runtime selector.

## Provider plus harness pairing

Most harnesses should also register a provider. The provider makes model refs,
auth status, model metadata, and `/model` selection visible to the rest of
OpenClaw. The harness then claims that provider in `supports(...)`.

The bundled Codex plugin follows this pattern:

- preferred user model refs: `openai/gpt-5.6-sol`
- compatibility refs: legacy `codex/gpt-*` refs remain accepted, but new
  configs should not use them as normal provider/model refs
- harness id: `codex`
- auth: synthetic provider availability, because the Codex harness owns the
  native Codex login/session
- app-server request: OpenClaw sends the bare model id to Codex and lets the
  harness talk to the native app-server protocol

The Codex plugin is additive. With runtime policy unset or `auto`, OpenAI may
select Codex only when its provider-owned route contract declares `codex`
compatible: an exact official HTTPS Platform Responses or ChatGPT Responses
route with no authored request override. The `openai/*` prefix alone never
selects Codex. Custom endpoints, Completions adapters, and authored request
behavior stay on OpenClaw. Plaintext official HTTP endpoints are rejected. Older `codex/gpt-*`
refs remain compatibility inputs. See
[OpenAI implicit agent runtime](/providers/openai#implicit-agent-runtime).

For operator setup, model prefix examples, and Codex-only configs, see
[Codex Harness](/plugins/codex-harness).

The Codex plugin enforces the minimum app-server version documented in
[Codex Harness](/plugins/codex-harness). It checks the initialize handshake and
blocks older or unversioned servers, so OpenClaw only runs against the protocol
surface it has tested.

### Tool-result middleware

Bundled plugins and explicitly enabled installed plugins with matching
manifest contracts can attach runtime-neutral tool-result middleware through
`api.registerAgentToolResultMiddleware(...)` when their manifest declares the
targeted runtime ids in `contracts.agentToolResultMiddleware`. This trusted
seam is for async tool-result transforms that must run before OpenClaw or
Codex feeds tool output back into the model.

Legacy bundled plugins can still use
`api.registerCodexAppServerExtensionFactory(...)` for Codex app-server-only
middleware, but new result transforms should use the runtime-neutral API. The
embedded-runner-only `api.registerEmbeddedExtensionFactory(...)` hook has been
removed; embedded tool-result transforms must use runtime-neutral middleware.

### Terminal outcome classification

Native harnesses that own their own protocol projection can use
`classifyAgentHarnessTerminalOutcome(...)` from
`openclaw/plugin-sdk/agent-harness-runtime` when a completed turn produced no
visible assistant text. The helper returns `empty`, `reasoning-only`, or
`planning-only` so OpenClaw's fallback policy can decide whether to retry on a
different model. `planning-only` requires the harness's explicit `planText`
field; OpenClaw does not infer it from assistant prose. The helper
intentionally leaves prompt errors, in-flight turns, and intentional silent
replies such as `NO_REPLY` unclassified.

### Agent-end side effects

Native harnesses must call `runAgentEndSideEffects(...)` from
`openclaw/plugin-sdk/agent-harness-runtime` after they finalize an attempt. It
dispatches the portable `agent_end` hook and OpenClaw's research capture
without delaying interactive replies. Use `awaitAgentEndSideEffects(...)` for
local, non-interactive runs where the attempt must not resolve until those
side effects finish. Both helpers accept the same `{ event, ctx }` payload as
`runAgentHarnessAgentEndHook(...)`; their failures do not alter the completed
attempt result.

### User input and tool surfaces

Native harnesses that expose a runtime-level user-input request should use the
user-input helpers from `openclaw/plugin-sdk/agent-harness-runtime` to format
the prompt, deliver it through OpenClaw's blocking reply path, and normalize
choice/free-form answers back into the runtime's native response shape. The
helper keeps channel/TUI presentation consistent while each harness keeps its
own protocol parsing and pending-request lifecycle.

Native harnesses that need PI-like compact tool routing should use
`createAgentHarnessToolSurfaceRuntime(...)` from
`openclaw/plugin-sdk/agent-harness-tool-runtime`. It owns
tool-search/code-mode control selection, local-model lean defaults,
runtime-compatible schema filtering, hidden catalog execution, directory
hydration, and catalog cleanup. Harnesses still own their SDK-specific tool
conversion and native execution callback.

### Native Codex harness mode

The bundled `codex` harness is the native Codex mode for embedded OpenClaw
agent turns. Enable the bundled `codex` plugin first, and include `codex` in
`plugins.allow` if your config uses a restrictive allowlist. Native app-server
configs should use `openai/gpt-*`; OpenAI agent turns select the Codex harness
only when the effective route declares Codex compatibility. Legacy Codex model
refs should be repaired with `openclaw doctor --fix`, and legacy `codex/*`
model refs remain compatibility aliases for the native harness.

When this mode runs, Codex owns the native thread id, resume behavior,
compaction, and app-server execution. OpenClaw still owns the chat channel,
visible transcript mirror, tool policy, approvals, media delivery, and session
selection. Use provider/model `agentRuntime.id: "codex"` when you need to
prove that only the Codex app-server path can claim the run. Explicit plugin
runtimes fail closed; Codex app-server selection failures and runtime failures
are not retried through another runtime.

## Runtime strictness

By default, OpenClaw uses `auto` provider/model runtime policy: registered
plugin harnesses can claim compatible effective routes, and the embedded
runtime handles the turn when none match. A provider/model prefix alone never
selects a harness. Use an explicit provider/model plugin runtime such as
`agentRuntime.id: "codex"` when missing harness selection should fail instead
of routing through the embedded runtime. Explicit selection does not make an
incompatible route compatible. Selected plugin harness failures always fail
hard. This does not block an explicit provider/model
`agentRuntime.id: "openclaw"`.

For Codex-only embedded runs:

```json
{
  "models": {
    "providers": {
      "openai": {
        "agentRuntime": {
          "id": "codex"
        }
      }
    }
  },
  "agents": {
    "defaults": {
      "model": "openai/gpt-5.6-sol"
    }
  }
}
```

If you want a CLI backend for one canonical model, put the runtime on that
model entry:

```json
{
  "agents": {
    "defaults": {
      "model": "anthropic/claude-opus-4-8",
      "models": {
        "anthropic/claude-opus-4-8": {
          "agentRuntime": {
            "id": "claude-cli"
          }
        }
      }
    }
  }
}
```

Per-agent overrides use the same model-scoped shape:

```json
{
  "agents": {
    "list": [
      {
        "id": "codex-only",
        "model": "openai/gpt-5.6-sol",
        "models": {
          "openai/gpt-5.6-sol": {
            "agentRuntime": { "id": "codex" }
          }
        }
      }
    ]
  }
}
```

Legacy whole-agent runtime examples like this are ignored:

```json
{
  "agents": {
    "defaults": {
      "agentRuntime": {
        "id": "codex"
      }
    }
  }
}
```

With an explicit plugin runtime, a session fails early when the requested
harness is not registered, does not support the resolved provider/model, or
fails before producing turn side effects. That is intentional for Codex-only
deployments and for live tests that must prove the Codex app-server path is
actually in use.

This setting only controls the embedded agent harness. It does not disable
image, video, music, TTS, PDF, or other provider-specific model routing.

## Native sessions and transcript mirror

A harness may keep a native session id, thread id, or daemon-side resume
token. Keep that binding explicitly associated with the OpenClaw session, and
keep mirroring user-visible assistant/tool output into the OpenClaw
transcript.

The OpenClaw transcript remains the compatibility layer for:

- channel-visible session history
- transcript search and indexing
- switching back to the built-in OpenClaw harness on a later turn
- generic `/new`, `/reset`, and session deletion behavior

If your harness stores a sidecar binding, implement `reset(...)` so OpenClaw
can clear it when the owning OpenClaw session is reset.

## Tool and media results

Core constructs the OpenClaw tool list and passes it into the prepared
attempt. When a harness executes a dynamic tool call, return the tool result
back through the harness result shape instead of sending channel media
yourself.

This keeps text, image, video, music, TTS, approval, and messaging-tool
outputs on the same delivery path as OpenClaw-backed runs.

Set `AgentHarnessAttemptResult.hostOwnedToolMediaUrls` only for native artifacts
that the trusted harness runtime created and persisted itself. Every entry must
also appear in `toolMediaUrls`. Never include model-selected dynamic-tool or
OpenClaw-tool media. On `message_tool_only` routes, this narrow provenance lets
native runtime artifacts survive source-reply suppression; normal send policy
and ambient-room admission still apply.

### Terminal tool outcomes

`AgentHarnessAttemptParams.observeToolTerminal` is the host-owned terminal
outcome accumulator. A harness that executes OpenClaw dynamic tools or native
tools must call it when each tool reaches one terminal outcome, before the
attempt result is finalized. Harnesses that do not execute tools do not need to
call it.

Report facts from the execution boundary:

- Pass the protocol call id when one exists, the canonical tool name, and the
  arguments that actually reached the tool after preparation or hook rewrites.
- Set `executionStarted: false` when validation, approval, or another guard
  stopped the call before the tool implementation began. Once dispatch may
  have happened, report `true` conservatively.
- Report `outcome: "success"` or `outcome: "failure"`. Include the structured
  failure fields available from the runtime instead of inferring failure from
  display text.
- Use `nativeMutation` only for native tools that do not use an OpenClaw tool
  definition. Supply protocol-owned mutation and replay facts there; do not
  copy OpenClaw's mutation classifier into the harness.

The callback returns the canonical resolution for that call. Carry its
`lastToolError` into `AgentHarnessAttemptResult` and use its execution,
arguments, and side-effect facts in the harness projection instead of deriving
parallel state. The host keeps an unresolved mutating failure across unrelated
successful tools and clears it only after the matching action succeeds.

The callback remains optional for source compatibility with older experimental
harnesses. Optional does not mean ignorable for a harness that executes tools:
without terminal reports, OpenClaw cannot preserve mutating-tool failure truth
across later tool calls, including quiet heartbeat completion.

## Current limitations

- The public import path is generic, but some attempt/result type aliases
  still carry legacy names for compatibility.
- Third-party harness installation is experimental. Prefer provider plugins
  until you need a native session runtime.
- Harness switching is supported across turns. Do not switch harnesses in the
  middle of a turn after native tools, approvals, assistant text, or message
  sends have started.

## Related

- [SDK Overview](/plugins/sdk-overview)
- [Runtime Helpers](/plugins/sdk-runtime)
- [Provider Plugins](/plugins/sdk-provider-plugins)
- [Codex Harness](/plugins/codex-harness)
- [Model Providers](/concepts/model-providers)
