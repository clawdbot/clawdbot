---
summary: "How OpenClaw separates model providers, models, channels, and agent runtimes"
title: "Agent runtimes"
read_when:
  - You are choosing between PI, Codex, ACP, or another native agent runtime
  - You are confused by provider/model/runtime labels in status or config
  - You are documenting support parity for a native harness
---

An **agent runtime** is the component that owns one prepared model loop: it
receives the prompt, drives model output, handles native tool calls, and returns
the finished turn to OpenClaw.

Runtimes are easy to confuse with providers because both show up near model
configuration. They are different layers:

| Layer         | Examples                              | What it means                                                       |
| ------------- | ------------------------------------- | ------------------------------------------------------------------- |
| Provider      | `openai`, `anthropic`, `openai-codex` | How OpenClaw authenticates, discovers models, and names model refs. |
| Model         | `gpt-5.5`, `claude-opus-4-6`          | The model selected for the agent turn.                              |
| Agent runtime | `pi`, `codex`, `claude-cli`           | The low level loop or backend that executes the prepared turn.      |
| Channel       | Telegram, Discord, Slack, WhatsApp    | Where messages enter and leave OpenClaw.                            |

You will also see the word **harness** in code. A harness is the implementation
that provides an agent runtime. For example, the bundled Codex harness
implements the `codex` runtime. Public config uses `agentRuntime.id` on
provider or model entries; whole-agent runtime keys are legacy and ignored.
`openclaw doctor --fix` removes old whole-agent runtime pins and rewrites
legacy runtime model refs to canonical provider/model refs plus model-scoped
runtime policy where needed.

There are two runtime families:

- **Embedded harnesses** run inside OpenClaw's prepared agent loop. Today this
  is the built-in `pi` runtime plus registered plugin harnesses such as
  `codex`.
- **CLI backends** run a local CLI process while keeping the model ref
  canonical. For example, `anthropic/claude-opus-4-7` with
  a model-scoped `agentRuntime.id: "claude-cli"` means "select the Anthropic
  model, execute through Claude CLI." `claude-cli` is not an embedded harness id
  and must not be passed to AgentHarness selection.

## Codex surfaces

Most confusion comes from several different surfaces sharing the Codex name:

| Surface                                          | OpenClaw name/config                 | What it does                                                                                                   |
| ------------------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Native Codex app-server runtime                  | `openai/*` model refs                | Runs OpenAI embedded agent turns through Codex app-server. This is the usual ChatGPT/Codex subscription setup. |
| Codex OAuth auth profiles                        | `openai-codex` auth provider         | Stores ChatGPT/Codex subscription auth that the Codex app-server harness consumes.                             |
| Codex ACP adapter                                | `runtime: "acp"`, `agentId: "codex"` | Runs Codex through the external ACP/acpx control plane. Use only when ACP/acpx is explicitly asked.            |
| Native Codex chat-control command set            | `/codex ...`                         | Binds, resumes, steers, stops, and inspects Codex app-server threads from chat.                                |
| OpenAI Platform API route for non-agent surfaces | `openai/*` plus API-key auth         | Used for direct OpenAI APIs such as images, embeddings, speech, and realtime.                                  |

Those surfaces are intentionally independent. Enabling the `codex` plugin makes
the native app-server features available; `openclaw doctor --fix` owns legacy
`openai-codex/*` route repair and stale session pin cleanup. Selecting
`openai/*` for an agent model now means "run this through Codex" unless a
non-agent OpenAI API surface is being used.

The common ChatGPT/Codex subscription setup uses Codex OAuth for auth, but keeps
the model ref as `openai/*` and selects the `codex` runtime:

```json5
{
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
    },
  },
}
```

That means OpenClaw selects an OpenAI model ref, then asks the Codex app-server
runtime to run the embedded agent turn. It does not mean "use API billing," and
it does not mean the channel, model provider catalog, or OpenClaw session store
becomes Codex.

When the bundled `codex` plugin is enabled, natural-language Codex control
should use the native `/codex` command surface (`/codex bind`, `/codex threads`,
`/codex resume`, `/codex steer`, `/codex stop`) instead of ACP. Use ACP for
Codex only when the user explicitly asks for ACP/acpx or is testing the ACP
adapter path. Claude Code, Gemini CLI, OpenCode, Cursor, and similar external
harnesses still use ACP.

This is the agent-facing decision tree:

1. If the user asks for **Codex bind/control/thread/resume/steer/stop**, use the
   native `/codex` command surface when the bundled `codex` plugin is enabled.
2. If the user asks for **Codex as the embedded runtime** or wants the normal
   subscription-backed Codex agent experience, use `openai/<model>`.
3. If the user explicitly chooses **PI for an OpenAI model**, keep the model ref
   as `openai/<model>` and set provider/model runtime policy to
   `agentRuntime.id: "pi"`. A selected `openai-codex` auth profile is routed
   internally through PI's legacy Codex-auth transport.
4. If legacy config still contains **`openai-codex/*` model refs**, repair it to
   `openai/<model>` with `openclaw doctor --fix`; doctor keeps the Codex auth
   route by adding provider/model-scoped `agentRuntime.id: "codex"` where the
   old model ref implied it.
5. If the user explicitly says **ACP**, **acpx**, or **Codex ACP adapter**, use
   ACP with `runtime: "acp"` and `agentId: "codex"`.
6. If the request is for **Claude Code, Gemini CLI, OpenCode, Cursor, Droid, or
   another external harness**, use ACP/acpx, not the native sub-agent runtime.

| You mean...                             | Use...                                       |
| --------------------------------------- | -------------------------------------------- |
| Codex app-server chat/thread control    | `/codex ...` from the bundled `codex` plugin |
| Codex app-server embedded agent runtime | `openai/*` agent model refs                  |
| OpenAI Codex OAuth                      | `openai-codex` auth profiles                 |
| Claude Code or other external harness   | ACP/acpx                                     |

For the OpenAI-family prefix split, see [OpenAI](/providers/openai) and
[Model providers](/concepts/model-providers). For the Codex runtime support
contract, see [Codex harness runtime](/plugins/codex-harness-runtime#v1-support-contract).

## Runtime ownership

Different runtimes own different amounts of the loop.

| Surface                     | OpenClaw PI embedded                    | Codex app-server                                                            |
| --------------------------- | --------------------------------------- | --------------------------------------------------------------------------- |
| Model loop owner            | OpenClaw through the PI embedded runner | Codex app-server                                                            |
| Canonical thread state      | OpenClaw transcript                     | Codex thread, plus OpenClaw transcript mirror                               |
| OpenClaw dynamic tools      | Native OpenClaw tool loop               | Bridged through the Codex adapter                                           |
| Native shell and file tools | PI/OpenClaw path                        | Codex-native tools, bridged through native hooks where supported            |
| Context engine              | Native OpenClaw context assembly        | OpenClaw projects assembled context into the Codex turn                     |
| Compaction                  | OpenClaw or selected context engine     | Codex-native compaction, with OpenClaw notifications and mirror maintenance |
| Channel delivery            | OpenClaw                                | OpenClaw                                                                    |

This ownership split is the main design rule:

- If OpenClaw owns the surface, OpenClaw can provide normal plugin hook behavior.
- If the native runtime owns the surface, OpenClaw needs runtime events or native hooks.
- If the native runtime owns canonical thread state, OpenClaw should mirror and project context, not rewrite unsupported internals.

## Runtime selection

OpenClaw chooses an embedded runtime after provider and model resolution:

1. Model-scoped runtime policy wins. This can live in a configured provider
   model entry or in `agents.defaults.models["provider/model"].agentRuntime` /
   `agents.list[].models["provider/model"].agentRuntime`.
2. Provider-scoped runtime policy comes next at
   `models.providers.<provider>.agentRuntime`.
3. In `auto` mode, registered plugin runtimes can claim supported provider/model
   pairs.
4. If no runtime claims a turn in `auto` mode, OpenClaw uses PI as the
   compatibility runtime. Use an explicit runtime id when the run must be
   strict.

Whole-session and whole-agent runtime pins are ignored. That includes
`OPENCLAW_AGENT_RUNTIME`, session `agentHarnessId`/`agentRuntimeOverride` state,
`agents.defaults.agentRuntime`, and `agents.list[].agentRuntime`. Run
`openclaw doctor --fix` to remove stale whole-agent runtime config and convert
legacy runtime model refs where OpenClaw can preserve the intent.

Explicit provider/model plugin runtimes fail closed. For example,
`agentRuntime.id: "codex"` on a provider or model means Codex or a clear
selection/runtime error; it is never silently routed back to PI.

CLI backend aliases are different from embedded harness ids. The preferred
Claude CLI form is:

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-7",
      models: {
        "anthropic/claude-opus-4-7": {
          agentRuntime: { id: "claude-cli" },
        },
      },
    },
  },
}
```

Legacy refs such as `claude-cli/claude-opus-4-7` remain supported for
compatibility, but new config should keep the provider/model canonical and put
the execution backend in provider/model runtime policy.

`auto` mode is intentionally conservative for most providers. OpenAI agent
models are the exception: unset runtime and `auto` both resolve to the Codex
harness. Explicit PI runtime config remains an opt-in compatibility route for
`openai/*` agent turns; when paired with a selected `openai-codex` auth profile,
OpenClaw routes PI internally through the legacy Codex-auth transport while
keeping the public model ref as `openai/*`. Stale OpenAI PI session pins are
ignored by runtime selection and can be cleaned with `openclaw doctor --fix`.

If `openclaw doctor` warns that the `codex` plugin is enabled while
`openai-codex/*` remains in config, treat that as legacy route state. Run
`openclaw doctor --fix` to rewrite it to `openai/*` with the Codex runtime.

## Compatibility contract

When a runtime is not PI, it should document what OpenClaw surfaces it supports.
Use this shape for runtime docs:

| Question                               | Why it matters                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Who owns the model loop?               | Determines where retries, tool continuation, and final answer decisions happen.                   |
| Who owns canonical thread history?     | Determines whether OpenClaw can edit history or only mirror it.                                   |
| Do OpenClaw dynamic tools work?        | Messaging, sessions, cron, and OpenClaw-owned tools rely on this.                                 |
| Do dynamic tool hooks work?            | Plugins expect `before_tool_call`, `after_tool_call`, and middleware around OpenClaw-owned tools. |
| Do native tool hooks work?             | Shell, patch, and runtime-owned tools need native hook support for policy and observation.        |
| Does the context engine lifecycle run? | Memory and context plugins depend on assemble, ingest, after-turn, and compaction lifecycle.      |
| What compaction data is exposed?       | Some plugins only need notifications, while others need kept/dropped metadata.                    |
| What is intentionally unsupported?     | Users should not assume PI equivalence where the native runtime owns more state.                  |

The Codex runtime support contract is documented in
[Codex harness runtime](/plugins/codex-harness-runtime#v1-support-contract).

## Status labels

Status output may show both `Execution` and `Runtime` labels. Read them as
diagnostics, not as provider names.

- A model ref such as `openai/gpt-5.5` tells you the selected provider/model.
- A runtime id such as `codex` tells you which loop is executing the turn.
- A channel label such as Telegram or Discord tells you where the conversation is happening.

If a run still shows an unexpected runtime, inspect the selected provider/model
runtime policy first. Legacy session runtime pins no longer decide routing.

## Related

- [Codex harness](/plugins/codex-harness)
- [Codex harness runtime](/plugins/codex-harness-runtime)
- [OpenAI](/providers/openai)
- [Agent harness plugins](/plugins/sdk-agent-harness)
- [Agent loop](/concepts/agent-loop)
- [Models](/concepts/models)
- [Status](/cli/status)
