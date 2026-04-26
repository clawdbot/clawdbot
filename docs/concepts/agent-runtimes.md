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
implements the `codex` runtime. Public config uses `agentRuntime.id`; `openclaw
doctor --fix` rewrites older runtime-policy keys to that shape.

There are two runtime families:

- **Embedded harnesses** run inside OpenClaw's prepared agent loop. Today this
  is the built-in `pi` runtime plus registered plugin harnesses such as
  `codex`.
- **CLI backends** run a local CLI process while keeping the model ref
  canonical. For example, `anthropic/claude-opus-4-7` with
  `agentRuntime.id: "claude-cli"` means "select the Anthropic model, execute
  through Claude CLI." `claude-cli` is not an embedded harness id and must not
  be passed to AgentHarness selection.

## Three things named Codex

Most confusion comes from three different surfaces sharing the Codex name:

| Surface                                              | OpenClaw name/config                 | What it does                                                                                        |
| ---------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Codex OAuth provider route                           | `openai-codex/*` model refs          | Uses ChatGPT/Codex subscription OAuth through the normal OpenClaw PI runner.                        |
| Native Codex app-server runtime                      | `agentRuntime.id: "codex"`           | Runs the embedded agent turn through the bundled Codex app-server harness.                          |
| Codex ACP adapter                                    | `runtime: "acp"`, `agentId: "codex"` | Runs Codex through the external ACP/acpx control plane. Use only when ACP/acpx is explicitly asked. |
| Native Codex chat-control command set                | `/codex ...`                         | Binds, resumes, steers, stops, and inspects Codex app-server threads from chat.                     |
| OpenAI Platform API route for GPT/Codex-style models | `openai/*` model refs                | Uses OpenAI API-key auth unless a runtime override, such as `runtime: "codex"`, runs the turn.      |

Those surfaces are intentionally independent. Enabling the `codex` plugin makes
the native app-server features available; it does not rewrite
`openai-codex/*` into `openai/*`, does not change existing sessions, and does
not make ACP the Codex default. Selecting `openai-codex/*` means "use the Codex
OAuth provider route" unless you separately force a runtime.

The common Codex setup uses the `openai` provider with the `codex` runtime:

```json5
{
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
      agentRuntime: {
        id: "codex",
      },
    },
  },
}
```

That means OpenClaw selects an OpenAI model ref, then asks the Codex app-server
runtime to run the embedded agent turn. It does not mean the channel, model
provider catalog, or OpenClaw session store becomes Codex.

When the bundled `codex` plugin is enabled, natural-language Codex control
should use the native `/codex` command surface (`/codex bind`, `/codex threads`,
`/codex resume`, `/codex steer`, `/codex stop`) instead of ACP. Use ACP for
Codex only when the user explicitly asks for ACP/acpx or is testing the ACP
adapter path. Claude Code, Gemini CLI, OpenCode, Cursor, and similar external
harnesses still use ACP.

This is the agent-facing decision tree:

1. If the user asks for **Codex bind/control/thread/resume/steer/stop**, use the
   native `/codex` command surface when the bundled `codex` plugin is enabled.
2. If the user asks for **Codex as the embedded runtime**, use
   `openai/<model>` with `agentRuntime.id: "codex"`.
3. If the user asks for **Codex OAuth/subscription auth on the normal OpenClaw
   runner**, use `openai-codex/<model>` and leave the runtime as PI.
4. If the user explicitly says **ACP**, **acpx**, or **Codex ACP adapter**, use
   ACP with `runtime: "acp"` and `agentId: "codex"`.
5. If the request is for **Claude Code, Gemini CLI, OpenCode, Cursor, Droid, or
   another external harness**, use ACP/acpx, not the native sub-agent runtime.

| You mean...                             | Use...                                       |
| --------------------------------------- | -------------------------------------------- |
| Codex app-server chat/thread control    | `/codex ...` from the bundled `codex` plugin |
| Codex app-server embedded agent runtime | `agentRuntime.id: "codex"`                   |
| OpenAI Codex OAuth on the PI runner     | `openai-codex/*` model refs                  |
| Claude Code or other external harness   | ACP/acpx                                     |

For the OpenAI-family prefix split, see [OpenAI](/providers/openai) and
[Model providers](/concepts/model-providers). For the Codex runtime support
contract, see [Codex harness](/plugins/codex-harness#v1-support-contract).

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

1. A session's recorded runtime wins. Config changes do not hot-switch an
   existing transcript to a different native thread system.
2. `OPENCLAW_AGENT_RUNTIME=<id>` forces that runtime for new or reset sessions.
3. `agents.defaults.agentRuntime.id` or `agents.list[].agentRuntime.id` can set
   `auto`, `pi`, a registered embedded harness id such as `codex`, or a
   supported CLI backend alias such as `claude-cli`.
4. In `auto` mode, registered plugin runtimes can claim supported provider/model
   pairs.
5. If no runtime claims a turn in `auto` mode and `fallback: "pi"` is set
   (the default), OpenClaw uses PI as the compatibility fallback. Set
   `fallback: "none"` to make unmatched `auto`-mode selection fail instead.

Explicit plugin runtimes fail closed by default. For example,
`runtime: "codex"` means Codex or a clear selection error unless you set
`fallback: "pi"` in the same override scope. A runtime override does not inherit
a broader fallback setting, so an agent-level `runtime: "codex"` is not silently
routed back to PI just because defaults used `fallback: "pi"`.

CLI backend aliases are different from embedded harness ids. The preferred
Claude CLI form is:

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-7",
      agentRuntime: { id: "claude-cli" },
    },
  },
}
```

Legacy refs such as `claude-cli/claude-opus-4-7` remain supported for
compatibility, but new config should keep the provider/model canonical and put
the execution backend in `agentRuntime.id`.

`auto` mode is intentionally conservative. Plugin runtimes can claim
provider/model pairs they understand, but the Codex plugin does not claim the
`openai-codex` provider in `auto` mode. That keeps
`openai-codex/*` as the explicit PI Codex OAuth route and avoids silently
moving subscription-auth configs onto the native app-server harness.

If `openclaw doctor` warns that the `codex` plugin is enabled while
`openai-codex/*` still routes through PI, treat that as a diagnosis, not a
migration. Keep the config unchanged when PI Codex OAuth is what you want.
Switch to `openai/<model>` plus `agentRuntime.id: "codex"` only when you want native
Codex app-server execution.

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
[Codex harness](/plugins/codex-harness#v1-support-contract).

## Status labels

Status output may show both `Execution` and `Runtime` labels. Read them as
diagnostics, not as provider names.

- A model ref such as `openai/gpt-5.5` tells you the selected provider/model.
- A runtime id such as `codex` tells you which loop is executing the turn.
- A channel label such as Telegram or Discord tells you where the conversation is happening.

If a session still shows PI after changing runtime config, start a new session
with `/new` or clear the current one with `/reset`. Existing sessions keep their
recorded runtime so a transcript is not replayed through two incompatible native
session systems.

## Related

- [Codex harness](/plugins/codex-harness)
- [OpenAI](/providers/openai)
- [Agent harness plugins](/plugins/sdk-agent-harness)
- [Agent loop](/concepts/agent-loop)
- [Models](/concepts/models)
- [Status](/cli/status)
