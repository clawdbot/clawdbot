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
turn. It is not a model provider, not a channel, and not a tool registry.
For the user-facing mental model, see [Agent runtimes](/concepts/agent-runtimes).

Use this surface only for bundled or trusted native plugins. The contract is
still experimental because the parameter types intentionally mirror the current
embedded runner.

## When to use a harness

Register an agent harness when a model family has its own native session
runtime and the normal OpenClaw provider transport is the wrong abstraction.

Examples:

- a native coding-agent server that owns threads and compaction
- a local CLI or daemon that must stream native plan/reasoning/tool events
- a model runtime that needs its own resume id in addition to the OpenClaw
  session transcript

Do **not** register a harness just to add a new LLM API. For normal HTTP or
WebSocket model APIs, build a [provider plugin](/plugins/sdk-provider-plugins).

## What core still owns

Before a harness is selected, OpenClaw has already resolved:

- provider and model
- runtime auth state
- thinking level and context budget
- the OpenClaw transcript/session file
- workspace, sandbox, and tool policy
- channel reply callbacks and streaming callbacks
- model fallback and live model switching policy

That split is intentional. A harness runs a prepared attempt; it does not pick
providers, replace channel delivery, or silently switch models.

The prepared attempt also includes `params.runtimePlan`, an OpenClaw-owned
policy bundle for runtime decisions that must stay shared across PI and native
harnesses:

- `runtimePlan.tools.normalize(...)` and
  `runtimePlan.tools.logDiagnostics(...)` for provider-aware tool schema policy
- `runtimePlan.transcript.resolvePolicy(...)` for transcript sanitization and
  tool-call repair policy
- `runtimePlan.delivery.isSilentPayload(...)` for shared `NO_REPLY` and media
  delivery suppression
- `runtimePlan.outcome.classifyRunResult(...)` for model fallback classification
- `runtimePlan.observability` for resolved provider/model/harness metadata

Harnesses may use the plan for decisions that need to match PI behavior, but
should still treat it as host-owned attempt state. Do not mutate it or use it to
switch providers/models inside a turn.

## Register a harness

**Import:** `openclaw/plugin-sdk/agent-harness`

```typescript
import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const myHarness: AgentHarness = {
  id: "my-harness",
  label: "My native agent harness",

  supports(ctx) {
    return ctx.provider === "my-provider"
      ? { supported: true, priority: 100 }
      : { supported: false };
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

## Selection policy

OpenClaw chooses a harness after provider/model resolution:

1. Model-scoped runtime policy wins.
2. Provider-scoped runtime policy comes next.
3. `auto` asks registered harnesses if they support the resolved
   provider/model.
4. If no registered harness matches, OpenClaw uses PI unless PI fallback is
   disabled.

Plugin harness failures surface as run failures. In `auto` mode, PI fallback is
only used when no registered plugin harness supports the resolved
provider/model. Once a plugin harness has claimed a run, OpenClaw does not
replay that same turn through PI because that can change auth/runtime semantics
or duplicate side effects.

Whole-session and whole-agent runtime pins are ignored by selection. That
includes stale session `agentHarnessId` values, `agents.defaults.agentRuntime`,
`agents.list[].agentRuntime`, and `OPENCLAW_AGENT_RUNTIME`. `/status` shows the
effective runtime selected from the provider/model route.
If the selected harness is surprising, enable `agents/harness` debug logging and
inspect the gateway's structured `agent harness selected` record. It includes
the selected harness id, selection reason, runtime/fallback policy, and, in
`auto` mode, each plugin candidate's support result.

The bundled Codex plugin registers `codex` as its harness id. Core treats that
as an ordinary plugin harness id; Codex-specific aliases belong in the plugin
or operator config, not in the shared runtime selector.

## Provider plus harness pairing

Most harnesses should also register a provider. The provider makes model refs,
auth status, model metadata, and `/model` selection visible to the rest of
OpenClaw. The harness then claims that provider in `supports(...)`.

The bundled Codex plugin follows this pattern:

- preferred user model refs: `openai/gpt-5.5`
- compatibility refs: legacy `codex/gpt-*` refs remain accepted, but new
  configs should not use them as normal provider/model refs
- harness id: `codex`
- auth: synthetic provider availability, because the Codex harness owns the
  native Codex login/session
- app-server request: OpenClaw sends the bare model id to Codex and lets the
  harness talk to the native app-server protocol

The Codex plugin is additive. Plain `openai/gpt-*` agent refs on the official
OpenAI provider select the Codex harness by default. Older `codex/gpt-*` refs
still select the Codex provider and harness for compatibility.

For operator setup, model prefix examples, and Codex-only configs, see
[Codex Harness](/plugins/codex-harness).

OpenClaw requires Codex app-server `0.125.0` or newer. The Codex plugin checks
the app-server initialize handshake and blocks older or unversioned servers so
OpenClaw only runs against the protocol surface it has been tested with. The
`0.125.0` floor includes the native MCP hook payload support that landed in
Codex `0.124.0`, while pinning OpenClaw to the newer tested stable line.

### Tool-result middleware

Bundled plugins can attach runtime-neutral tool-result middleware through
`api.registerAgentToolResultMiddleware(...)` when their manifest declares the
targeted runtime ids in `contracts.agentToolResultMiddleware`. This trusted
seam is for async tool-result transforms that must run before PI or Codex feeds
tool output back into the model.

Legacy bundled plugins can still use
`api.registerCodexAppServerExtensionFactory(...)` for Codex app-server-only
middleware, but new result transforms should use the runtime-neutral API.
The Pi-only `api.registerEmbeddedExtensionFactory(...)` hook has been removed;
Pi tool-result transforms must use runtime-neutral middleware.

### Terminal outcome classification

Native harnesses that own their own protocol projection can use
`classifyAgentHarnessTerminalOutcome(...)` from
`openclaw/plugin-sdk/agent-harness-runtime` when a completed turn produced no
visible assistant text. The helper returns `empty`, `reasoning-only`, or
`planning-only` so OpenClaw's fallback policy can decide whether to retry on a
different model. It intentionally leaves prompt errors, in-flight turns, and
intentional silent replies such as `NO_REPLY` unclassified.

### Native Codex harness mode

The bundled `codex` harness is the native Codex mode for embedded OpenClaw
agent turns. Enable the bundled `codex` plugin first, and include `codex` in
`plugins.allow` if your config uses a restrictive allowlist. Native app-server
configs should use `openai/gpt-*`; OpenAI agent turns select the Codex harness
by default. Legacy `openai-codex/*` routes should be repaired with
`openclaw doctor --fix`, and legacy `codex/*` model refs remain compatibility
aliases for the native harness.

When this mode runs, Codex owns the native thread id, resume behavior,
compaction, and app-server execution. OpenClaw still owns the chat channel,
visible transcript mirror, tool policy, approvals, media delivery, and session
selection. Use provider/model `agentRuntime.id: "codex"` when you need to prove
that only the Codex app-server path can claim the run. Explicit plugin runtimes
fail closed; Codex app-server selection failures and runtime failures are not
retried through PI.

## Runtime strictness

By default, OpenClaw uses `auto` provider/model runtime policy: registered
plugin harnesses can claim a provider/model pair, and PI handles the turn when
none match. OpenAI agent refs on the official OpenAI provider default to Codex.
Use an explicit provider/model plugin runtime such as
`agentRuntime.id: "codex"` when missing harness selection should fail instead
of routing through PI. Selected plugin harness failures always fail hard. This
does not block an explicit provider/model `agentRuntime.id: "pi"`.

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
      "model": "openai/gpt-5.5"
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
      "model": "anthropic/claude-opus-4-7",
      "models": {
        "anthropic/claude-opus-4-7": {
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
        "model": "openai/gpt-5.5",
        "models": {
          "openai/gpt-5.5": {
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

A harness may keep a native session id, thread id, or daemon-side resume token.
Keep that binding explicitly associated with the OpenClaw session, and keep
mirroring user-visible assistant/tool output into the OpenClaw transcript.

The OpenClaw transcript remains the compatibility layer for:

- channel-visible session history
- transcript search and indexing
- switching back to the built-in PI harness on a later turn
- generic `/new`, `/reset`, and session deletion behavior

If your harness stores a sidecar binding, implement `reset(...)` so OpenClaw can
clear it when the owning OpenClaw session is reset.

## Tool and media results

Core constructs the OpenClaw tool list and passes it into the prepared attempt.
When a harness executes a dynamic tool call, return the tool result back through
the harness result shape instead of sending channel media yourself.

This keeps text, image, video, music, TTS, approval, and messaging-tool outputs
on the same delivery path as PI-backed runs.

## Current limitations

- The public import path is generic, but some attempt/result type aliases still
  carry `Pi` names for compatibility.
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
