---
summary: "CLI reference and security model for Crestodian, the configless-safe setup and repair helper"
read_when:
  - You run openclaw with no command and want to understand Crestodian
  - You need a configless-safe way to inspect or repair OpenClaw
  - You are designing or enabling message-channel rescue mode
title: "Crestodian"
---

# `openclaw crestodian`

Crestodian is OpenClaw's local setup, repair, and configuration helper. It is
designed to stay reachable when the normal agent path is broken.

Running `openclaw` with no command starts Crestodian in an interactive terminal.
Running `openclaw crestodian` starts the same helper explicitly.

## What Crestodian shows

On startup, Crestodian prints a compact system overview:

- config path and validity
- configured agents and the default agent
- default model
- local Codex and Claude Code CLI availability
- OpenAI and Anthropic API-key presence
- planner mode (`deterministic` or model-assisted through the configured model)
- local docs path or the public docs URL
- local source path for Git checkouts, otherwise the OpenClaw GitHub source URL
- gateway reachability
- the immediate recommended next step

It does not dump secrets or load plugin CLI commands just to start.

Crestodian uses the same OpenClaw reference discovery as regular agents. In a Git checkout,
it points itself at local `docs/` and the local source tree. In an npm package install, it
uses the bundled package docs and links to
[https://github.com/openclaw/openclaw](https://github.com/openclaw/openclaw), with explicit
guidance to review source whenever the docs are not enough.

## Examples

```bash
openclaw
openclaw crestodian
openclaw crestodian --json
openclaw crestodian --message "models"
openclaw crestodian --message "validate config"
openclaw crestodian --message "setup workspace ~/Projects/work model openai/gpt-5.5" --yes
openclaw crestodian --message "set default model openai/gpt-5.5" --yes
openclaw onboard --modern
```

Inside the interactive prompt:

```text
status
health
doctor
doctor fix
validate config
setup
setup workspace ~/Projects/work model openai/gpt-5.5
config set gateway.port 19001
config set-ref gateway.auth.token env OPENCLAW_GATEWAY_TOKEN
gateway status
restart gateway
agents
create agent work workspace ~/Projects/work
models
set default model openai/gpt-5.5
talk to work agent
talk to agent for ~/Projects/work
audit
quit
```

## Safe startup

Crestodian's startup path is deliberately small. It can run when:

- `openclaw.json` is missing
- `openclaw.json` is invalid
- the Gateway is down
- plugin command registration is unavailable
- no agent has been configured yet

`openclaw --help` and `openclaw --version` still use the normal fast paths.
Noninteractive `openclaw` exits with a short message instead of printing root
help, because the no-command product is Crestodian.

## Operations and approval

Crestodian uses typed operations instead of editing config ad hoc.

Read-only operations can run immediately:

- show overview
- list agents
- show model/backend status
- run status or health checks
- check Gateway reachability
- run doctor without interactive fixes
- validate config
- show the audit-log path

Persistent operations require conversational approval in interactive mode unless
you pass `--yes` for a one-shot command:

- write config
- run `config set`
- set supported SecretRef values through `config set-ref`
- run setup/onboarding bootstrap
- change the default model
- start, stop, or restart the Gateway
- create agents
- run doctor repairs that rewrite config or state

Applied writes are recorded in:

```text
~/.openclaw/audit/crestodian.jsonl
```

Discovery is not audited. Only applied operations and writes are logged.

`openclaw onboard --modern` starts Crestodian as the modern onboarding preview.
Plain `openclaw onboard` still runs classic onboarding.

## Setup Bootstrap

`setup` is the chat-first onboarding bootstrap. It writes only through typed
config operations and asks for approval first.

```text
setup
setup workspace ~/Projects/work
setup workspace ~/Projects/work model openai/gpt-5.5
```

When no model is configured, setup selects the first usable backend in this
order and tells you what it chose:

- existing explicit model, if already configured
- `OPENAI_API_KEY` -> `openai/gpt-5.5`
- `ANTHROPIC_API_KEY` -> `anthropic/claude-opus-4-7`
- Claude Code CLI -> `claude-cli/claude-opus-4-7`
- Codex CLI -> `codex-cli/gpt-5.5`

If none are available, setup still writes the default workspace and leaves the
model unset. Install or log into Codex/Claude Code, or expose
`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`, then run setup again.

## Model-Assisted Planner

Crestodian always starts in deterministic mode. Once a valid OpenClaw model is
configured, local Crestodian can make one bounded model call for fuzzy commands
that the deterministic parser does not understand.

The model-assisted planner cannot mutate config directly. It must translate the
request into one of Crestodian's typed commands, then the normal approval and
audit rules apply. Crestodian prints the model it used and the interpreted
command before it runs anything.

Message-channel rescue mode does not use the model-assisted planner. Remote
rescue stays deterministic so a broken or compromised normal agent path cannot
be used as a config editor.

## Switching to an agent

Use a natural-language selector to leave Crestodian and open the normal TUI:

```text
talk to agent
talk to work agent
switch to main agent
```

`openclaw tui`, `openclaw chat`, and `openclaw terminal` still open the normal
agent TUI directly. They do not start Crestodian.

After switching into the normal TUI, use `/crestodian` to return to Crestodian.
You can include a follow-up request:

```text
/crestodian
/crestodian restart gateway
```

Agent switches inside the TUI leave a breadcrumb that `/crestodian` is available.

## Message rescue mode

Message rescue mode is the message-channel entrypoint for Crestodian. It is for
the case where your normal agent is dead, but a trusted channel such as WhatsApp
still receives commands.

Supported text command:

- `/crestodian <request>`

Operator flow:

```text
You, in a trusted owner DM: /crestodian status
OpenClaw: Crestodian rescue mode. Gateway reachable: no. Config valid: no.
You: /crestodian restart gateway
OpenClaw: Plan: restart the Gateway. Reply /crestodian yes to apply.
You: /crestodian yes
OpenClaw: Applied. Audit entry written.
```

Agent creation can also be queued from the local prompt or rescue mode:

```text
create agent work workspace ~/Projects/work model openai/gpt-5.5
/crestodian create agent work workspace ~/Projects/work
```

Remote rescue mode is an admin surface. It must be treated like remote config
repair, not like normal chat.

Security contract for remote rescue:

- Disabled when sandboxing is active. If an agent/session is sandboxed,
  Crestodian must refuse remote rescue and explain that local CLI repair is
  required.
- Default effective state is `auto`: allow remote rescue only in trusted YOLO
  operation, where the runtime already has unsandboxed local authority.
- Require an explicit owner identity. Rescue must not accept wildcard sender
  rules, open group policy, unauthenticated webhooks, or anonymous channels.
- Owner DMs only by default. Group/channel rescue requires explicit opt-in and
  should still route approval prompts to the owner DM.
- Remote rescue cannot open the local TUI or switch into an interactive agent
  session. Use local `openclaw` for agent handoff.
- Persistent writes still require approval, even in rescue mode.
- Audit every applied rescue operation, including channel, account, sender,
  session key, operation, config hash before, and config hash after.
- Never echo secrets. SecretRef inspection should report availability, not
  values.
- If the Gateway is alive, prefer Gateway typed operations. If the Gateway is
  dead, use only the minimal local repair surface that does not depend on the
  normal agent loop.

Config shape:

```jsonc
{
  "crestodian": {
    "rescue": {
      "enabled": "auto",
      "ownerDmOnly": true,
    },
  },
}
```

`enabled` should accept:

- `"auto"`: default. Allow only when the effective runtime is YOLO and
  sandboxing is off.
- `false`: never allow message-channel rescue.
- `true`: explicitly allow rescue when the owner/channel checks pass. This
  still must not bypass the sandboxing denial.

The default `"auto"` YOLO posture is:

- sandbox mode resolves to `off`
- `tools.exec.security` resolves to `full`
- `tools.exec.ask` resolves to `off`

Remote rescue is covered by the Docker lane:

```bash
pnpm test:docker:crestodian-rescue
```

Fresh configless setup through Crestodian is covered by:

```bash
pnpm test:docker:crestodian-first-run
```

## Related

- [CLI reference](/cli)
- [Doctor](/cli/doctor)
- [TUI](/cli/tui)
- [Sandbox](/cli/sandbox)
- [Security](/cli/security)
