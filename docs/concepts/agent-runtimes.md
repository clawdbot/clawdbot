---
summary: "How OpenClaw separates model providers, models, channels, and agent runtimes"
title: "Agent runtimes"
read_when:
  - You are choosing between OpenClaw, Codex, ACP, or another native agent runtime
  - You are confused by provider/model/runtime labels in status or config
  - You are documenting support parity for a native harness
---

An **agent runtime** owns one prepared model loop: it receives the prompt,
drives model output, handles native tool calls, and returns the finished turn
to OpenClaw.

Runtimes are easy to confuse with providers because both show up near model
configuration. They are different layers:

| Layer         | Examples                                     | Meaning                                                             |
| ------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| Provider      | `anthropic`, `github-copilot`, `openai`      | How OpenClaw authenticates, discovers models, and names model refs. |
| Model         | `claude-opus-4-6`, `gpt-5.6-sol`             | The model selected for the agent turn.                              |
| Agent runtime | `claude-cli`, `codex`, `copilot`, `openclaw` | The low-level loop or backend that executes the prepared turn.      |
| Channel       | Discord, Slack, Telegram, WhatsApp           | Where messages enter and leave OpenClaw.                            |

A **harness** is the implementation that provides an agent runtime (code
term). For example, the bundled Codex harness implements the `codex` runtime.
Public config uses `agentRuntime.id` on provider or model entries; whole-agent
runtime keys are legacy and ignored. `openclaw doctor --fix` removes old
whole-agent runtime pins and rewrites legacy runtime model refs to canonical
provider/model refs plus model-scoped runtime policy where needed.

Two runtime families:

- **Embedded harnesses** run inside OpenClaw's prepared agent loop: the
  built-in `openclaw` runtime, plus registered plugin harnesses such as
  `codex` and `copilot`.
- **CLI backends** run a local CLI process while keeping the model ref
  canonical. For example, `anthropic/claude-opus-4-8` with a model-scoped
  `agentRuntime.id: "claude-cli"` means "select the Anthropic model, execute
  through Claude CLI." `claude-cli` is not an embedded harness id and must not
  be passed to AgentHarness selection.

The `copilot` harness is a separate, opt-in external plugin harness for the
GitHub Copilot CLI; see [GitHub Copilot agent runtime](/plugins/copilot) for
the user-facing decision between PI, Codex, and GitHub Copilot agent runtime.

## Codex surfaces

Several surfaces share the Codex name:

| Surface                                          | OpenClaw name/config                 | What it does                                                                                                   |
| ------------------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Native Codex app-server runtime                  | `openai/*` model refs                | Runs OpenAI embedded agent turns through Codex app-server. This is the usual ChatGPT/Codex subscription setup. |
| Codex OAuth auth profiles                        | `openai` OAuth profiles              | Stores ChatGPT/Codex subscription auth that the Codex app-server harness consumes.                             |
| Codex ACP adapter                                | `runtime: "acp"`, `agentId: "codex"` | Runs Codex through the external ACP/acpx control plane. Use only when ACP/acpx is explicitly asked for.        |
| Native Codex chat-control command set            | `/codex ...`                         | Binds, resumes, steers, stops, and inspects Codex app-server threads from chat.                                |
| OpenAI Platform API route for non-agent surfaces | `openai/*` plus API-key auth         | Direct OpenAI APIs such as images, embeddings, speech, and realtime.                                           |

These surfaces are intentionally independent. Enabling the `codex` plugin
makes native app-server features available; `openclaw doctor --fix` owns
legacy Codex route repair and stale session pin cleanup. Selecting `openai/*`
for an agent model now means "run this through Codex" unless a non-agent
OpenAI API surface is being used.

The common ChatGPT/Codex subscription setup uses Codex OAuth for auth, but
keeps the model ref as `openai/*` and selects the `codex` runtime:

```json5
{
  agents: {
    defaults: {
      model: "openai/gpt-5.6-sol",
    },
  },
}
```

That means OpenClaw selects an OpenAI model ref, then asks the Codex
app-server runtime to run the embedded agent turn. It does not mean "use API
billing," and it does not mean the channel, model provider catalog, or
OpenClaw session store becomes Codex.

When the bundled `codex` plugin is enabled, use the native `/codex` command
surface (`/codex bind`, `/codex threads`, `/codex resume`, `/codex steer`,
`/codex stop`) for natural-language Codex control instead of ACP. Use ACP for
Codex only when the user explicitly asks for ACP/acpx or is testing the ACP
adapter path. Claude Code, Gemini CLI, OpenCode, Cursor, and similar external
harnesses still use ACP.

Decision tree:

1. **Codex bind/control/thread/resume/steer/stop** -> native `/codex` command surface when the bundled `codex` plugin is enabled.
2. **Codex as the embedded runtime** or the normal subscription-backed Codex agent experience -> `openai/<model>`.
3. **OpenClaw explicitly chosen for an OpenAI model** -> keep the model ref as `openai/<model>` and set provider/model runtime policy to `agentRuntime.id: "openclaw"`. A selected `openai` OAuth profile is routed internally through OpenClaw's Codex-auth transport.
4. **Legacy Codex model refs in config** -> repair with `openclaw doctor --fix` to `openai/<model>`; doctor keeps the Codex auth route by adding provider/model-scoped `agentRuntime.id: "codex"` where the old model ref implied it. Legacy **`codex-cli/*`** model refs repair to the same `openai/<model>` Codex app-server route; OpenClaw no longer keeps a bundled Codex CLI backend.
5. **ACP, acpx, or Codex ACP adapter explicitly requested** -> `runtime: "acp"` and `agentId: "codex"`.
6. **Claude Code, Gemini CLI, OpenCode, Cursor, Droid, or another external harness** -> ACP/acpx, not the native sub-agent runtime.

| You mean...                             | Use...                                       |
| --------------------------------------- | -------------------------------------------- |
| Codex app-server chat/thread control    | `/codex ...` from the bundled `codex` plugin |
| Codex app-server embedded agent runtime | `openai/*` agent model refs                  |
| OpenAI Codex OAuth                      | `openai` OAuth profiles                      |
| Claude Code or other external harness   | ACP/acpx                                     |

For the OpenAI-family prefix split, see [OpenAI](/providers/openai) and
[Model providers](/concepts/model-providers). For the Codex runtime support
contract, see [Codex harness runtime](/plugins/codex-harness-runtime#v1-support-contract).

## Runtime ownership

Different runtimes own different amounts of the loop:

| Surface                     | OpenClaw embedded                              | Codex app-server                                                            |
| --------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------- |
| Model loop owner            | OpenClaw, through the OpenClaw embedded runner | Codex app-server                                                            |
| Canonical thread state      | OpenClaw transcript                            | Codex thread, plus OpenClaw transcript mirror                               |
| OpenClaw dynamic tools      | Native OpenClaw tool loop                      | Bridged through the Codex adapter                                           |
| Native shell and file tools | OpenClaw path                                  | Codex-native tools, bridged through native hooks where supported            |
| Context engine              | Native OpenClaw context assembly               | OpenClaw projects assembled context into the Codex turn                     |
| Compaction                  | OpenClaw or selected context engine            | Codex-native compaction, with OpenClaw notifications and mirror maintenance |
| Channel delivery            | OpenClaw                                       | OpenClaw                                                                    |

Design rule: if OpenClaw owns the surface, it can provide normal plugin hook
behavior. If the native runtime owns the surface, OpenClaw needs runtime
events or native hooks. If the native runtime owns canonical thread state,
OpenClaw mirrors and projects context rather than rewriting unsupported
internals.

## Runtime selection

OpenClaw resolves an embedded runtime after provider and model resolution, in
this order:

1. **Model-scoped runtime policy** wins. This lives in a configured provider
   model entry, or in `agents.defaults.models["provider/model"].agentRuntime`
   / `agents.entries.*.models["provider/model"].agentRuntime`. A provider
   wildcard such as `agents.defaults.models["vllm/*"].agentRuntime` applies
   after exact model policy, so dynamically discovered provider models can
   share one runtime without overriding exact per-model exceptions.
2. **Provider-scoped runtime policy**: `models.providers.<provider>.agentRuntime`.
3. **`auto` mode**: registered plugin runtimes can claim supported provider/model pairs.
4. If nothing claims the turn in `auto` mode, OpenClaw falls back to
   `openclaw` as the compatibility runtime. Use an explicit runtime id when
   the run must be strict.

Whole-session and whole-agent runtime pins are ignored: `OPENCLAW_AGENT_RUNTIME`,
session `agentHarnessId`/`agentRuntimeOverride` state, `agents.defaults.agentRuntime`,
and `agents.entries.*.agentRuntime`. Run `openclaw doctor --fix` to remove stale
whole-agent runtime config and convert legacy runtime model refs where intent
can be preserved.

Explicit provider/model plugin runtimes fail closed: `agentRuntime.id: "codex"`
on a provider or model means Codex, or a clear selection/runtime error - it is
never silently routed back to OpenClaw. Only `auto` may route an unmatched
turn to OpenClaw.

CLI backend aliases differ from embedded harness ids. Preferred Claude CLI form:

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-8",
      models: {
        "anthropic/claude-opus-4-8": {
          agentRuntime: { id: "claude-cli" },
        },
      },
    },
  },
}
```

Legacy refs such as `claude-cli/claude-opus-4-7` remain supported for
compatibility, but new config should keep the provider/model canonical and
put the execution backend in provider/model runtime policy.

Legacy `codex-cli/*` refs are different: doctor migrates them to `openai/*` so
they run through the Codex app-server harness instead of preserving a Codex
CLI backend.

`auto` mode is intentionally conservative for most providers. OpenAI agent
models are the exception: unset runtime and `auto` both resolve to the Codex
harness. Explicit OpenClaw runtime config remains an opt-in compatibility
route for `openai/*` agent turns; when paired with a selected `openai` OAuth
profile, OpenClaw routes that path internally through the Codex-auth
transport while keeping the public model ref as `openai/*`. Stale OpenAI
runtime session pins are ignored by runtime selection and can be cleaned with
`openclaw doctor --fix`.

If `openclaw doctor` warns that the `codex` plugin is enabled while legacy
Codex model refs remain in config, treat that as legacy route state and run
`openclaw doctor --fix` to rewrite it to `openai/*` with the Codex runtime.

## GitHub Copilot agent runtime

The external `@openclaw/copilot` plugin registers an opt-in `copilot` runtime
backed by the GitHub Copilot CLI (`@github/copilot-sdk`). It claims the
canonical subscription `github-copilot` provider and is **never** selected by
`auto`. Opt in per-model or per-provider via `agentRuntime.id`:

```json5
{
  agents: {
    defaults: {
      model: "github-copilot/gpt-5.5",
      models: {
        "github-copilot/gpt-5.5": {
          agentRuntime: { id: "copilot" },
        },
      },
    },
  },
}
```

The harness claims its provider, runtime, CLI session key, and auth profile
prefix in `extensions/copilot/doctor-contract-api.ts`, which `openclaw doctor`
auto-loads. For configuration, auth, transcript mirroring, compaction, the
declarative doctor contract, and the broader PI vs Codex vs Copilot SDK
decision, see [GitHub Copilot agent runtime](/plugins/copilot).

## Compatibility contract

When a runtime is not OpenClaw, its docs should state which OpenClaw surfaces
it supports:

| Question                               | Why it matters                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Who owns the model loop?               | Determines where retries, tool continuation, and final answer decisions happen.                   |
| Who owns canonical thread history?     | Determines whether OpenClaw can edit history or only mirror it.                                   |
| Do OpenClaw dynamic tools work?        | Messaging, sessions, cron, and OpenClaw-owned tools rely on this.                                 |
| Do dynamic tool hooks work?            | Plugins expect `before_tool_call`, `after_tool_call`, and middleware around OpenClaw-owned tools. |
| Do native tool hooks work?             | Shell, patch, and runtime-owned tools need native hook support for policy and observation.        |
| Does the context engine lifecycle run? | Memory and context plugins depend on assemble, ingest, after-turn, and compaction lifecycle.      |
| What compaction data is exposed?       | Some plugins only need notifications; others need kept/dropped metadata.                          |
| What is intentionally unsupported?     | Users should not assume OpenClaw equivalence where the native runtime owns more state.            |

The Codex runtime support contract is documented in
[Codex harness runtime](/plugins/codex-harness-runtime#v1-support-contract).

## Status labels

Status output can show both `Execution` and `Runtime` labels. Read them as
diagnostics, not provider names:

- A model ref such as `openai/gpt-5.6-sol` is the selected provider/model.
- A runtime id such as `codex` is the loop executing the turn.
- A channel label such as Telegram or Discord is where the conversation is happening.

If a run shows an unexpected runtime, inspect the selected provider/model
runtime policy first. Legacy session runtime pins no longer decide routing.

## Related

- [Codex harness](/plugins/codex-harness)
- [Codex harness runtime](/plugins/codex-harness-runtime)
- [GitHub Copilot agent runtime](/plugins/copilot)
- [OpenAI](/providers/openai)
- [Agent harness plugins](/plugins/sdk-agent-harness)
- [Agent loop](/concepts/agent-loop)
- [Models](/concepts/models)
- [Status](/cli/status)
