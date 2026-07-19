---
summary: "CLI reference and security model for the inference-backed OpenClaw setup and repair helper"
read_when:
  - You finished inference setup and want OpenClaw to configure the rest
  - You need to inspect or repair OpenClaw with the local setup agent
  - You are designing or enabling message-channel rescue mode
title: "OpenClaw setup agent"
---

# `openclaw setup`

OpenClaw ships with a built-in system agent — it speaks as "OpenClaw" — for
local setup, repair, and configuration (formerly called Crestodian). It starts only after the effective default model completes a real turn.
Fresh installs establish inference first; malformed config stays on the
classic doctor path.

## When it starts

Running `openclaw` with no subcommand routes based on config state:

- Config missing, or exists with no authored settings (empty, or only `$schema`/`meta` keys): starts guided onboarding with live AI verification.
- Config exists but fails validation: starts classic onboarding, which reports the issues and directs you to `openclaw doctor`.
- Config exists and is valid: opens the normal agent TUI. A reachable
  configured Gateway whose default agent has a model goes directly to that UI
  without onboarding or OpenClaw. Use `/openclaw` inside the TUI, or run
  `openclaw setup` directly, to reach OpenClaw later.

Running `openclaw setup` first live-tests the configured default model. A passing turn starts OpenClaw. An interactive failure opens guided inference setup and hands off to OpenClaw after a candidate passes. One-shot, JSON, and other noninteractive requests fail with instructions to run `openclaw onboard` when inference is unavailable. `openclaw --help` and `openclaw --version` keep their normal fast paths.

Noninteractive bare `openclaw` (no TTY) exits with a short message instead of printing root help: it points to non-interactive onboarding on a fresh or invalid install, or to `openclaw agent --local ...` when config is valid.

`openclaw onboard --modern` remains a compatibility alias for OpenClaw, but uses the same inference gate: working inference opens the chat, interactive failures start guided inference setup, and noninteractive failures exit with onboarding guidance. `openclaw onboard --classic` opens the full step-by-step wizard.

## What OpenClaw shows

Interactive OpenClaw opens the same TUI shell as `openclaw tui`, with an OpenClaw chat backend. The startup greeting covers:

- config validity and the default agent
- the verified model OpenClaw is using
- Gateway reachability from the first startup probe
- the next recommended debug action

It does not dump secrets or load plugin CLI commands just to start.

Use `status` for the detailed inventory: config path, docs/source paths, local CLI probes, key/token presence, agents, model, and Gateway details.

OpenClaw uses the same reference discovery as regular agents: in a Git checkout it points at local `docs/` and the source tree; in an npm install it uses bundled docs and links to [https://github.com/openclaw/openclaw](https://github.com/openclaw/openclaw), with guidance to check source when docs are not enough.

## Examples

```bash
openclaw
openclaw setup
openclaw setup --json
openclaw setup --message "models"
openclaw setup --message "validate config"
openclaw setup --message "setup workspace ~/Projects/work" --yes
openclaw setup --message "set default model openai/gpt-5.6" --yes
openclaw onboard --modern
```

Inside the OpenClaw TUI:

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

OpenClaw uses typed operations instead of editing config ad hoc.

Read-only operations run immediately: show overview, list agents, list installed plugins, search ClawHub plugins, show model/backend status, run status/health checks, check Gateway reachability, run doctor without interactive fixes, validate config, show the audit-log path.

Starting guided channel setup (`connect telegram`) also runs immediately. Its wizard collects explicit answers and owns the resulting writes.

Persistent operations require conversational approval (or `--yes` for a direct command): write config, `config set`, `config set-ref`, setup/onboarding bootstrap, change the default model, start/stop/restart the Gateway, create agents, and install plugins.

Doctor repairs are unavailable inside OpenClaw because they can rewrite the provider, authentication, or default-agent inference route powering the session. Exit OpenClaw and run `openclaw doctor --fix` in a terminal. Read-only `doctor` remains available inside OpenClaw.

New agents inherit the live-verified default inference route. The agent ids `openclaw` and `crestodian` are reserved for the system agent and cannot be created as normal agents. The retired id remains blocked so an old config cannot claim it.

`config set` and `config set-ref` can change any setting a user can change,
with a short human-only denylist: `$include`, `auth.*`, `env.*`, `models.*`,
and `secrets.*` stay refused because they carry credential material,
alternate-config inclusion, or the provider/catalog definitions that feed
inference routing. Inference routing itself is also protected: default model
routes (`agents.defaults` model/params/runtime fields) and the routing fields
of whichever agent backs the active default route are refused, as are agent
identity/topology fields (`id`, `agentDir`, `default`). Routing fields for
other agents remain writable behind approval. Gateway and channel auth remain
normal config surfaces. Use `set default model <provider/model>` for an
already configured route; it live-tests the route before saving it. To
configure or repair provider/auth access, exit OpenClaw and run
`openclaw onboard`.

`plugins.entries.<id>.*` writes (enable/disable/config of installed plugins)
are allowed unless that plugin backs the active inference route. Plugin
install sources and load policy keep their trust boundary in the typed
plugin-install workflow. Plugin uninstall of the route-backing plugin is
refused for the same reason; exit OpenClaw and run
`openclaw plugins uninstall <id>` from a terminal.

Approval is given in your own words: unambiguous replies ("yes", "sure", "go ahead", "not now") resolve from a closed deterministic list. When the configured route supports a separate completion call, other replies can be classified from only your message and the pending proposal — never by the conversation model itself, which cannot self-approve. Unclassified or ambiguous replies keep the proposal pending and the conversation asks again.

Applied writes are recorded in `~/.openclaw/audit/system-agent.jsonl`. Discovery is not audited; only applied operations and writes are.

Channel setup can run as a hosted conversation until it reaches a secret. The
local OpenClaw TUI does not accept sensitive wizard answers because terminal
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

OpenClaw never changes provider/auth access from inside its own session: the
session already depends on that inference route. For model-provider setup or
repair, `configure model provider` returns exit/onboarding guidance without
starting a wizard or writing config. Exit OpenClaw and run `openclaw
onboard`; onboarding stages the credentials and saves only a route that
completes a real live turn. Start OpenClaw again after onboarding succeeds.

## Setup bootstrap

`setup` configures the remaining workspace and Gateway state after guided onboarding has already established inference. It writes only through typed config operations and asks for approval first.

```text
setup
setup workspace ~/Projects/work
```

`setup` preserves the verified effective model. It does not configure or
replace inference.

If inference is missing or its live check fails, leave OpenClaw and run `openclaw onboard`. Guided onboarding detects configured models, API keys, and authenticated local CLIs, asks each candidate for a real reply, and persists only a passing route. OpenClaw starts immediately after that boundary and can then configure the workspace, Gateway, channels, agents, plugins, and other optional features.

The macOS app skips this ladder entirely when it reaches a configured Gateway
whose default agent already has a configured model; it opens the normal agent
UI.
For a fresh or incomplete Gateway, the app drives the inference ladder through
the `openclaw.setup.detect` and `openclaw.setup.activate` Gateway methods:
detect lists every candidate backend it finds, activate live-tests one
candidate (a real "reply with OK" completion), and only persists the model,
credential, and provider/runtime state needed for that route after the test passes. Workspace and Gateway defaults remain for OpenClaw. A failing candidate
never changes config; the app automatically walks down the ladder and finally
offers a manual key/token step populated from the Gateway's active
text-inference provider plugins. The selected provider owns its starter model
and config, and the credential is verified the same way before it is saved.

Codex supervision and other optional plugin features stay outside this
inference activation transaction. Configure them only after inference is
working and OpenClaw has started; existing plugin policy and explicit
supervision opt-outs remain untouched during inference setup.

## AI conversation

Interactive OpenClaw's free-form conversation runs through the same agent loop as regular OpenClaw agents, restricted to one ring-zero OpenClaw authority tool, `openclaw`, that wraps the typed operations. Read actions run freely, mutations require your conversational approval for that exact operation (see Operations and approval), and every applied write is audited and re-validated. The agent session persists, so OpenClaw has real multi-turn memory. If the verified inference route later stops working, return to `openclaw onboard` and repair it before continuing.

The host does not parse natural-language requests into operations. Free-form
messages — including command-looking text and questions such as "why did my
gateway stop?" — go to the AI, which can map the request to a typed operation
through the `openclaw` tool.

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
the `openclaw` tool. For Codex, OpenClaw also disables environments, native
execution, multi-agent, goal, app/plugin, skill/MCP, web-search, and
`request_user_input` surfaces for that run. Codex still injects its inert native `update_plan`
utility; it can update the model's temporary checklist but cannot write files
or OpenClaw configuration. CLI harnesses do not consume OpenClaw's allow-list,
so OpenClaw admits only backends whose own tool-selection contract can prove
the same restriction:

- Selectable backends, including Claude Code, launch with an empty native-tool
  selection and one MCP tool, `openclaw`. Claude's generated MCP config is
  applied with `--strict-mcp-config`, so no other MCP servers are loaded.
- Backends that declare no native tools receive the same dedicated OpenClaw
  MCP server.
- Always-on or unknown native-tool backends fail closed before inference; they
  cannot host an OpenClaw session.

Only OpenClaw sessions get the openclaw MCP server; normal agent runs
never see this tool. Selectable/no-native CLI backends and API-key models
therefore enforce the literal single-tool loop. Codex app-server models enforce
a single OpenClaw authority tool plus the inert native planning utility. In all
three cases, setup writes remain confined to OpenClaw's audited approval
contract.

Gemini CLI remains available for normal agents, but it cannot enforce the
tool-free probe required by the inference gate, so it cannot host OpenClaw.

## Switching to an agent

Use a natural-language selector to leave OpenClaw and open the normal TUI:

```text
talk to agent
talk to work agent
switch to main agent
```

`openclaw tui`, `openclaw chat`, and `openclaw terminal` open the normal agent TUI directly; they do not start OpenClaw. After switching into the normal TUI, `/openclaw` returns to OpenClaw, optionally with a follow-up request:

```text
/openclaw
/openclaw restart gateway
```

## Message rescue mode

Message rescue mode is the message-channel entrypoint for OpenClaw: use it when your normal agent is dead but a trusted channel (for example WhatsApp) still receives commands.

This is a deterministic emergency command handler, not the conversational
OpenClaw agent. It does not bootstrap a fresh setup or relax the inference
gate for OpenClaw chat.

Supported command: `/openclaw <request>`. Rescue accepts the exact typed command grammar only — natural language is rejected with a hint, never guessed into an operation, and no model is ever consulted.

```text
You, in a trusted owner DM: /openclaw status
OpenClaw: OpenClaw rescue mode. Gateway reachable: no. Config valid: no.
You: /openclaw restart gateway
OpenClaw: Plan: restart the Gateway. Reply /openclaw yes to apply.
You: /openclaw yes
OpenClaw: Applied. Audit entry written.
```

Agent creation can also be queued locally or via rescue:

```text
create agent work workspace ~/Projects/work model openai/gpt-5.6-sol
/openclaw create agent work workspace ~/Projects/work
```

Agent creation may name only the current live-verified default model. Omit the
model to inherit that route.

Remote rescue is an admin surface and must be treated like remote config repair, not normal chat.

Security contract for remote rescue:

- Disabled when sandboxing is active for the agent/session; OpenClaw refuses remote rescue and points to local CLI repair.
- Default effective state is `auto`: allow remote rescue only in trusted YOLO operation, where the runtime already has unsandboxed local authority (`tools.exec.security` resolves to `full` and `tools.exec.ask` resolves to `off`, with sandbox mode `off`).
- Requires an explicit owner identity; no wildcard sender rules, open group policy, unauthenticated webhooks, or anonymous channels.
- Owner DMs only by default; group/channel rescue needs explicit opt-in.
- Plugin search and list are read-only. Plugin install is always local-only (blocked in rescue, even when otherwise enabled) because it downloads executable code. Plugin uninstall is refused in both local OpenClaw and rescue; run `openclaw plugins uninstall <id>` from a terminal.
- Remote rescue cannot open the local TUI or switch into an interactive agent session; use local `openclaw` for agent handoff.
- Persistent writes still require approval, even in rescue mode.
- Pending approvals are one-use. Any newer rescue command for the same account, channel, and sender revokes the older plan; failed execution also consumes approval, so resend the command to retry.
- Every applied rescue operation is audited. Message-channel rescue records channel, account, sender, and source-address metadata; config-mutating operations also record config hashes before and after.
- Secrets are never echoed. SecretRef inspection reports availability, not values.
- If the Gateway is alive, rescue prefers Gateway typed operations; if it is dead, rescue uses only the minimal local repair surface that does not depend on the normal agent loop.

Config shape:

```jsonc
{
  "systemAgent": {
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
- `pendingTtlMinutes`: how long a pending rescue write stays open for `/openclaw yes` approval before expiring. Default `15`.

`openclaw doctor --fix` migrates the legacy `crestodian` config block to
`systemAgent`. Runtime reads only the canonical block.

Remote rescue is covered by the Docker lane:

```bash
pnpm test:docker:system-agent-rescue
```

An opt-in live channel command-surface smoke checks `/openclaw status` plus a persistent approval roundtrip through the rescue handler:

```bash
pnpm test:live:system-agent-rescue-channel
```

Inference-gated packaged one-shot setup is covered by:

```bash
pnpm test:docker:system-agent-first-run
```

That packaged-CLI lane starts with an empty state dir and proves OpenClaw
fails closed without inference. It then tests and activates fake Claude through
the packaged activation module. Only afterward does a fuzzy request reach the
planner and resolve to typed setup, followed by one-shot commands that create an
additional agent, configure Discord through a plugin enablement plus token
SecretRef, validate config, and check the audit log. This lane is supporting
gate/operation evidence; it does not exercise interactive onboarding or the
OpenClaw agent/tool/approval conversation. The QA Lab scenario below redirects
to the same Docker lane:

```bash
pnpm openclaw qa suite --scenario system-agent-ring-zero-setup
```

## Related

- [CLI reference](/cli)
- [Doctor](/cli/doctor)
- [TUI](/cli/tui)
- [Sandbox](/cli/sandbox)
- [Security](/cli/security)
