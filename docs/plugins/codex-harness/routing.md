---
summary: "Choose which OpenAI routes select Codex and shape the deployment around them"
read_when:
  - You need to know which model refs select the Codex runtime
  - You want a fail-closed Codex requirement
  - You are configuring a mixed-provider fleet
title: "Codex routing and deployment"
sidebarTitle: "Routing and deployment"
---

Which effective routes select the Codex runtime, and the deployment shapes built on that policy. Part of the [Codex harness](/plugins/codex-harness) guide; [Where each section moved](/plugins/codex-harness#where-each-section-moved) lists every section.

## Routing and model selection

`openai/gpt-6-astra` defaults to `low` reasoning effort through the shared
OpenAI provider policy. This limits routine reasoning cost and subscription
budget use. For OpenClaw-managed turns, the resolved effort is sent in Codex `turn/start` requests,
including `collaborationMode.settings.reasoning_effort`, so the native thread
uses the same default as Control UI. Explicit thinking settings still win;
an existing session or agent configured for `high` stays at `high`. Threads
attached with native settings preserved retain their native effort.

Keep provider refs and runtime policy separate:

- Use `openai/gpt-*` for canonical OpenAI model selection. The prefix alone
  never selects Codex.
- With runtime unset or `auto`, only an exact official HTTPS Platform Responses
  or ChatGPT Responses route with no authored provider request override may
  select Codex implicitly. Valid model-scoped Fast-mode and cutoff controls do
  not count as authored request params.
- Do not use legacy Codex GPT refs in config; run `openclaw doctor --fix` to
  repair legacy refs and stale session route pins.
- `agentRuntime.id: "codex"` makes Codex a fail-closed requirement for a
  compatible route. It does not make an incompatible effective route compatible.
- `agentRuntime.id: "openclaw"` opts a provider or model into the embedded
  OpenClaw runtime when that is intentional.
- `/codex ...` controls native Codex app-server conversations from chat.
- ACP/acpx is a separate external harness path. Use it only when the user
  asks for ACP/acpx or an external harness adapter.

| User intent                                                | Use                                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Attach the current chat                                    | `/codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]`                    |
| Resume an existing Codex thread                            | `/codex resume <thread-id>`                                                                           |
| List or filter Codex threads                               | `/codex threads [filter]`                                                                             |
| Read or update the bound thread's native goal              | `/codex goal [status\|set <objective>\|pause\|resume\|block\|complete\|clear]`                        |
| List native Codex plugins                                  | `/codex plugins list`                                                                                 |
| Discover available native Codex marketplace plugins        | `/codex plugins available`                                                                            |
| Install and authorize one native Codex plugin              | `/codex plugins install <plugin>@<marketplace>`                                                       |
| Enable or disable a configured native Codex plugin         | `/codex plugins enable <name>`, `/codex plugins disable <name>`                                       |
| Resume a stored Codex CLI session as a paired-node turn    | `/codex sessions --host <node> [filter]`, then `/codex resume <session-id> --host <node> --bind here` |
| View non-archived Codex sessions across computers          | Enable Codex supervision and open **Codex Sessions**                                                  |
| Change the bound thread's model, fast-mode, or permissions | `/codex model <model>`, `/codex fast [on\|off\|status]`, `/codex permissions [default\|yolo\|status]` |
| Compact the current Codex session                          | `/codex compact`                                                                                      |
| Stop or steer the active turn                              | `/codex stop`, `/codex steer <text>`                                                                  |
| Detach the current binding                                 | `/codex detach` (alias `/codex unbind`)                                                               |
| Send Codex feedback only                                   | `/codex diagnostics [note]`                                                                           |
| Start an ACP/acpx task                                     | ACP/acpx session commands, not `/codex`                                                               |

| Use case                                        | Configure                                                                                                            | Verify                                  | Notes                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------- |
| Eligible OpenAI route with native Codex runtime | Exact official HTTPS Responses/ChatGPT route with no authored provider request override, plus enabled `codex` plugin | `/status` shows `Runtime: OpenAI Codex` | Valid Fast runtime controls do not disqualify this path    |
| Fail closed if Codex is unavailable             | Provider or model `agentRuntime.id: "codex"`                                                                         | Missing harness fails the turn          | Authored request overrides may still use declared fallback |
| Direct OpenAI API-key traffic through OpenClaw  | Provider or model `agentRuntime.id: "openclaw"` and normal OpenAI auth                                               | `/status` shows OpenClaw runtime        | Use only when OpenClaw is intentional                      |
| Legacy config                                   | legacy Codex GPT refs                                                                                                | `openclaw doctor --fix` rewrites it     | Do not write new config this way                           |
| ACP/acpx Codex adapter                          | ACP `sessions_spawn({ runtime: "acp" })`                                                                             | ACP task/session status                 | Separate from native Codex harness                         |

`agents.defaults.imageModel` follows the same prefix split. Use `openai/gpt-*`
for the normal OpenAI route and `codex/gpt-*` only when image understanding
should run through a bounded Codex app-server turn. Doctor rewrites legacy
Codex GPT refs to `openai/gpt-*`.

## Deployment patterns

### Basic Codex deployment

Use the quickstart config for an OpenAI model whose effective official HTTPS
route is eligible to select Codex implicitly:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
  agents: {
    defaults: {
      model: "openai/gpt-5.6-sol",
    },
  },
}
```

### Mixed provider deployment

Configure a Claude `main` agent and add a named Codex agent:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
  agents: {
    ownership: "explicit",
    defaults: {
      model: "anthropic/claude-opus-4-6",
    },
    entries: {
      main: {
        model: "anthropic/claude-opus-4-6",
      },
      codex: {
        name: "Codex",
        model: "openai/gpt-5.6-sol",
      },
    },
  },
}
```

This explicit fleet has no default agent; target `main` or `codex` with a session, `--agent`, or binding. The `main` agent uses its normal provider path. The `codex` agent uses Codex app-server when its effective OpenAI route remains compatible; add explicit model-scoped `agentRuntime.id: "codex"` when that should be a fail-closed requirement.

### Fail-closed Codex deployment

An eligible exact official HTTPS OpenAI route can resolve to Codex when the
bundled plugin is available. Add explicit runtime policy for a written
fail-closed rule:

```json5
{
  models: {
    providers: {
      openai: {
        agentRuntime: {
          id: "codex",
        },
      },
    },
  },
  agents: {
    defaults: {
      model: "openai/gpt-5.6-sol",
    },
  },
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
}
```

With Codex forced, OpenClaw fails early if the plugin is disabled, the app-server
is too old or cannot start, or route/auth support is rejected without a declared
fallback. Authored request overrides may instead use the
[selection-time OpenClaw fallback](/concepts/agent-runtimes#runtime-selection)
that preserves the exact request. Once Codex starts, its failures are not replayed
through OpenClaw.
