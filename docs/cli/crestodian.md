---
summary: "CLI reference and security model for the inference-backed Crestodian setup and repair helper"
read_when:
  - You finished inference setup and want Crestodian to configure the rest
  - You need to inspect or repair OpenClaw with the local setup agent
  - You are designing or enabling message-channel rescue mode
title: "Crestodian"
---

# `openclaw crestodian`

Conversational Crestodian is OpenClaw's local setup, repair, and configuration
agent. It starts only after the effective default model completes a real turn.
Fresh installs establish inference first; malformed config stays on the
classic doctor path.

## When it starts

Running `openclaw` with no subcommand routes based on config state:

- Config missing, or exists with no authored settings (empty, or only `$schema`/`meta` keys): starts guided onboarding with live AI verification.
- Config exists but fails validation: starts classic onboarding, which reports the issues and directs you to `openclaw doctor`.
- Config exists and is valid: opens the normal agent TUI. A reachable
  configured Gateway whose default agent has a model goes directly to that UI
  without onboarding or Crestodian. Use `/crestodian` inside the TUI, or run
  `openclaw crestodian` directly, to reach Crestodian later.

Running `openclaw crestodian` first live-tests the configured default model. A passing turn starts Crestodian. An interactive failure opens guided inference setup and hands off to Crestodian after a candidate passes. One-shot, JSON, and other noninteractive requests fail with instructions to run `openclaw onboard` when inference is unavailable. `openclaw --help` and `openclaw --version` keep their normal fast paths.

Noninteractive bare `openclaw` (no TTY) exits with a short message instead of printing root help: it points to non-interactive onboarding on a fresh or invalid install, or to `openclaw agent --local ...` when config is valid.

`openclaw onboard --modern` remains a compatibility alias for Crestodian, but uses the same inference gate: working inference opens the chat, interactive failures start guided inference setup, and noninteractive failures exit with onboarding guidance. `openclaw onboard --classic` opens the full step-by-step wizard.

## What Crestodian shows

Interactive Crestodian opens the same TUI shell as `openclaw tui`, with a Crestodian chat backend. The startup greeting covers:

- config validity and the default agent
- the verified model Crestodian is using
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
openclaw crestodian --message "setup workspace ~/Projects/work" --yes
openclaw crestodian --message "set default model openai/gpt-5.6" --yes
openclaw onboard --modern
```

Inside the Crestodian TUI:

```text
status
health
doctor
validate config
setup
setup workspace ~/Projects/work
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
open channel wizard for slack
plugins list
plugins search slack
plugin install clawhub:openclaw-codex-app-server
talk to work agent
talk to agent for ~/Projects/work
audit
quit
```

## Operations and approval

Crestodian uses typed operations instead of editing config ad hoc.

Read-only operations run immediately: show overview, list agents, list installed plugins, search ClawHub plugins, show model/backend status, run status/health checks, check Gateway reachability, run doctor without interactive fixes, validate config, show the audit-log path.

Starting guided channel setup (`connect telegram`) also runs immediately. Its wizard collects explicit answers and owns the resulting writes.

Persistent operations require conversational approval (or `--yes` for a direct command): write config, `config set`, `config set-ref`, setup/onboarding bootstrap, change the default model, start/stop/restart the Gateway, create agents, and install plugins.

Doctor repairs are unavailable inside Crestodian because they can rewrite the provider, authentication, or default-agent inference route powering the session. Exit Crestodian and run `openclaw doctor --fix` in a terminal. Read-only `doctor` remains available inside Crestodian.

New agents inherit the live-verified default inference route. The agent id `crestodian` is reserved for the privileged virtual custodian and cannot be created as a normal agent.

`config set` and `config set-ref` cannot change inference-route state,
including inference-provider credentials, top-level `auth.*`, model catalogs,
CLI backends, default/per-agent model routes, agent params/tools, or root
`tools.*`. Raw writes under `env.*`, `secrets.*`, `plugins.*`, and `$include`
are also refused because they can replace credential resolution or provider
activation. Gateway and channel auth remain normal config surfaces. Use typed plugin/channel workflows and
`set default model <provider/model>` for an already
configured route; it live-tests the route before saving it. To configure or
repair provider/auth access, exit Crestodian and run `openclaw onboard`.

Plugin uninstall is refused inside Crestodian because removing a provider
plugin could disable the inference route powering the session. Exit Crestodian
and run `openclaw plugins uninstall <id>` from a terminal.

Approval is given in your own words: unambiguous replies ("yes", "sure", "go ahead", "not now") resolve from a closed deterministic list. When the configured route supports a separate completion call, other replies can be classified from only your message and the pending proposal — never by the conversation model itself, which cannot self-approve. Unclassified or ambiguous replies keep the proposal pending and the conversation asks again.

Applied writes are recorded in `~/.openclaw/audit/crestodian.jsonl`. Discovery is not audited; only applied operations and writes are.

Channel setup can run as a hosted conversation until it reaches a secret. The
local Crestodian TUI does not accept sensitive wizard answers because terminal
chat input is visible. It offers `open channel wizard` immediately, carrying
the selected channel into the masked terminal wizard; you can also run
`openclaw channels add --channel <channel>` later.

### Switching to masked channel setup

The local chat can hand control to the masked channel wizard:

```text
open channel wizard for slack
channel info slack
```

`open channel wizard for <channel>` opens masked channel setup after the chat
TUI closes. Use `channel info <channel>` first for the channel label, setup
state, prerequisites summary, and docs link.

Crestodian never changes provider/auth access from inside its own session: the
session already depends on that inference route. For model-provider setup or
repair, `configure model provider` returns exit/onboarding guidance without
starting a wizard or writing config. Exit Crestodian and run `openclaw
onboard`; onboarding stages the credentials and saves only a route that
completes a real live turn. Start Crestodian again after onboarding succeeds.

## Setup bootstrap

`setup` configures the remaining workspace and Gateway state after guided onboarding has already established inference. It writes only through typed config operations and asks for approval first.

```text
setup
setup workspace ~/Projects/work
```

`setup` preserves the verified effective model. It does not configure or
replace inference.

If inference is missing or its live check fails, leave Crestodian and run `openclaw onboard`. Guided onboarding detects configured models, API keys, and authenticated local CLIs, asks each candidate for a real reply, and persists only a passing route. Crestodian starts immediately after that boundary and can then configure the workspace, Gateway, channels, agents, plugins, and other optional features.

The macOS app skips this ladder entirely when it reaches a configured Gateway
whose default agent already has a configured model; it opens the normal agent
UI.
For a fresh or incomplete Gateway, the app drives the inference ladder through
the `crestodian.setup.detect` and `crestodian.setup.activate` Gateway methods:
detect lists every candidate backend it finds, activate live-tests one
candidate (a real "reply with OK" completion), and only persists the model,
credential, and provider/runtime state needed for that route after the test passes. Workspace and Gateway defaults remain for Crestodian. A failing candidate
never changes config; the app automatically walks down the ladder and finally
offers a manual key/token step populated from the Gateway's active
text-inference provider plugins. The selected provider owns its starter model
and config, and the credential is verified the same way before it is saved.

Codex supervision and other optional plugin features stay outside this
inference activation transaction. Configure them only after inference is
working and Crestodian has started; existing plugin policy and explicit
supervision opt-outs remain untouched during inference setup.

## AI conversation

Interactive Crestodian's free-form conversation runs through the same agent loop as regular OpenClaw agents, restricted to one ring-zero OpenClaw authority tool, `crestodian`, that wraps the typed operations. Read actions run freely, mutations require your conversational approval for that exact operation (see Operations and approval), and every applied write is audited and re-validated. The agent session persists, so Crestodian has real multi-turn memory. If the verified inference route later stops working, return to `openclaw onboard` and repair it before continuing.

The host does not parse natural-language requests into operations. Free-form
messages — including command-looking text and questions such as "why did my
gateway stop?" — go to the AI, which can map the request to a typed operation
through the `crestodian` tool.

When a mutation is pending, only unambiguous approval or decline phrases from a
closed list are resolved without inference. Ambiguous consent goes to a
separate configured completion call and otherwise fails closed. Structured
wizard fields and exact host navigation are UI controls, not natural-language
operation parsing. One secret-hygiene exception is especially important: an
exact `config set` on a sensitive path (tokens, keys, passwords) never reaches
a model. The host creates a redacted proposal, and the value is masked in the
AI-visible history. Prefer `config set-ref <path> env <ENV_VAR>` for secrets.

Message-channel rescue mode never uses the model-assisted planner. Remote rescue stays deterministic so a broken or compromised normal agent path cannot be used as a config editor.

### CLI harness trust model

Embedded runtimes and the Codex app-server harness enforce the ring-zero
restriction directly: the run carries an OpenClaw tool allow-list with only
the `crestodian` tool. For Codex, OpenClaw also disables environments, native
execution, multi-agent, goal, app/plugin, skill/MCP, web-search, and
`request_user_input` surfaces for that run. Codex still injects its inert native `update_plan`
utility; it can update the model's temporary checklist but cannot write files
or OpenClaw configuration. CLI harnesses do not consume OpenClaw's allow-list,
so Crestodian admits only backends whose own tool-selection contract can prove
the same restriction:

- Selectable backends, including Claude Code, launch with an empty native-tool
  selection and one MCP tool, `crestodian`. Claude's generated MCP config is
  applied with `--strict-mcp-config`, so no other MCP servers are loaded.
- Backends that declare no native tools receive the same dedicated Crestodian
  MCP server.
- Always-on or unknown native-tool backends fail closed before inference; they
  cannot host a Crestodian session.

Only Crestodian sessions get the crestodian MCP server; normal agent runs
never see this tool. Selectable/no-native CLI backends and API-key models
therefore enforce the literal single-tool loop. Codex app-server models enforce
a single OpenClaw authority tool plus the inert native planning utility. In all
three cases, setup writes remain confined to Crestodian's audited approval
contract.

Gemini CLI remains available for normal agents, but it cannot enforce the
tool-free probe required by the inference gate, so it cannot host Crestodian.

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

This is a deterministic emergency command handler, not the conversational
Crestodian agent. It does not bootstrap a fresh setup or relax the inference
gate for Crestodian chat.

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
create agent work workspace ~/Projects/work model openai/gpt-5.6-sol
/crestodian create agent work workspace ~/Projects/work
```

Agent creation may name only the current live-verified default model. Omit the
model to inherit that route.

Remote rescue is an admin surface and must be treated like remote config repair, not normal chat.

Security contract for remote rescue:

- Disabled when sandboxing is active for the agent/session; Crestodian refuses remote rescue and points to local CLI repair.
- Default effective state is `auto`: allow remote rescue only in trusted YOLO operation, where the runtime already has unsandboxed local authority (`tools.exec.security` resolves to `full` and `tools.exec.ask` resolves to `off`, with sandbox mode `off`).
- Requires an explicit owner identity; no wildcard sender rules, open group policy, unauthenticated webhooks, or anonymous channels.
- Owner DMs only by default; group/channel rescue needs explicit opt-in.
- Plugin search and list are read-only. Plugin install is always local-only (blocked in rescue, even when otherwise enabled) because it downloads executable code. Plugin uninstall is refused in both local Crestodian and rescue; run `openclaw plugins uninstall <id>` from a terminal.
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

An opt-in live channel command-surface smoke checks `/crestodian status` plus a persistent approval roundtrip through the rescue handler:

```bash
pnpm test:live:crestodian-rescue-channel
```

Inference-gated packaged one-shot setup is covered by:

```bash
pnpm test:docker:crestodian-first-run
```

That packaged-CLI lane starts with an empty state dir and proves Crestodian
fails closed without inference. It then tests and activates fake Claude through
the packaged activation module. Only afterward does a fuzzy request reach the
planner and resolve to typed setup, followed by one-shot commands that create an
additional agent, configure Discord through a plugin enablement plus token
SecretRef, validate config, and check the audit log. This lane is supporting
gate/operation evidence; it does not exercise interactive onboarding or the
Crestodian agent/tool/approval conversation. The QA Lab scenario below redirects
to the same Docker lane:

```bash
pnpm openclaw qa suite --scenario crestodian-ring-zero-setup
```

## Related

- [CLI reference](/cli)
- [Doctor](/cli/doctor)
- [TUI](/cli/tui)
- [Sandbox](/cli/sandbox)
- [Security](/cli/security)
