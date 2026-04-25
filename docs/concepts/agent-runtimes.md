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
| Agent runtime | `pi`, `codex`, ACP-backed runtimes    | The low level loop that executes the prepared turn.                 |
| Channel       | Telegram, Discord, Slack, WhatsApp    | Where messages enter and leave OpenClaw.                            |

You will also see the word **harness** in code and config. A harness is the
implementation that provides an agent runtime. For example, the bundled Codex
harness implements the `codex` runtime. The config key is still named
`embeddedHarness` for compatibility, but user-facing docs and status output
should generally say runtime.

The common Codex setup uses the `openai` provider with the `codex` runtime:

```json5
{
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
      embeddedHarness: {
        runtime: "codex",
      },
    },
  },
}
```

That means OpenClaw selects an OpenAI model ref, then asks the Codex app-server
runtime to run the embedded agent turn. It does not mean the channel, model
provider catalog, or OpenClaw session store becomes Codex.

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
3. `agents.defaults.embeddedHarness.runtime` or
   `agents.list[].embeddedHarness.runtime` can set `auto`, `pi`, or a registered
   runtime id such as `codex`.
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
