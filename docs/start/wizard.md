---
summary: "CLI onboarding: verify inference, then hand remaining setup to OpenClaw"
read_when:
  - Running or configuring CLI onboarding
  - Setting up a new machine
title: "Onboarding (CLI)"
sidebarTitle: "Onboarding: CLI"
---

```bash
openclaw onboard
```

CLI onboarding is the recommended terminal setup path on macOS, Linux, and
Windows (native or WSL2). By default it detects AI access already available on
the machine, verifies it with a real completion, and starts OpenClaw to
configure the workspace, Gateway, and optional features. `openclaw setup` runs the same flow ([Setup](/cli/setup) covers
the `--baseline` config-only variant). Windows desktop users can also start
from [Windows Hub](/platforms/windows).

Guided onboarding establishes inference first. It detects available AI access,
requires a real completion, and only then starts [OpenClaw](/cli/openclaw)
to configure the rest of OpenClaw. Choosing **Skip for now** exits onboarding
without starting OpenClaw.

The classic wizard remains available for custom providers, remote Gateway
setup, channel pairing, daemon controls, skills, and imports. Run it explicitly
with `openclaw onboard --classic`; the guided inference picker does not delegate
into it. After inference passes, OpenClaw can use `open channel wizard for
<channel>` to hand channel setup that needs secrets to a masked terminal wizard.
To change the model provider or its authentication, exit OpenClaw and run
`openclaw onboard`; OpenClaw does not open guided or classic provider flows.

<Info>
Fastest first chat: finish guided setup, run `openclaw dashboard`, and chat in
the browser through the Control UI. Docs: [Dashboard](/web/dashboard).
</Info>

## Locale

The wizard localizes fixed onboarding copy. Resolve order: `OPENCLAW_LOCALE`,
`LC_ALL`, `LC_MESSAGES`, `LANG`, then English. Supported locales: `en`,
`zh-CN`, `zh-TW`.

```bash
OPENCLAW_LOCALE=zh-CN openclaw onboard
```

Product names, commands, config keys, URLs, provider IDs, model IDs, and
plugin/channel labels stay in English regardless of locale.

To reconfigure non-inference settings later:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` does not imply non-interactive mode. For scripts, use `--non-interactive` (see [CLI automation](/start/wizard-cli-automation)).
</Note>

<Tip>
The classic wizard includes a web search step where you can pick a provider: Brave,
DuckDuckGo, Exa, Firecrawl, Gemini, Grok, Kimi, MiniMax Search, Ollama Web
Search, Perplexity, SearXNG, or Tavily. Some need an API key; others are
key-free. Configure this later with `openclaw configure --section web`. Docs:
[Web tools](/tools/web).
</Tip>

## Guided default

Plain `openclaw onboard` follows this path:

1. Accept the security notice.
2. Detect configured models, API-key environment variables, supported local AI
   CLIs, and already installed tool-capable models from reachable Ollama or LM
   Studio servers on the Gateway host. This read-only pass never downloads a
   model. Gemini CLI and Antigravity installs are reported but not auto-tested
   because they cannot enforce a tool-free probe.
3. Test the first detected candidate with a real completion. On failure, show the
   reason and continue to the next usable candidate.
4. If detection is exhausted, choose OpenAI, Anthropic, xAI (Grok), Google, or
   OpenRouter, or choose **More…** for the remaining providers. Each provider's
   regions, plans, and supported browser, device, API-key, or token methods
   appear in a second menu and are tested with the same real completion.
   Choose **Skip for now** to exit without starting OpenClaw.
5. Persist only the verified model route and any credential/plugin state it
   requires. Workspace and Gateway settings remain untouched.
6. Start OpenClaw with the verified model so it can configure the workspace,
   Gateway, channels, agents, plugins, and the remaining optional setup.

Re-running the command on a configured installation tests the current default
model first, making the guided flow a verification and repair pass. A failing
check never replaces the configured model automatically; onboarding stops and
asks how to continue. Run `openclaw channels add` or `openclaw configure` for
later non-inference additions; use `openclaw onboard` for provider or auth route
changes.

## Classic wizard: QuickStart vs Advanced

Run `openclaw onboard --classic` to open the full wizard. It starts with a
choice between **QuickStart** (defaults) and **Advanced** (full control). Pass
`--flow quickstart` or `--flow advanced` (alias `manual`) to select the classic
flow and skip that prompt.

<Tabs>
  <Tab title="QuickStart (defaults)">
    - Local gateway, loopback bind
    - Workspace default (or existing workspace)
    - Gateway port **18789**
    - Gateway auth **Token** (auto-generated, even on loopback)
    - Tool policy: `tools.profile: "coding"` for new setups (an existing explicit profile is preserved)
    - DM isolation: `session.dmScope: "per-channel-peer"` for new setups. Details: [CLI setup reference](/start/wizard-cli-reference#outputs-and-internals)
    - Tailscale exposure **Off**
    - Telegram and WhatsApp DMs default to **allowlist**: Telegram asks for a numeric Telegram user ID, WhatsApp asks for a phone number

  </Tab>
  <Tab title="Advanced (full control)">
    - Exposes every step: mode, workspace, gateway, channels, daemon, skills

  </Tab>
</Tabs>

Remote mode (`--mode remote`) always uses the advanced flow; it only
configures this machine to connect to a Gateway elsewhere and never installs
or changes anything on the remote host.

## What classic onboarding configures

Local mode (default) walks through these steps:

1. **Model/Auth** - pick a provider auth flow (API key, OAuth, or
   provider-specific manual auth), including Custom Provider
   (OpenAI-compatible, OpenAI Responses-compatible, Anthropic-compatible, or
   Unknown auto-detect). Pick a default model.
   Fresh OpenAI API-key setup defaults to `openai/gpt-5.6` (the bare direct-API
   id resolves to Sol); fresh ChatGPT/Codex setup defaults to
   `openai/gpt-5.6-sol`. Re-running setup preserves an existing explicit model,
   including `openai/gpt-5.5`. Select `openai/gpt-5.5` explicitly if the
   account does not expose GPT-5.6.
   Security note: if this agent will run tools or process webhook/hook
   content, prefer the strongest latest-generation model available and keep
   tool policy strict - weaker or older tiers are easier to prompt-inject.
   For non-interactive runs, `--secret-input-mode ref` stores env-backed refs
   instead of plaintext API key values; the referenced env var must already
   be set, or onboarding fails fast. Interactive secret reference mode can
   point at an environment variable or a configured provider ref (`file` or
   `exec`), with a fast preflight check before saving. After model/auth setup,
   the wizard offers an optional live completion test; a failure can return to
   model/auth setup once or be ignored without blocking the rest of the
   classic wizard. Ignoring it does not unlock OpenClaw; conversational setup
   still requires a passing inference check.
2. **Workspace** - directory for agent files (default `~/.openclaw/workspace`). Seeds bootstrap files.
3. **Gateway** - port, bind address, auth mode, Tailscale exposure. In
   interactive token mode, choose plaintext token storage (default) or opt
   into a SecretRef. Non-interactive SecretRef path: `--gateway-token-ref-env <ENV_VAR>`.
4. **Channels** - built-in and official plugin chat channels, including
   Discord, Feishu, Google Chat, iMessage, Mattermost, Microsoft Teams,
   QQ Bot, Signal, Slack, Telegram, WhatsApp, and more.
5. **Daemon** - installs a LaunchAgent (macOS), a systemd user unit
   (Linux/WSL2), or a native Windows Scheduled Task with a per-user
   Startup-folder fallback.
   If token auth is required and `gateway.auth.token` is SecretRef-managed,
   daemon install validates it but does not persist a resolved token into
   supervisor service environment metadata; an unresolved SecretRef blocks
   install with guidance. If both `gateway.auth.token` and
   `gateway.auth.password` are set while `gateway.auth.mode` is unset, install
   is blocked until you set the mode explicitly.
6. **Health check** - starts the Gateway and verifies it is reachable.
7. **Skills** - installs recommended skills and their optional dependencies.

<Note>
Re-running onboarding does **not** wipe anything unless you explicitly choose
**Reset** (or pass `--reset`). CLI `--reset` defaults to config, credentials,
and sessions; use `--reset-scope full` to also remove the workspace. If the
config is invalid or contains legacy keys, onboarding asks you to run
`openclaw doctor` first.
</Note>

`--flow import` runs a detected migration flow (for example Hermes) in the
classic wizard instead of fresh setup; see [Migrate](/cli/migrate) and the migration guides under
[Install](/install/migrating-hermes). `openclaw onboard --modern` is a
compatibility alias for [OpenClaw](/cli/openclaw). It uses the same
inference gate as `openclaw setup`: verified inference starts the
assistant, while an interactive failure returns to guided inference setup.

## Add another agent

Use `openclaw agents add <name>` to create a separate agent with its own
workspace, sessions, and auth profiles. Running without `--workspace` starts
an interactive flow for name, workspace, auth, channels, and bindings - it is
not the full `openclaw onboard` wizard.

What it sets:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Notes:

- Default workspace: `~/.openclaw/workspace-<agentId>` (or under
  `agents.defaults.workspace` if that is set).
- Add `bindings` to route inbound messages to this agent (onboarding can do this for you).
- Non-interactive flags: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Full reference

For detailed step-by-step behavior and config outputs, see
[CLI setup reference](/start/wizard-cli-reference).
For non-interactive examples, see [CLI automation](/start/wizard-cli-automation).
For the full flag reference, see [`openclaw onboard`](/cli/onboard).

## Related docs

- CLI command reference: [`openclaw onboard`](/cli/onboard)
- Onboarding overview: [Onboarding overview](/start/onboarding-overview)
- macOS app onboarding: [Onboarding](/start/onboarding)
- Agent first-run ritual: [Agent Bootstrapping](/start/bootstrapping)
