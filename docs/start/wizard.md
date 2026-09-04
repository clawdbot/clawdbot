---
summary: "CLI onboarding: quick start with detected AI access or choose custom setup"
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
Windows (native or WSL2). On a fresh install, **Quick start** detects AI access
already available on the machine, verifies it with a real completion, and opens
the web dashboard with a foreground Gateway. **Custom setup** preserves the full
guided flow. `openclaw setup` runs the same flow ([Setup](/cli/setup) covers
the `--baseline` config-only variant). Windows desktop users can also start
from [Windows Hub](/platforms/windows).

Guided onboarding establishes inference first: a real completion must succeed
before workspace and Gateway setup continues. If no detected route works, it
opens manual provider setup. Choosing **Skip for now** exits onboarding without
starting OpenClaw.

The classic wizard remains available for remote Gateway setup, channel pairing,
daemon controls, skills, and imports. Run it explicitly
with `openclaw onboard --classic`; the guided inference picker does not delegate
into it. After inference passes, OpenClaw can use `open channel wizard for
<channel>` to hand channel setup that needs secrets to a masked terminal wizard.
Workspace skills and web search are configured the same conversational way:
`configure skills` and `configure web search` host those setup flows in the
chat, and `open search wizard` hands credential entry to the masked terminal
wizard.
For a local Gateway, `configure gateway` guides port, bind, auth, and Tailscale
settings but saves config without restarting; say `restart gateway` afterward,
or use `open gateway wizard` for masked terminal credential entry and then run
`openclaw gateway restart`. Remote Gateway mode remains an onboarding or
`openclaw configure` choice rather than a hosted chat wizard.

After onboarding has created the default agent workspace, `import memory` can
copy detected local memory into it. This conversational import does not change
config or import credentials or skills, needs no Gateway restart, and reports
per-source partial or failed copies honestly.
To change the model provider or its authentication, exit OpenClaw and run
`openclaw onboard`; OpenClaw does not open guided or classic provider flows.

<Info>
On a fresh install, run `npx openclaw@latest` and choose **Quick start** for the
browser dashboard. Reopen it later with `openclaw dashboard`.
Docs: [Dashboard](/web/dashboard).
</Info>

## Locale

The wizard localizes fixed onboarding copy. It uses the first nonblank value from
`OPENCLAW_LOCALE`, `LC_ALL`, `LC_MESSAGES`, and `LANG`, in that order, then
falls back to English. Supported locales: `en`, `zh-CN`, `zh-TW`.

```bash
OPENCLAW_LOCALE=zh-CN openclaw onboard
OPENCLAW_LOCALE=en openclaw onboard # Explicit English override
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
key-free. Configure this later with `openclaw configure --section web`, or say
`configure web search` in the OpenClaw chat to run the same provider setup
conversationally. Docs: [Web tools](/tools/web).
</Tip>

## Guided default

Fresh local interactive onboarding offers **Quick start** and **Custom setup**
after a one-line pointer to the [security guide](/gateway/security). Quick start
records the security acknowledgment; Custom setup shows the full security note
and asks for confirmation. Quick start uses the default agent name `main` and
full access, leaves telemetry consent unset, and skips route confirmation,
memory import, and app recommendations. Custom setup keeps the telemetry choice,
agent name, access mode, route confirmation, and optional setup prompts.

Quick start follows this path:

1. Choose **Quick start** after the one-line security pointer.
2. Detect configured models, API-key environment variables, supported local AI
   CLIs, and already installed tool-capable models from reachable Ollama or LM
   Studio servers on the Gateway host. This read-only pass never downloads a
   model. Pi and OpenCode installs may also be reported for context when they
   cannot serve as the reusable inference route. Gemini CLI and Antigravity are
   not offered as detected setup routes.
3. Test detected candidates with real completions until one works, then announce
   the selected route. Earlier failures are summarized quietly.
4. If detection is exhausted, choose OpenAI, Anthropic, xAI (Grok), Google, or
   OpenRouter, or choose **More…** for the remaining providers. Each provider's
   regions, plans, and supported browser, device, API-key, or token methods
   appear in a second menu and are tested with the same real completion.
   For an unlisted endpoint, choose **Custom Provider** (under **More…** when shown) and enter
   its base URL, optional API key, compatibility, and model ID. Custom setup
   runs in the local CLI on the Gateway host and verifies a real reply before
   saving the provider or replacing the active model.
   Choose **Skip for now** to exit without starting OpenClaw. Manual provider
   setup continues through the remaining guided steps, including Gateway service
   installation and optional setup. The quick-start defaults stay: agent name
   `main`, full access, and telemetry consent unset.
5. Save the verified route, prepare the agent workspace, and persist Gateway
   settings.
6. Start the Gateway in the foreground and open the browser dashboard. Press
   **Ctrl+C** to stop it; config persists. Use `openclaw gateway install` later
   for background operation, `openclaw` for the TUI, or `openclaw dashboard` to
   reopen the web UI.

The quick-start choice is not offered for configured installs, remote Gateway
chat setup, non-interactive runs, or runs with `--skip-ui` or `--tui`.

Re-running the command on a configured installation tests the current default
model first, making the guided flow a verification and repair pass. A failing
check never replaces the configured model automatically; onboarding stops and
asks how to continue. Run `openclaw channels add` or `openclaw configure` for
later non-inference additions; use `openclaw onboard` for provider or auth route
changes.

## Classic wizard setup modes

Run `openclaw onboard --classic` to open the full wizard. Its **Setup mode**
menu is built from the current installation:

- With no configured default model, **QuickStart (recommended)** is selected by
  default, followed by **Manual setup**.
- With a configured default model, **Keep existing model config** appears first
  and is selected by default, followed by **QuickStart (recommended)** and
  **Manual setup**.
- When a migration provider is available, **Import from another agent** appears
  after the setup choices. Selecting it opens provider-specific entries such as
  **Import from Claude**, **Import from Codex**, and **Import from Hermes**.
  Detected sources appear first with their paths; other available providers ask
  for a source path. Use Back from the provider list to return to **Setup mode**
  before an import begins.

Pass `--flow quickstart` or `--flow manual` (alias `advanced`) to select a
classic setup flow and skip that prompt. Import flags select the import flow
directly instead of showing a menu that could discard the requested import.

<Tabs>
  <Tab title="QuickStart (defaults)">
    - Local gateway, loopback bind
    - Workspace default (or existing workspace)
    - Gateway port **18789**
    - Gateway auth **Token** (auto-generated, even on loopback)
    - Tool policy: `tools.profile: "coding"` for new setups (an existing explicit profile is preserved)
    - DM sessions: onboarding preserves an explicit `session.dmScope` and otherwise leaves it unset, so the `"main"` default keeps all direct messages across channels in the agent's rolling main session—the personal-agent default. For shared or multi-user inboxes, use `"per-channel-peer"`; `openclaw security audit` recommends isolation when it detects multi-user DM traffic. Details: [CLI setup reference](/start/wizard-cli-reference#outputs-and-internals)
    - Tailscale exposure **Off**
    - Telegram and WhatsApp DMs default to **allowlist**: Telegram asks for a numeric Telegram user ID, WhatsApp asks for a phone number

  </Tab>
  <Tab title="Manual setup (full control)">
    - Exposes every step: mode, workspace, gateway, channels, daemon, skills

  </Tab>
</Tabs>

Remote mode (`--mode remote`) always uses the manual flow; it only
configures this machine to connect to a Gateway elsewhere and never installs
or changes anything on the remote host.

## What classic onboarding configures

Local mode (default) walks through these steps:

1. **Workspace** - directory for agent files (default `~/.openclaw/workspace`). Seeds bootstrap files.
2. **Model/Auth** - pick a provider auth flow (API key, OAuth, or
   provider-specific manual auth), including Custom Provider
   (OpenAI-compatible, OpenAI Responses-compatible, Anthropic-compatible, or
   Unknown auto-detect). Pick a default model.
   Fresh OpenAI API-key and ChatGPT/Codex setup default to
   `openai/gpt-5.6-sol`. The bare direct-API `openai/gpt-5.6` alias remains
   supported and resolves to Sol. Re-running setup preserves an existing
   explicit model, including `openai/gpt-5.5`. Select `openai/gpt-5.5` explicitly if the
   account does not expose GPT-5.6.
   Security note: if this agent will run tools or process webhook/hook
   content, prefer the strongest latest-generation model available and keep
   tool policy strict - weaker or older tiers are easier to prompt-inject.
   For non-interactive runs, `--secret-input-mode ref` stores new credentials
   as env-backed refs; set the provider env var when adding a credential.
   Existing resolvable named profiles and their `env`, `file`, `exec`, or `store` refs
   are reused unchanged without a new credential write or additional provider
   env var. Previously stored plaintext is not migrated; see
   [Secrets management](/gateway/secrets). Interactive secret reference mode can
   point at an environment variable or a configured provider ref (`file` or
   `exec`), with a fast preflight check before saving. After model/auth setup,
   the wizard offers an optional live completion test; a failure can return to
   model/auth setup once or be ignored without blocking the rest of the
   classic wizard. Ignoring it does not unlock OpenClaw; conversational setup
   still requires a passing inference check.
3. **Gateway** - port, bind address, auth mode, Tailscale exposure. In
   interactive token mode, choose plaintext token storage (default) or opt
   into a SecretRef. Non-interactive SecretRef path: `--gateway-token-ref-env <ENV_VAR>`.
4. **Channels** - built-in and official plugin chat channels, including
   Discord, Feishu, Google Chat, iMessage, Mattermost, Microsoft Teams,
   QQ Bot, Signal, Slack, Telegram, WhatsApp, and more.
5. **Web search** - configures an optional search provider.
6. **Skills** - installs recommended skills and their optional dependencies.
7. **Daemon** - installs a LaunchAgent (macOS), a systemd user unit
   (Linux/WSL2), or a native Windows Scheduled Task with a per-user
   Startup-folder fallback.
   If token auth is required and `gateway.auth.token` is SecretRef-managed,
   daemon install validates it but does not persist a resolved token into
   supervisor service environment metadata; an unresolved SecretRef blocks
   install with guidance. If both `gateway.auth.token` and
   `gateway.auth.password` are set while `gateway.auth.mode` is unset, install
   is blocked until you set the mode explicitly.
8. **Health check** - starts the Gateway and verifies it is reachable.

<Note>
Re-running onboarding does **not** wipe anything unless you pass `--reset`.
Reset is a command flag, not a **Setup mode** menu choice. It defaults to
config, credentials, and sessions; use `--reset-scope full` to also remove the
workspace. The command validates TTY availability and rejectable CLI options
before moving state to Trash; non-interactive setup also requires
`--accept-risk` first. Interactive classic setup performs reset before showing
its risk acknowledgement, and declining that prompt does not undo the reset.
Migration import options (`--flow import`, `--import-from`, `--import-source`,
and `--import-secrets`) cannot be combined with `--reset`; run the import
without `--reset`.
Without `--reset`, an invalid config or legacy keys make onboarding ask you to
run `openclaw doctor` first.
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

- `agents.entries.*.name`
- `agents.entries.*.workspace`
- `agents.entries.*.agentDir`

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
