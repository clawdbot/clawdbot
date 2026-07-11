---
summary: "CLI reference and security model for Crestodian, the configless-safe setup and repair helper"
read_when:
  - You run openclaw with no command after setup and want to understand Crestodian
  - You need a configless-safe way to inspect or repair OpenClaw
  - You are designing or enabling message-channel rescue mode
title: "Crestodian"
---

# `openclaw crestodian`

Crestodian is OpenClaw's local setup, repair, and configuration helper. It stays reachable when the normal agent path is broken: it can run when `openclaw.json` is missing or invalid, the Gateway is down, plugin command registration is unavailable, or no agent is configured yet.

## When it starts

Running `openclaw` with no subcommand routes based on config state:

- Config missing, or exists with no authored settings (empty, or only `$schema`/`meta` keys): starts guided onboarding with live AI verification.
- Config exists but fails validation: starts Crestodian.
- Config exists and is valid: opens the normal agent TUI (against a reachable configured Gateway, or locally if none is reachable). Use `/crestodian` inside the TUI, or run `openclaw crestodian` directly, to reach Crestodian.

Running `openclaw crestodian` always starts Crestodian explicitly, regardless of config state. `openclaw --help` and `openclaw --version` keep their normal fast paths.

Noninteractive bare `openclaw` (no TTY) exits with a short message instead of printing root help: it points to non-interactive onboarding on a fresh install, to `openclaw crestodian --message "status"` when config is invalid, or to `openclaw agent --local ...` when config is valid.

`openclaw onboard --modern` starts Crestodian directly. Plain `openclaw onboard`
starts guided onboarding; `openclaw onboard --classic` opens the full
step-by-step wizard.

## What Crestodian shows

Interactive Crestodian opens the same TUI shell as `openclaw tui`, with a Crestodian chat backend. The startup greeting covers:

- config validity and the default agent
- the model or deterministic planner path Crestodian is using
- Gateway reachability from the first startup probe
- the next recommended debug action

It does not dump secrets or load plugin CLI commands just to start.

Use `status` for the detailed inventory: config path, docs/source paths, local CLI probes, key/token presence, agents, model, and Gateway details.

Crestodian uses the same reference discovery as regular agents: in a Git checkout it points at local `docs/` and the source tree; in an npm install it uses bundled docs and links to [https://github.com/openclaw/openclaw](https://github.com/openclaw/openclaw), with guidance to check source when docs are not enough.

## Examples

```bash
openclaw
openclaw crestodian
openclaw crestodian --json
openclaw crestodian --message "models"
openclaw crestodian --message "validate config"
openclaw crestodian --message "setup workspace ~/Projects/work model openai/gpt-5.6" --yes
openclaw crestodian --message "set default model openai/gpt-5.6" --yes
openclaw onboard --modern
```

Inside the Crestodian TUI:

```text
status
health
doctor
doctor fix
validate config
setup
setup workspace ~/Projects/work model openai/gpt-5.6
config set gateway.port 19001
config set-ref gateway.auth.token env OPENCLAW_GATEWAY_TOKEN
gateway status
restart gateway
agents
create agent work workspace ~/Projects/work
models
configure model provider
set default model openai/gpt-5.6
channels
channel info slack
connect slack
open setup wizard
open classic wizard
open channel wizard for slack
plugins list
plugins search slack
plugin install clawhub:openclaw-codex-app-server
plugin uninstall openclaw-codex-app-server
talk to work agent
talk to agent for ~/Projects/work
audit
quit
```

## Operations and approval

Crestodian uses typed operations instead of editing config ad hoc.

Read-only operations run immediately: show overview, list agents, list installed plugins, search ClawHub plugins, show model/backend status, run status/health checks, check Gateway reachability, run doctor without interactive fixes, validate config, show the audit-log path.

Starting guided channel setup (`connect telegram`) or model-provider setup (`configure model provider`) also runs immediately. Each wizard collects explicit answers and owns the resulting writes.

Persistent, require conversational approval (or `--yes` for a direct command): write config, `config set`, `config set-ref`, setup/onboarding bootstrap, change the default model, start/stop/restart the Gateway, create agents, install or uninstall plugins, run doctor repairs that rewrite config or state.

Approval is given in your own words: unambiguous replies ("yes", "sure", "go ahead", "not now") resolve from a closed deterministic list, and anything else is judged by a separate host-run model call that sees only your message and the pending proposal — never by the conversation model itself, which cannot self-approve. Ambiguous replies keep the proposal pending and the conversation asks again. When no model is usable, only the closed deterministic list applies.

Applied writes are recorded in `~/.openclaw/audit/crestodian.jsonl`. Discovery is not audited; only applied operations and writes are.

Channel setup can run as a hosted conversation until it reaches a secret. The
local Crestodian TUI does not accept sensitive wizard answers because terminal
chat input is visible. It offers `open channel wizard` immediately, carrying
the selected channel into the masked terminal wizard; you can also run
`openclaw channels add --channel <channel>` later.

### Switching to the menu wizards

The local chat can hand control back to any terminal menu flow:

```text
open setup wizard
open classic wizard
open channel wizard for slack
channel info slack
```

`open setup wizard` opens guided onboarding. `open classic wizard` opens the
full classic setup. `open channel wizard for <channel>` opens masked channel
setup after the chat TUI closes. Use `channel info <channel>` first for the
channel label, setup state, prerequisites summary, and docs link.

Model-provider setup uses the same provider/auth and default-model steps as
`openclaw onboard`. In the local Crestodian TUI, approval exits the chat shell,
runs those steps with masked terminal prompts, and then resumes Crestodian. A
gateway/app chat that supports sensitive replies hosts the same steps inline.

## Setup bootstrap

`setup` is the chat-first onboarding bootstrap. It writes only through typed config operations and asks for approval first.

```text
setup
setup workspace ~/Projects/work
setup workspace ~/Projects/work model openai/gpt-5.6
```

When no model is configured, setup picks the first usable backend in this
order and tells you what it chose:

1. Existing explicit model, if already configured.
2. `OPENAI_API_KEY` -> `openai/gpt-5.6` (the bare direct-API id resolves to Sol)
3. `ANTHROPIC_API_KEY` -> `anthropic/claude-opus-4-8`
4. Claude Code CLI -> `claude-cli/claude-opus-4-8`, or Codex ->
   `openai/gpt-5.6-sol` through the Codex app-server harness. When both work,
   their order is randomized so neither is preferred.
5. The other working Claude Code/Codex option
6. Gemini CLI -> `google-gemini-cli/gemini-3.1-pro-preview`

The first existing explicit model always wins, so setup preserves an existing
`openai/gpt-5.5` primary. If an OpenAI account does not expose GPT-5.6, set
`openai/gpt-5.5` explicitly instead; Crestodian does not silently downgrade.

If none are available, setup still writes the workspace and Gateway configuration, then asks whether to configure a model provider. Accepting opens the normal onboarding provider/auth and default-model steps. Declining leaves Crestodian in deterministic mode; exact setup and repair commands still work, but the normal agent cannot answer until a provider and default model are configured. Run `configure model provider` later to reopen the provider flow.

The macOS app drives the same ladder through the `crestodian.setup.detect` and `crestodian.setup.activate` gateway methods: detect lists every reusable backend it finds, activate live-tests one candidate (a real "reply with OK" completion), and only selects the model, workspace, Gateway defaults, and supervision after the test passes. A failed candidate does not select those defaults; an opportunistic managed Codex plugin install can remain recorded even when a later live probe fails. The app automatically walks down the ladder and finally offers a manual key/token step populated from the Gateway's active text-inference provider plugins. The selected provider owns its starter model and config, and the credential is verified the same way before it is saved.

When setup detects a native Codex installation, successful backend activation
also attempts to install and enable the official `codex` plugin and its
supervision capability, even when another inference backend wins the ladder.
Native, non-archived Codex sessions become visible in both apps when that
opportunistic plugin activation succeeds. App Server availability is checked
when supervision first connects. An explicit Codex plugin disable or policy
block prevents opportunistic activation, and an existing
`plugins.entries.codex.config.supervision.enabled: false` remains an opt-out.

## AI conversation

Interactive Crestodian is AI-only: every message — including ones that look like typed commands — runs through the same embedded agent loop as regular OpenClaw agents, restricted to one ring-zero `crestodian` tool that wraps the typed operations. Read actions run freely, mutations require your conversational approval for that exact operation (see Operations and approval), and every applied write is audited and re-validated. The agent session persists, so the custodian has real multi-turn memory. It first uses the configured OpenClaw model; with no usable model it falls back to a local runtime already present on the machine, in setup-ladder order:

- Claude Code CLI (`claude-cli/claude-opus-4-8`) and the Codex app-server harness (`openai/gpt-5.6-sol`) are randomized peers when both work. Claude serves the ring-zero tool over MCP; Codex enforces a single-tool allow-list.
- Gemini CLI: `google-gemini-cli/gemini-3.1-pro-preview` (agent loop; ring-zero tool over MCP)

When the agent loop is unavailable, Crestodian degrades to a bounded single-turn planner, and only without any usable model at all to deterministic typed commands. The planner cannot mutate config directly; it must translate the request into one of Crestodian's typed commands, and normal approval/audit rules apply. Crestodian prints the model it used and the interpreted command before running anything. Fallback planner turns are temporary, tool-disabled where the runtime supports it, and use a temporary workspace/session.

The typed command grammar is anchored: a message either matches a command exactly or it is conversation. Questions and natural phrasing ("why did my gateway stop?") never trigger operations — they are answered by the AI.

One secret-hygiene exception: an exact `config set` on a sensitive path (tokens, keys, passwords) never reaches a model. It runs on the deterministic path with a redacted proposal, and the value is masked in the AI-visible history. Prefer `config set-ref <path> env <ENV_VAR>` for secrets.

Message-channel rescue mode never uses the model-assisted planner. Remote rescue stays deterministic so a broken or compromised normal agent path cannot be used as a config editor.

### CLI harness trust model

Embedded runtimes and the Codex app-server harness enforce the ring-zero
restriction directly: the run carries a tool allow-list with only the
`crestodian` tool. CLI harnesses (Claude Code, Gemini CLI) cannot enforce an
OpenClaw tool allow-list — the CLI owns its native tools and its own permission
policy, so OpenClaw fails closed if asked to restrict one. For CLI-harness
models Crestodian instead:

- injects a dedicated MCP server that serves only the `crestodian` tool and
  replaces OpenClaw's normal MCP tool surface for the run (for Claude Code the
  generated config is applied with `--strict-mcp-config`, so no other MCP
  servers are loaded),
- keeps every config mutation inside the tool's approval and audit contract —
  reads run freely, writes require your conversational yes, and every applied
  write is audited and re-validated,
- leaves native tools (file reads, shell) to the harness. They follow the same
  permission posture as normal OpenClaw agent runs on this machine: with
  OpenClaw's default exec settings Claude Code runs with permissions bypassed,
  and a restricted `tools.exec` config falls back to the CLI's own permission
  policy.

Only Crestodian sessions get the crestodian MCP server; normal agent runs
never see this tool. Treat a Crestodian session on a CLI-harness model like a
normal local agent run on the same host: the ring-zero tool adds an audited,
approval-gated path for config repair, but it does not prevent the harness's
native tools from touching files directly. The Codex app-server fallback and
API-key models enforce the strict single-tool loop; prefer those when you want
the hard restriction.

## Switching to an agent

Use a natural-language selector to leave Crestodian and open the normal TUI:

```text
talk to agent
talk to work agent
switch to main agent
```

`openclaw tui`, `openclaw chat`, and `openclaw terminal` open the normal agent TUI directly; they do not start Crestodian. After switching into the normal TUI, `/crestodian` returns to Crestodian, optionally with a follow-up request:

```text
/crestodian
/crestodian restart gateway
```

## Message rescue mode

Message rescue mode is the message-channel entrypoint for Crestodian: use it when your normal agent is dead but a trusted channel (for example WhatsApp) still receives commands.

Supported command: `/crestodian <request>`. Rescue accepts the exact typed command grammar only — natural language is rejected with a hint, never guessed into an operation, and no model is ever consulted.

```text
You, in a trusted owner DM: /crestodian status
OpenClaw: Crestodian rescue mode. Gateway reachable: no. Config valid: no.
You: /crestodian restart gateway
OpenClaw: Plan: restart the Gateway. Reply /crestodian yes to apply.
You: /crestodian yes
OpenClaw: Applied. Audit entry written.
```

Agent creation can also be queued locally or via rescue:

```text
create agent work workspace ~/Projects/work model openai/gpt-5.5
/crestodian create agent work workspace ~/Projects/work
```

Remote rescue is an admin surface and must be treated like remote config repair, not normal chat.

Security contract for remote rescue:

- Disabled when sandboxing is active for the agent/session; Crestodian refuses remote rescue and points to local CLI repair.
- Default effective state is `auto`: allow remote rescue only in trusted YOLO operation, where the runtime already has unsandboxed local authority (`tools.exec.security` resolves to `full` and `tools.exec.ask` resolves to `off`, with sandbox mode `off`).
- Requires an explicit owner identity; no wildcard sender rules, open group policy, unauthenticated webhooks, or anonymous channels.
- Owner DMs only by default; group/channel rescue needs explicit opt-in.
- Plugin search and list are read-only. Plugin install is always local-only (blocked in rescue, even when otherwise enabled) because it downloads executable code. Plugin uninstall can be approved as a persistent rescue operation.
- Remote rescue cannot open the local TUI or switch into an interactive agent session; use local `openclaw` for agent handoff.
- Persistent writes still require approval, even in rescue mode.
- Every applied rescue operation is audited. Message-channel rescue records channel, account, sender, and source-address metadata; config-mutating operations also record config hashes before and after.
- Secrets are never echoed. SecretRef inspection reports availability, not values.
- If the Gateway is alive, rescue prefers Gateway typed operations; if it is dead, rescue uses only the minimal local repair surface that does not depend on the normal agent loop.

Config shape:

```jsonc
{
  "crestodian": {
    "rescue": {
      "enabled": "auto",
      "ownerDmOnly": true,
      "pendingTtlMinutes": 15,
    },
  },
}
```

- `enabled`: `"auto"` (default) allows rescue only when the effective runtime is YOLO and sandboxing is off; `false` never allows message-channel rescue; `true` explicitly allows rescue when owner/channel checks pass (still subject to the sandboxing denial).
- `ownerDmOnly`: restrict rescue to owner direct messages. Default `true`.
- `pendingTtlMinutes`: how long a pending rescue write stays open for `/crestodian yes` approval before expiring. Default `15`.

Remote rescue is covered by the Docker lane:

```bash
pnpm test:docker:crestodian-rescue
```

Configless local planner fallback is covered by:

```bash
pnpm test:docker:crestodian-planner
```

An opt-in live channel command-surface smoke checks `/crestodian status` plus a persistent approval roundtrip through the rescue handler:

```bash
pnpm test:live:crestodian-rescue-channel
```

Configless setup through explicit Crestodian commands is covered by:

```bash
pnpm test:docker:crestodian-first-run
```

That lane starts with an empty state dir, verifies the modern onboard Crestodian entrypoint, sets the default model, creates an additional agent, configures Discord through a plugin enablement plus token SecretRef, validates config, and checks the audit log. QA Lab has a repo-backed scenario for the same Ring 0 flow:

```bash
pnpm openclaw qa suite --scenario crestodian-ring-zero-setup
```

## Related

- [CLI reference](/cli)
- [Doctor](/cli/doctor)
- [TUI](/cli/tui)
- [Sandbox](/cli/sandbox)
- [Security](/cli/security)
