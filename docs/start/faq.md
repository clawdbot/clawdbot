---
summary: "Frequently asked questions about Clawdbot setup, configuration, and usage"
---
# FAQ

Quick answers plus deeper troubleshooting for real-world setups (local dev, VPS, multi-agent, OAuth/API keys, model failover). For runtime diagnostics, see [Troubleshooting](/gateway/troubleshooting). For the full config reference, see [Configuration](/gateway/configuration).

## Table of contents

- [What is Clawdbot?](#what-is-clawdbot)
  - [What is Clawdbot, in one paragraph?](#what-is-clawdbot-in-one-paragraph)
- [Quick start and first-run setup](#quick-start-and-first-run-setup)
  - [What’s the recommended way to install and set up Clawdbot?](#whats-the-recommended-way-to-install-and-set-up-clawdbot)
  - [How do I open the dashboard after onboarding?](#how-do-i-open-the-dashboard-after-onboarding)
  - [How do I authenticate the dashboard (token) on localhost vs remote?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [What runtime do I need?](#what-runtime-do-i-need)
  - [What does the onboarding wizard actually do?](#what-does-the-onboarding-wizard-actually-do)
  - [How does Anthropic "setup-token" auth work?](#how-does-anthropic-setup-token-auth-work)
  - [Where do I find an Anthropic setup-token?](#where-do-i-find-an-anthropic-setup-token)
  - [Do you support Claude subscription auth (Claude Code OAuth)?](#do-you-support-claude-subscription-auth-claude-code-oauth)
  - [Is AWS Bedrock supported?](#is-aws-bedrock-supported)
  - [How does Codex auth work?](#how-does-codex-auth-work)
  - [Is a local model OK for casual chats?](#is-a-local-model-ok-for-casual-chats)
  - [How do I keep hosted model traffic in a specific region?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [Can I use Bun?](#can-i-use-bun)
  - [Telegram: what goes in `allowFrom`?](#telegram-what-goes-in-allowfrom)
  - [Can multiple people use one WhatsApp number with different Clawdbots?](#can-multiple-people-use-one-whatsapp-number-with-different-clawdbots)
  - [Can I run a "fast chat" agent and an "Opus for coding" agent?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Does Homebrew work on Linux?](#does-homebrew-work-on-linux)
  - [Can I switch between npm and git installs later?](#can-i-switch-between-npm-and-git-installs-later)
  - [Should I run the Gateway on my laptop or a VPS?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
- [Skills and automation](#skills-and-automation)
  - [How do I customize skills without keeping the repo dirty?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [Can I load skills from a custom folder?](#can-i-load-skills-from-a-custom-folder)
  - [How can I use different models for different tasks?](#how-can-i-use-different-models-for-different-tasks)
  - [How do I install skills on Linux?](#how-do-i-install-skills-on-linux)
  - [Can I run Apple/macOS-only skills from Linux?](#can-i-run-applemacos-only-skills-from-linux)
  - [Do you have a Notion or HeyGen integration?](#do-you-have-a-notion-or-heygen-integration)
  - [How do I install the Chrome extension for browser takeover?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Sandboxing and memory](#sandboxing-and-memory)
  - [Is there a dedicated sandboxing doc?](#is-there-a-dedicated-sandboxing-doc)
  - [How do I bind a host folder into the sandbox?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [How does memory work?](#how-does-memory-work)
  - [Does semantic memory search require an OpenAI API key?](#does-semantic-memory-search-require-an-openai-api-key)
- [Where things live on disk](#where-things-live-on-disk)
  - [Where does Clawdbot store its data?](#where-does-clawdbot-store-its-data)
  - [Where should AGENTS.md / SOUL.md / USER.md / MEMORY.md live?](#where-should-agentsmd--soulmd--usermd--memorymd-live)
  - [How do I completely uninstall Clawdbot?](#how-do-i-completely-uninstall-clawdbot)
  - [Can agents work outside the workspace?](#can-agents-work-outside-the-workspace)
  - [I’m in remote mode — where is the session store?](#im-in-remote-mode-where-is-the-session-store)
- [Config basics](#config-basics)
  - [What format is the config? Where is it?](#what-format-is-the-config-where-is-it)
  - [I set `gateway.bind: "lan"` (or `"tailnet"`) and now nothing listens / the UI says unauthorized](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [Why do I need a token on localhost now?](#why-do-i-need-a-token-on-localhost-now)
  - [Do I have to restart after changing config?](#do-i-have-to-restart-after-changing-config)
  - [How do I enable web search (and web fetch)?](#how-do-i-enable-web-search-and-web-fetch)
  - [How do I run a central Gateway with specialized workers across devices?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [Can the Clawdbot browser run headless?](#can-the-clawdbot-browser-run-headless)
  - [How do I use Brave for browser control?](#how-do-i-use-brave-for-browser-control)
- [Remote gateways + nodes](#remote-gateways-nodes)
  - [How do commands propagate between Telegram, the gateway, and nodes?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [Do nodes run a gateway service?](#do-nodes-run-a-gateway-service)
  - [Is there an API / RPC way to apply config?](#is-there-an-api-rpc-way-to-apply-config)
  - [What’s a minimal “sane” config for a first install?](#whats-a-minimal-sane-config-for-a-first-install)
  - [How do I set up Tailscale on a VPS and connect from my Mac?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [How do I connect a Mac node to a remote Gateway (Tailscale Serve)?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
- [Env vars and .env loading](#env-vars-and-env-loading)
  - [How does Clawdbot load environment variables?](#how-does-clawdbot-load-environment-variables)
  - [“I started the Gateway via the service and my env vars disappeared.” What now?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [I set `COPILOT_GITHUB_TOKEN`, but models status shows “Shell env: off.” Why?](#i-set-copilot_github_token-but-models-status-shows-shell-env-off-why)
- [Sessions & multiple chats](#sessions-multiple-chats)
  - [How do I start a fresh conversation?](#how-do-i-start-a-fresh-conversation)
  - [Do sessions reset automatically if I never send `/new`?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [How do I completely reset Clawdbot but keep it installed?](#how-do-i-completely-reset-clawdbot-but-keep-it-installed)
  - [I’m getting “context too large” errors — how do I reset or compact?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [Why am I seeing “LLM request rejected: messages.N.content.X.tool_use.input: Field required”?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtool_useinput-field-required)
  - [Why am I getting heartbeat messages every 30 minutes?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [Do I need to add a “bot account” to a WhatsApp group?](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [Why doesn’t Clawdbot reply in a group?](#why-doesnt-clawdbot-reply-in-a-group)
  - [Do groups/threads share context with DMs?](#do-groupsthreads-share-context-with-dms)
  - [How many workspaces and agents can I create?](#how-many-workspaces-and-agents-can-i-create)
- [Models: defaults, selection, aliases, switching](#models-defaults-selection-aliases-switching)
  - [What is the “default model”?](#what-is-the-default-model)
  - [How do I switch models on the fly (without restarting)?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [Why do I see “Model … is not allowed” and then no reply?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [Why do I see “Unknown model: minimax/MiniMax-M2.1”?](#why-do-i-see-unknown-model-minimaxminimax-m21)
  - [Can I use MiniMax as my default and OpenAI for complex tasks?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [Are opus / sonnet / gpt built‑in shortcuts?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [How do I define/override model shortcuts (aliases)?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [How do I add models from other providers like OpenRouter or Z.AI?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [Model failover and “All models failed”](#model-failover-and-all-models-failed)
  - [How does failover work?](#how-does-failover-work)
  - [What does this error mean?](#what-does-this-error-mean)
  - [Fix checklist for `No credentials found for profile "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [Why did it also try Google Gemini and fail?](#why-did-it-also-try-google-gemini-and-fail)
- [Auth profiles: what they are and how to manage them](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [What is an auth profile?](#what-is-an-auth-profile)
  - [What are typical profile IDs?](#what-are-typical-profile-ids)
  - [Can I control which auth profile is tried first?](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth vs API key: what’s the difference?](#oauth-vs-api-key-whats-the-difference)
- [Gateway: ports, “already running”, and remote mode](#gateway-ports-already-running-and-remote-mode)
  - [What port does the Gateway use?](#what-port-does-the-gateway-use)
  - [Why does `clawdbot gateway status` say `Runtime: running` but `RPC probe: failed`?](#why-does-clawdbot-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [Why does `clawdbot gateway status` show `Config (cli)` and `Config (service)` different?](#why-does-clawdbot-gateway-status-show-config-cli-and-config-service-different)
  - [What does “another gateway instance is already listening” mean?](#what-does-another-gateway-instance-is-already-listening-mean)
  - [How do I run Clawdbot in remote mode (client connects to a Gateway elsewhere)?](#how-do-i-run-clawdbot-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [The Control UI says “unauthorized” (or keeps reconnecting). What now?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [I set `gateway.bind: "tailnet"` but it can’t bind / nothing listens](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [Can I run multiple Gateways on the same host?](#can-i-run-multiple-gateways-on-the-same-host)
  - [What does “invalid handshake” / code 1008 mean?](#what-does-invalid-handshake--code-1008-mean)
- [Logging and debugging](#logging-and-debugging)
  - [Where are logs?](#where-are-logs)
  - [How do I start/stop/restart the Gateway service?](#how-do-i-startstoprestart-the-gateway-service)
  - [ELI5: `clawdbot gateway restart` vs `clawdbot gateway`](#eli5-clawdbot-gateway-restart-vs-clawdbot-gateway)
  - [What’s the fastest way to get more details when something fails?](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [Media & attachments](#media-attachments)
  - [My skill generated an image/PDF, but nothing was sent](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [Security and access control](#security-and-access-control)
  - [Is it safe to expose Clawdbot to inbound DMs?](#is-it-safe-to-expose-clawdbot-to-inbound-dms)
  - [Is prompt injection only a concern for public bots?](#is-prompt-injection-only-a-concern-for-public-bots)
  - [Can I use cheaper models for personal assistant tasks?](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [I ran `/start` in Telegram but didn’t get a pairing code](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp: will it message my contacts? How does pairing work?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [Chat commands, aborting tasks, and “it won’t stop”](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [How do I stop/cancel a running task?](#how-do-i-stopcancel-a-running-task)
  - [Why does it feel like the bot “ignores” rapid‑fire messages?](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## First 60 seconds if something's broken

1) **Quick status (first check)**
   ```bash
   clawdbot status
   ```
   Fast local summary: OS + update, gateway/service reachability, agents/sessions, provider config + runtime issues (when gateway is reachable).

2) **Pasteable report (safe to share)**
   ```bash
   clawdbot status --all
   ```
   Read-only diagnosis with log tail (tokens redacted).

3) **Daemon + port state**
   ```bash
   clawdbot gateway status
   ```
   Shows supervisor runtime vs RPC reachability, the probe target URL, and which config the service likely used.

4) **Deep probes**
   ```bash
   clawdbot status --deep
   ```
   Runs gateway health checks + provider probes (requires a reachable gateway). See [Health](/gateway/health).

5) **Tail the latest log**
   ```bash
   clawdbot logs --follow
   ```
   If RPC is down, fall back to:
   ```bash
   tail -f "$(ls -t /tmp/clawdbot/clawdbot-*.log | head -1)"
   ```
   File logs are separate from service logs; see [Logging](/logging) and [Troubleshooting](/gateway/troubleshooting).

6) **Run the doctor (repairs)**
   ```bash
   clawdbot doctor
   ```
   Repairs/migrates config/state + runs health checks. See [Doctor](/gateway/doctor).

7) **Gateway snapshot**
   ```bash
   clawdbot health --json
   clawdbot health --verbose   # shows the target URL + config path on errors
   ```
   Asks the running gateway for a full snapshot (WS-only). See [Health](/gateway/health).

## What is Clawdbot?

### What is Clawdbot, in one paragraph?

Clawdbot is a personal AI assistant you run on your own devices. It replies on the messaging surfaces you already use (WhatsApp, Telegram, Slack, Mattermost (plugin), Discord, Signal, iMessage, WebChat) and can also do voice + a live Canvas on supported platforms. The **Gateway** is the always-on control plane; the assistant is the product.

## Quick start and first-run setup

### What’s the recommended way to install and set up Clawdbot?

The repo recommends running from source and using the onboarding wizard:

```bash
curl -fsSL https://clawd.bot/install.sh | bash
clawdbot onboard --install-daemon
```

The wizard can also build UI assets automatically. After onboarding, you typically run the Gateway on port **18789**.

From source (contributors/dev):

```bash
git clone https://github.com/clawdbot/clawdbot.git
cd clawdbot
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
clawdbot onboard
```

If you don’t have a global install yet, run it via `pnpm clawdbot onboard`.

### How do I open the dashboard after onboarding?

The wizard now opens your browser with a tokenized dashboard URL right after onboarding and also prints the full link (with token) in the summary. Keep that tab open; if it didn’t launch, copy/paste the printed URL on the same machine. Tokens stay local to your host—nothing is fetched from the browser.

### How do I authenticate the dashboard (token) on localhost vs remote?

**Localhost (same machine):**
- Open `http://127.0.0.1:18789/`.
- If it asks for auth, run `clawdbot dashboard` and use the tokenized link (`?token=...`).
- The token is the same value as `gateway.auth.token` (or `CLAWDBOT_GATEWAY_TOKEN`) and is stored by the UI after first load.

**Not on localhost:**
- **Tailscale Serve** (recommended): keep bind loopback, run `clawdbot gateway --tailscale serve`, open `https://<magicdns>/`. If `gateway.auth.allowTailscale` is `true`, identity headers satisfy auth (no token).
- **Tailnet bind**: run `clawdbot gateway --bind tailnet --token "<token>"`, open `http://<tailscale-ip>:18789/`, paste token in dashboard settings.
- **SSH tunnel**: `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/?token=...` from `clawdbot dashboard`.

See [Dashboard](/web/dashboard) and [Web surfaces](/web) for bind modes and auth details.

### What runtime do I need?

Node **>= 22** is required. `pnpm` is recommended. Bun is **not recommended** for the Gateway.

### What does the onboarding wizard actually do?

`clawdbot onboard` is the recommended setup path. In **local mode** it walks you through:

- **Model/auth setup** (Anthropic **setup-token** recommended for Claude subscriptions, OpenAI Codex OAuth supported, API keys optional, LM Studio local models supported)
- **Workspace** location + bootstrap files
- **Gateway settings** (bind/port/auth/tailscale)
- **Providers** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)
- **Daemon install** (LaunchAgent on macOS; systemd user unit on Linux/WSL2)
- **Health checks** and **skills** selection

It also warns if your configured model is unknown or missing auth.

### How does Anthropic "setup-token" auth work?

`claude setup-token` generates a **token string** via the Claude Code CLI (it is not available in the web console). You can run it on **any machine**. If Claude Code CLI credentials are present on the gateway host, Clawdbot can reuse them; otherwise choose **Anthropic token (paste setup-token)** and paste the string. The token is stored as an auth profile for the **anthropic** provider and used like an API key or OAuth profile. More detail: [OAuth](/concepts/oauth).

Clawdbot keeps `auth.profiles["anthropic:claude-cli"].mode` set to `"oauth"` so
the profile accepts both OAuth and setup-token credentials; older `"token"` mode
entries auto-migrate.

### Where do I find an Anthropic setup-token?

It is **not** in the Anthropic Console. The setup-token is generated by the **Claude Code CLI** on **any machine**:

```bash
claude setup-token
```

Copy the token it prints, then choose **Anthropic token (paste setup-token)** in the wizard. If you want to run it on the gateway host, use `clawdbot models auth setup-token --provider anthropic`. If you ran `claude setup-token` elsewhere, paste it on the gateway host with `clawdbot models auth paste-token --provider anthropic`. See [Anthropic](/providers/anthropic).

### Do you support Claude subscription auth (Claude Code OAuth)?

Yes. Clawdbot can **reuse Claude Code CLI credentials** (OAuth) and also supports **setup-token**. If you have a Claude subscription, we recommend **setup-token** for long‑running setups (requires Claude Pro/Max + the `claude` CLI). You can generate it anywhere and paste it on the gateway host. OAuth reuse is supported, but avoid logging in separately via Clawdbot and Claude Code to prevent token conflicts. See [Anthropic](/providers/anthropic) and [OAuth](/concepts/oauth).

Note: Claude subscription access is governed by Anthropic’s terms. For production or multi‑user workloads, API keys are usually the safer choice.

### Is AWS Bedrock supported?

Yes — via pi‑ai’s **Amazon Bedrock (Converse)** provider with **manual config**. You must supply AWS credentials/region on the gateway host and add a Bedrock provider entry in your models config. See [Amazon Bedrock](/bedrock) and [Model providers](/providers/models). If you prefer a managed key flow, an OpenAI‑compatible proxy in front of Bedrock is still a valid option.

### How does Codex auth work?

Clawdbot supports **OpenAI Code (Codex)** via OAuth or by reusing your Codex CLI login (`~/.codex/auth.json`). The wizard can import the CLI login or run the OAuth flow and will set the default model to `openai-codex/gpt-5.2` when appropriate. See [Model providers](/concepts/model-providers) and [Wizard](/start/wizard).

### Is a local model OK for casual chats?

Usually no. Clawdbot needs large context + strong safety; small cards truncate and leak. If you must, run the **largest** MiniMax M2.1 build you can locally (LM Studio) and see [/gateway/local-models](/gateway/local-models). Smaller/quantized models increase prompt-injection risk — see [Security](/gateway/security).

### How do I keep hosted model traffic in a specific region?

Pick region-pinned endpoints. OpenRouter exposes US-hosted options for MiniMax, Kimi, and GLM; choose the US-hosted variant to keep data in-region. You can still list Anthropic/OpenAI alongside these by using `models.mode: "merge"` so fallbacks stay available while respecting the regioned provider you select.

### Can I use Bun?

Bun is **not recommended**. We see runtime bugs, especially with WhatsApp and Telegram.
Use **Node** for stable gateways.

If you still want to experiment with Bun, do it on a non‑production gateway
without WhatsApp/Telegram.

### Telegram: what goes in `allowFrom`?

`channels.telegram.allowFrom` is **the human sender’s Telegram user ID** (numeric, recommended) or `@username`. It is not the bot username.

Safer (no third-party bot):
- DM your bot, then run `clawdbot logs --follow` and read `from.id`.

Official Bot API:
- DM your bot, then call `https://api.telegram.org/bot<bot_token>/getUpdates` and read `message.from.id`.

Third-party (less private):
- DM `@userinfobot` or `@getidsbot`.

See [/channels/telegram](/channels/telegram#access-control-dms--groups).

### Can multiple people use one WhatsApp number with different Clawdbots?

Yes, via **multi‑agent routing**. Bind each sender’s WhatsApp **DM** (peer `kind: "dm"`, sender E.164 like `+15551234567`) to a different `agentId`, so each person gets their own workspace and session store. Replies still come from the **same WhatsApp account**, and DM access control (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) is global per WhatsApp account. See [Multi-Agent Routing](/concepts/multi-agent) and [WhatsApp](/channels/whatsapp).

### Can I run a "fast chat" agent and an "Opus for coding" agent?

Yes. Use multi‑agent routing: give each agent its own default model, then bind inbound routes (provider account or specific peers) to each agent. Example config lives in [Multi-Agent Routing](/concepts/multi-agent). See also [Models](/concepts/models) and [Configuration](/gateway/configuration).

### Does Homebrew work on Linux?

Yes. Homebrew supports Linux (Linuxbrew). Quick setup:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

If you run Clawdbot via systemd, ensure the service PATH includes `/home/linuxbrew/.linuxbrew/bin` (or your brew prefix) so `brew`-installed tools resolve in non‑login shells.
Recent builds also prepend common user bin dirs on Linux systemd services (for example `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/.bun/bin`) and honor `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, and `FNM_DIR` when set.

### Can I switch between npm and git installs later?

Yes. Install the other flavor, then run Doctor so the gateway service points at the new entrypoint.

From npm → git:

```bash
git clone https://github.com/clawdbot/clawdbot.git
cd clawdbot
pnpm install
pnpm build
clawdbot doctor
clawdbot gateway restart
```

From git → npm:

```bash
npm install -g clawdbot@latest
clawdbot doctor
clawdbot gateway restart
```

Doctor detects a gateway service entrypoint mismatch and offers to rewrite the service config to match the current install (use `--repair` in automation).

### Should I run the Gateway on my laptop or a VPS?

Short answer: **if you want 24/7 reliability, use a VPS**. If you want the
lowest friction and you’re okay with sleep/restarts, run it locally.

**Laptop (local Gateway)**
- **Pros:** no server cost, direct access to local files, live browser window.
- **Cons:** sleep/network drops = disconnects, OS updates/reboots interrupt, must stay awake.

**VPS / cloud**
- **Pros:** always‑on, stable network, no laptop sleep issues, easier to keep running.
- **Cons:** often run headless (use screenshots), remote file access only, you must SSH for updates.

**Clawdbot-specific note:** WhatsApp/Telegram/Slack/Mattermost (plugin)/Discord all work fine from a VPS. The only real trade-off is **headless browser** vs a visible window. See [Browser](/tools/browser).

**Recommended default:** VPS if you had gateway disconnects before. Local is great when you’re actively using the Mac and want local file access or UI automation with a visible browser.

## Skills and automation

### How do I customize skills without keeping the repo dirty?

Use managed overrides instead of editing the repo copy. Put your changes in `~/.clawdbot/skills/<name>/SKILL.md` (or add a folder via `skills.load.extraDirs` in `~/.clawdbot/clawdbot.json`). Precedence is `<workspace>/skills` > `~/.clawdbot/skills` > bundled, so managed overrides win without touching git. Only upstream-worthy edits should live in the repo and go out as PRs.

### Can I load skills from a custom folder?

Yes. Add extra directories via `skills.load.extraDirs` in `~/.clawdbot/clawdbot.json` (lowest precedence). Default precedence remains: `<workspace>/skills` → `~/.clawdbot/skills` → bundled → `skills.load.extraDirs`. `clawdhub` installs into `./skills` by default, which Clawdbot treats as `<workspace>/skills`.

### How can I use different models for different tasks?

Today the supported patterns are:
- **Cron jobs**: isolated jobs can set a `model` override per job.
- **Sub-agents**: route tasks to separate agents with different default models.
- **On-demand switch**: use `/model` to switch the current session model at any time.

See [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent), and [Slash commands](/tools/slash-commands).

### How do I install skills on Linux?

Use **ClawdHub** (CLI) or drop skills into your workspace. The macOS Skills UI isn’t available on Linux.
Browse skills at https://clawdhub.com.

Install the ClawdHub CLI (pick one package manager):

```bash
npm i -g clawdhub
```

```bash
pnpm add -g clawdhub
```

### Is there a way to run Apple/macOS-only skills if my Gateway runs on Linux?

Not directly. macOS skills are gated by `metadata.clawdbot.os` plus required binaries, and skills only appear in the system prompt when they are eligible on the **Gateway host**. On Linux, `darwin`-only skills (like `imsg`, `apple-notes`, `apple-reminders`) will not load unless you override the gating.

You have three supported patterns:

**Option A - run the Gateway on a Mac (simplest).**  
Run the Gateway where the macOS binaries exist, then connect from Linux in [remote mode](#how-do-i-run-clawdbot-in-remote-mode-client-connects-to-a-gateway-elsewhere) or over Tailscale. The skills load normally because the Gateway host is macOS.

**Option B - use a macOS node (no SSH).**  
Run the Gateway on Linux, pair a macOS node (menubar app), and set **Node Run Commands** to "Always Ask" or "Always Allow" on the Mac. Clawdbot can treat macOS-only skills as eligible when the required binaries exist on the node. The agent runs those skills via the `nodes` tool. If you choose "Always Ask", approving "Always Allow" in the prompt adds that command to the allowlist.

**Option C - proxy macOS binaries over SSH (advanced).**  
Keep the Gateway on Linux, but make the required CLI binaries resolve to SSH wrappers that run on a Mac. Then override the skill to allow Linux so it stays eligible.

1) Create an SSH wrapper for the binary (example: `imsg`):
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/imsg "$@"
   ```
2) Put the wrapper on `PATH` on the Linux host (for example `~/bin/imsg`).
3) Override the skill metadata (workspace or `~/.clawdbot/skills`) to allow Linux:
   ```markdown
   ---
   name: imsg
   description: iMessage/SMS CLI for listing chats, history, watch, and sending.
   metadata: {"clawdbot":{"os":["darwin","linux"],"requires":{"bins":["imsg"]}}}
   ---
   ```
4) Start a new session so the skills snapshot refreshes.

For iMessage specifically, you can also point `channels.imessage.cliPath` at an SSH wrapper (Clawdbot only needs stdio). See [iMessage](/channels/imessage).

### Do you have a Notion or HeyGen integration?

Not built‑in today.

Options:
- **Custom skill / plugin:** best for reliable API access (Notion/HeyGen both have APIs).
- **Browser automation:** works without code but is slower and more fragile.

If you want to keep context per client (agency workflows), a simple pattern is:
- One Notion page per client (context + preferences + active work).
- Ask the agent to fetch that page at the start of a session.

If you want a native integration, open a feature request or build a skill
targeting those APIs.

Install skills:

```bash
clawdhub install <skill-slug>
clawdhub update --all
```

ClawdHub installs into `./skills` under your current directory (or falls back to your configured Clawdbot workspace); Clawdbot treats that as `<workspace>/skills` on the next session. For shared skills across agents, place them in `~/.clawdbot/skills/<name>/SKILL.md`. Some skills expect binaries installed via Homebrew; on Linux that means Linuxbrew (see the Homebrew Linux FAQ entry above). See [Skills](/tools/skills) and [ClawdHub](/tools/clawdhub).

### How do I install the Chrome extension for browser takeover?

Use the built-in installer, then load the unpacked extension in Chrome:

```bash
clawdbot browser extension install
clawdbot browser extension path
```

Then Chrome → `chrome://extensions` → enable “Developer mode” → “Load unpacked” → pick that folder.

Full guide (including remote Gateway via Tailscale + security notes): [Chrome extension](/tools/chrome-extension)

If the Gateway runs on the same machine as Chrome (default setup), you usually **do not** need `clawdbot browser serve`.
You still need to click the extension button on the tab you want to control (it doesn’t auto-attach).

## Sandboxing and memory

### Is there a dedicated sandboxing doc?

Yes. See [Sandboxing](/gateway/sandboxing). For Docker-specific setup (full gateway in Docker or sandbox images), see [Docker](/install/docker).

### Can I keep DMs “personal” but make groups “public/sandboxed” with one agent?

Yes — if your private traffic is **DMs** and your public traffic is **groups**.

Use `agents.defaults.sandbox.mode: "non-main"` so group/channel sessions (non-main keys) run in Docker, while the main DM session stays on-host. Then restrict what tools are available in sandboxed sessions via `tools.sandbox.tools`.

Setup walkthrough + example config: [Groups: personal DMs + public groups](/concepts/groups#pattern-personal-dms-public-groups-single-agent)

Key config reference: [Gateway configuration](/gateway/configuration#agentsdefaultssandbox)

### How do I bind a host folder into the sandbox?

Set `agents.defaults.sandbox.docker.binds` to `["host:path:mode"]` (e.g., `"/home/user/src:/src:ro"`). Global + per-agent binds merge; per-agent binds are ignored when `scope: "shared"`. Use `:ro` for anything sensitive and remember binds bypass the sandbox filesystem walls. See [Sandboxing](/gateway/sandboxing#custom-bind-mounts) and [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) for examples and safety notes.

### How does memory work?

Clawdbot memory is just Markdown files in the agent workspace:
- Daily notes in `memory/YYYY-MM-DD.md`
- Curated long-term notes in `MEMORY.md` (main/private sessions only)

Clawdbot also runs a **silent pre-compaction memory flush** to remind the model
to write durable notes before auto-compaction. This only runs when the workspace
is writable (read-only sandboxes skip it). See [Memory](/concepts/memory).

### Does semantic memory search require an OpenAI API key?

Only if you use **OpenAI embeddings**. Codex OAuth covers chat/completions and
does **not** grant embeddings access, so **signing in with Codex (OAuth or the
Codex CLI login)** does not help for semantic memory search. OpenAI embeddings
still need a real API key (`OPENAI_API_KEY` or `models.providers.openai.apiKey`).

If you don’t set a provider explicitly, Clawdbot auto-selects a provider when it
can resolve an API key (auth profiles, `models.providers.*.apiKey`, or env vars).
It prefers OpenAI if an OpenAI key resolves, otherwise Gemini if a Gemini key
resolves. If neither key is available, memory search stays disabled until you
configure it. If you have a local model path configured and present, Clawdbot
prefers `local`.

If you’d rather stay local, set `memorySearch.provider = "local"` (and optionally
`memorySearch.fallback = "none"`). If you want Gemini embeddings, set
`memorySearch.provider = "gemini"` and provide `GEMINI_API_KEY` (or
`memorySearch.remote.apiKey`). We support **OpenAI, Gemini, or local** embedding
models — see [Memory](/concepts/memory) for the setup details.

## Where things live on disk

### Where does Clawdbot store its data?

Everything lives under `$CLAWDBOT_STATE_DIR` (default: `~/.clawdbot`):

| Path | Purpose |
|------|---------|
| `$CLAWDBOT_STATE_DIR/clawdbot.json` | Main config (JSON5) |
| `$CLAWDBOT_STATE_DIR/credentials/oauth.json` | Legacy OAuth import (copied into auth profiles on first use) |
| `$CLAWDBOT_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | Auth profiles (OAuth + API keys) |
| `$CLAWDBOT_STATE_DIR/agents/<agentId>/agent/auth.json` | Runtime auth cache (managed automatically) |
| `$CLAWDBOT_STATE_DIR/credentials/` | Provider state (e.g. `whatsapp/<accountId>/creds.json`) |
| `$CLAWDBOT_STATE_DIR/agents/` | Per‑agent state (agentDir + sessions) |
| `$CLAWDBOT_STATE_DIR/agents/<agentId>/sessions/` | Conversation history & state (per agent) |
| `$CLAWDBOT_STATE_DIR/agents/<agentId>/sessions/sessions.json` | Session metadata (per agent) |

Legacy single‑agent path: `~/.clawdbot/agent/*` (migrated by `clawdbot doctor`).

Your **workspace** (AGENTS.md, memory files, skills, etc.) is separate and configured via `agents.defaults.workspace` (default: `~/clawd`).

### Where should AGENTS.md / SOUL.md / USER.md / MEMORY.md live?

These files live in the **agent workspace**, not `~/.clawdbot`.

- **Workspace (per agent)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md` (or `memory.md`), `memory/YYYY-MM-DD.md`, optional `HEARTBEAT.md`.
- **State dir (`~/.clawdbot`)**: config, credentials, auth profiles, sessions, logs,
  and shared skills (`~/.clawdbot/skills`).

Default workspace is `~/clawd`, configurable via:

```json5
{
  agents: { defaults: { workspace: "~/clawd" } }
}
```

If the bot “forgets” after a restart, confirm the Gateway is using the same
workspace on every launch (and remember: remote mode uses the **gateway host’s**
workspace, not your local laptop).

See [Agent workspace](/concepts/agent-workspace) and [Memory](/concepts/memory).

### How do I completely uninstall Clawdbot?

See the dedicated guide: [Uninstall](/install/uninstall).

### Can agents work outside the workspace?

Yes. The workspace is the **default cwd** and memory anchor, not a hard sandbox.
Relative paths resolve inside the workspace, but absolute paths can access other
host locations unless sandboxing is enabled. If you need isolation, use
[`agents.defaults.sandbox`](/gateway/sandboxing) or per‑agent sandbox settings. If you
want a repo to be the default working directory, point that agent’s
`workspace` to the repo root. The Clawdbot repo is just source code; keep the
workspace separate unless you intentionally want the agent to work inside it.

Example (repo as default cwd):

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo"
    }
  }
}
```

### I’m in remote mode — where is the session store?

Session state is owned by the **gateway host**. If you’re in remote mode, the session store you care about is on the remote machine, not your local laptop. See [Session management](/concepts/session).

## Config basics

### What format is the config? Where is it?

Clawdbot reads an optional **JSON5** config from `$CLAWDBOT_CONFIG_PATH` (default: `~/.clawdbot/clawdbot.json`):

```
$CLAWDBOT_CONFIG_PATH
```

If the file is missing, it uses safe‑ish defaults (including a default workspace of `~/clawd`).

### I set `gateway.bind: "lan"` (or `"tailnet"`) and now nothing listens / the UI says unauthorized

Non-loopback binds **require auth**. Configure `gateway.auth.mode` + `gateway.auth.token` (or use `CLAWDBOT_GATEWAY_TOKEN`).

```json5
{
  gateway: {
    bind: "lan",
    auth: {
      mode: "token",
      token: "replace-me"
    }
  }
}
```

Notes:
- `gateway.remote.token` is for **remote CLI calls** only; it does not enable local gateway auth.
- The Control UI authenticates via `connect.params.auth.token` (stored in app/UI settings). Avoid putting tokens in URLs.

### Why do I need a token on localhost now?

The wizard generates a gateway token by default (even on loopback) so **local WS clients must authenticate**. This blocks other local processes from calling the Gateway. Paste the token into the Control UI settings (or your client config) to connect.

If you **really** want open loopback, remove `gateway.auth` from your config. Doctor can generate a token for you any time: `clawdbot doctor --generate-gateway-token`.

### Do I have to restart after changing config?

The Gateway watches the config and supports hot‑reload:

- `gateway.reload.mode: "hybrid"` (default): hot‑apply safe changes, restart for critical ones
- `hot`, `restart`, `off` are also supported

### How do I enable web search (and web fetch)?

`web_fetch` works without an API key. `web_search` requires a Brave Search API
key. **Recommended:** run `clawdbot configure --section web` to store it in
`tools.web.search.apiKey`. Environment alternative: set `BRAVE_API_KEY` for the
Gateway process.

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5
      },
      fetch: {
        enabled: true
      }
    }
  }
}
```

Notes:
- If you use allowlists, add `web_search`/`web_fetch` or `group:web`.
- `web_fetch` is enabled by default (unless explicitly disabled).
- Daemons read env vars from `~/.clawdbot/.env` (or the service environment).

Docs: [Web tools](/tools/web).

### How do I run a central Gateway with specialized workers across devices?

The common pattern is **one Gateway** (e.g. Raspberry Pi) plus **nodes** and **agents**:

- **Gateway (central):** owns channels (Signal/WhatsApp), routing, and sessions.
- **Nodes (devices):** Macs/iOS/Android connect as peripherals and expose local tools (`system.run`, `canvas`, `camera`).
- **Agents (workers):** separate brains/workspaces for special roles (e.g. “Hetzner ops”, “Personal data”).
- **Sub‑agents:** spawn background work from a main agent when you want parallelism.
- **TUI:** connect to the Gateway and switch agents/sessions.

Docs: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/tui).

### Can the Clawdbot browser run headless?

Yes. It’s a config option:

```json5
{
  browser: { headless: true },
  agents: {
    defaults: {
      sandbox: { browser: { headless: true } }
    }
  }
}
```

Default is `false` (headful). Headless is more likely to trigger anti‑bot checks on some sites. See [Browser](/tools/browser).

Headless uses the **same Chromium engine** and works for most automation (forms, clicks, scraping, logins). The main differences:
- No visible browser window (use screenshots if you need visuals).
- Some sites are stricter about automation in headless mode (CAPTCHAs, anti‑bot).
  For example, X/Twitter often blocks headless sessions.

### How do I use Brave for browser control?

Set `browser.executablePath` to your Brave binary (or any Chromium-based browser) and restart the Gateway.
See the full config examples in [Browser](/tools/browser#use-brave-or-another-chromium-based-browser).

## Remote gateways + nodes

### How do commands propagate between Telegram, the gateway, and nodes?

Telegram messages are handled by the **gateway**. The gateway runs the agent and
only then calls nodes over the **Gateway WebSocket** when a node tool is needed:

Telegram → Gateway → Agent → `node.*` → Node → Gateway → Telegram

Nodes don’t see inbound provider traffic; they only receive node RPC calls.

### How can my agent access my computer if the Gateway is hosted remotely?

Short answer: **pair your computer as a node**. The Gateway runs elsewhere, but it can
call `node.*` tools (screen, camera, system) on your local machine over the Gateway WebSocket.

Typical setup:
1) Run the Gateway on the always‑on host (VPS/home server).
2) Put the Gateway host + your computer on the same tailnet.
3) Ensure the Gateway WS is reachable (tailnet bind or SSH tunnel).
4) Open the macOS app locally and connect in **Remote over SSH** mode (or direct tailnet)
   so it can register as a node.
5) Approve the node on the Gateway:
   ```bash
   clawdbot nodes pending
   clawdbot nodes approve <requestId>
   ```

No separate TCP bridge is required; nodes connect over the Gateway WebSocket.

Security reminder: pairing a macOS node allows `system.run` on that machine. Only
pair devices you trust, and review [Security](/gateway/security).

Docs: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remote mode](/platforms/mac/remote), [Security](/gateway/security).

### Do nodes run a gateway service?

No. Only **one gateway** should run per host unless you intentionally run isolated profiles (see [Multiple gateways](/gateway/multiple-gateways)). Nodes are peripherals that connect
to the gateway (iOS/Android nodes, or macOS “node mode” in the menubar app).

A full restart is required for `gateway`, `discovery`, and `canvasHost` changes.

### Is there an API / RPC way to apply config?

Yes. `config.apply` validates + writes the full config and restarts the Gateway as part of the operation.

### What’s a minimal “sane” config for a first install?

```json5
{
  agents: { defaults: { workspace: "~/clawd" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } }
}
```

This sets your workspace and restricts who can trigger the bot.

### How do I set up Tailscale on a VPS and connect from my Mac?

Minimal steps:

1) **Install + login on the VPS**
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
2) **Install + login on your Mac**
   - Use the Tailscale app and sign in to the same tailnet.
3) **Enable MagicDNS (recommended)**
   - In the Tailscale admin console, enable MagicDNS so the VPS has a stable name.
4) **Use the tailnet hostname**
   - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

If you want the Control UI without SSH, use Tailscale Serve on the VPS:
```bash
clawdbot gateway --tailscale serve
```
This keeps the gateway bound to loopback and exposes HTTPS via Tailscale. See [Tailscale](/gateway/tailscale).

### How do I connect a Mac node to a remote Gateway (Tailscale Serve)?

Serve exposes the **Gateway Control UI + WS**. Nodes connect over the same Gateway WS endpoint.

Recommended setup:
1) **Make sure the VPS + Mac are on the same tailnet**.
2) **Use the macOS app in Remote mode** (SSH target can be the tailnet hostname).
   The app will tunnel the Gateway port and connect as a node.
3) **Approve the node** on the gateway:
   ```bash
   clawdbot nodes pending
   clawdbot nodes approve <requestId>
   ```

Docs: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

## Env vars and .env loading

### How does Clawdbot load environment variables?

Clawdbot reads env vars from the parent process (shell, launchd/systemd, CI, etc.) and additionally loads:

- `.env` from the current working directory
- a global fallback `.env` from `~/.clawdbot/.env` (aka `$CLAWDBOT_STATE_DIR/.env`)

Neither `.env` file overrides existing env vars.

You can also define inline env vars in config (applied only if missing from the process env):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." }
  }
}
```

See [/environment](/environment) for full precedence and sources.

### “I started the Gateway via a service and my env vars disappeared.” What now?

Two common fixes:

1) Put the missing keys in `~/.clawdbot/.env` so they’re picked up even when the service doesn’t inherit your shell env.
2) Enable shell import (opt‑in convenience):

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000
    }
  }
}
```

This runs your login shell and imports only missing expected keys (never overrides). Env var equivalents:
`CLAWDBOT_LOAD_SHELL_ENV=1`, `CLAWDBOT_SHELL_ENV_TIMEOUT_MS=15000`.

### I set `COPILOT_GITHUB_TOKEN`, but models status shows “Shell env: off.” Why?

`clawdbot models status` reports whether **shell env import** is enabled. “Shell env: off”
does **not** mean your env vars are missing — it just means Clawdbot won’t load
your login shell automatically.

If the Gateway runs as a service (launchd/systemd), it won’t inherit your shell
environment. Fix by doing one of these:

1) Put the token in `~/.clawdbot/.env`:
   ```
   COPILOT_GITHUB_TOKEN=...
   ```
2) Or enable shell import (`env.shellEnv.enabled: true`).
3) Or add it to your config `env` block (applies only if missing).

Then restart the gateway and recheck:
```bash
clawdbot models status
```

Copilot tokens are read from `COPILOT_GITHUB_TOKEN` (also `GH_TOKEN` / `GITHUB_TOKEN`).
See [/concepts/model-providers](/concepts/model-providers) and [/environment](/environment).

## Sessions & multiple chats

### How do I start a fresh conversation?

Send `/new` or `/reset` as a standalone message. See [Session management](/concepts/session).

### Do sessions reset automatically if I never send `/new`?

Yes. Sessions expire after `session.idleMinutes` (default **60**). The **next**
message starts a fresh session id for that chat key. This does not delete
transcripts — it just starts a new session.

```json5
{
  session: {
    idleMinutes: 240
  }
}
```

### How do I completely reset Clawdbot but keep it installed?

Use the reset command:

```bash
clawdbot reset
```

Non-interactive full reset:

```bash
clawdbot reset --scope full --yes --non-interactive
```

Then re-run onboarding:

```bash
clawdbot onboard --install-daemon
```

Notes:
- The onboarding wizard also offers **Reset** if it sees an existing config. See [Wizard](/start/wizard).
- If you used profiles (`--profile` / `CLAWDBOT_PROFILE`), reset each state dir (defaults are `~/.clawdbot-<profile>`).
- Dev reset: `clawdbot gateway --dev --reset` (dev-only; wipes dev config + credentials + sessions + workspace).

### I’m getting “context too large” errors — how do I reset or compact?

Use one of these:

- **Compact** (keeps the conversation but summarizes older turns):
  ```
  /compact
  ```
  or `/compact <instructions>` to guide the summary.

- **Reset** (fresh session ID for the same chat key):
  ```
  /new
  /reset
  ```

If it keeps happening:
- Enable or tune **session pruning** (`agents.defaults.contextPruning`) to trim old tool output.
- Use a model with a larger context window.

Docs: [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning), [Session management](/concepts/session).

### Why am I seeing “LLM request rejected: messages.N.content.X.tool_use.input: Field required”?

This is a provider validation error: the model emitted a `tool_use` block without the required
`input`. It usually means the session history is stale or corrupted (often after long threads
or a tool/schema change).

Fix: start a fresh session with `/new` (standalone message).

### Why am I getting heartbeat messages every 30 minutes?

Heartbeats run every **30m** by default. Tune or disable them:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "2h"   // or "0m" to disable
      }
    }
  }
}
```

If `HEARTBEAT.md` exists but is effectively empty (only blank lines and markdown
headers like `# Heading`), Clawdbot skips the heartbeat run to save API calls.
If the file is missing, the heartbeat still runs and the model decides what to do.

Per-agent overrides use `agents.list[].heartbeat`. Docs: [Heartbeat](/gateway/heartbeat).

### Do I need to add a “bot account” to a WhatsApp group?

No. Clawdbot runs on **your own account**, so if you’re in the group, Clawdbot can see it.
By default, group replies are blocked until you allow senders (`groupPolicy: "allowlist"`).

If you want only **you** to be able to trigger group replies:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"]
    }
  }
}
```

### Why doesn’t Clawdbot reply in a group?

Two common causes:
- Mention gating is on (default). You must @mention the bot (or match `mentionPatterns`).
- You configured `channels.whatsapp.groups` without `"*"` and the group isn’t allowlisted.

See [Groups](/concepts/groups) and [Group messages](/concepts/group-messages).

### Do groups/threads share context with DMs?

Direct chats collapse to the main session by default. Groups/channels have their own session keys, and Telegram topics / Discord threads are separate sessions. See [Groups](/concepts/groups) and [Group messages](/concepts/group-messages).

### How many workspaces and agents can I create?

No hard limits. Dozens (even hundreds) are fine, but watch for:

- **Disk growth:** sessions + transcripts live under `~/.clawdbot/agents/<agentId>/sessions/`.
- **Token cost:** more agents means more concurrent model usage.
- **Ops overhead:** per-agent auth profiles, workspaces, and channel routing.

Tips:
- Keep one **active** workspace per agent (`agents.defaults.workspace`).
- Prune old sessions (delete JSONL or store entries) if disk grows.
- Use `clawdbot doctor` to spot stray workspaces and profile mismatches.

## Models: defaults, selection, aliases, switching

### What is the “default model”?

Clawdbot’s default model is whatever you set as:

```
agents.defaults.model.primary
```

Models are referenced as `provider/model` (example: `anthropic/claude-opus-4-5`). If you omit the provider, Clawdbot currently assumes `anthropic` as a temporary deprecation fallback — but you should still **explicitly** set `provider/model`.

### How do I switch models on the fly (without restarting)?

Use the `/model` command as a standalone message:

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

You can list available models with `/model`, `/model list`, or `/model status`.

`/model` (and `/model list`) shows a compact, numbered picker. Select by number:

```
/model 3
```

You can also force a specific auth profile for the provider (per session):

```
/model opus@anthropic:claude-cli
/model opus@anthropic:default
```

Tip: `/model status` shows which agent is active, which `auth-profiles.json` file is being used, and which auth profile will be tried next.
It also shows the configured provider endpoint (`baseUrl`) and API mode (`api`) when available.

### How do I unpin a profile I set with `@profile`?

Re-run `/model` **without** the `@profile` suffix:

```
/model anthropic/claude-opus-4-5
```

If you want to return to the default, pick it from `/model` (or send `/model <default provider/model>`).
Use `/model status` to confirm which auth profile is active.

### Why do I see “Model … is not allowed” and then no reply?

If `agents.defaults.models` is set, it becomes the **allowlist** for `/model` and any
session overrides. Choosing a model that isn’t in that list returns:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

That error is returned **instead of** a normal reply. Fix: add the model to
`agents.defaults.models`, remove the allowlist, or pick a model from `/model list`.

### Why do I see “Unknown model: minimax/MiniMax-M2.1”?

This means the **provider isn’t configured** (no MiniMax provider config or auth
profile was found), so the model can’t be resolved. A fix for this detection is
in **2026.1.12** (unreleased at the time of writing).

Fix checklist:
1) Upgrade to **2026.1.12** (or run from source `main`), then restart the gateway.
2) Make sure MiniMax is configured (wizard or JSON), or that a MiniMax API key
   exists in env/auth profiles so the provider can be injected.
3) Use the exact model id (case‑sensitive): `minimax/MiniMax-M2.1` or
   `minimax/MiniMax-M2.1-lightning`.
4) Run:
   ```bash
   clawdbot models list
   ```
   and pick from the list (or `/model list` in chat).

See [MiniMax](/providers/minimax) and [Models](/concepts/models).

### Can I use MiniMax as my default and OpenAI for complex tasks?

Yes. Use **MiniMax as the default** and switch models **per session** when needed.
Fallbacks are for **errors**, not “hard tasks,” so use `/model` or a separate agent.

**Option A: switch per session**
```json5
{
  env: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2.1" },
      models: {
        "minimax/MiniMax-M2.1": { alias: "minimax" },
        "openai/gpt-5.2": { alias: "gpt" }
      }
    }
  }
}
```

Then:
```
/model gpt
```

**Option B: separate agents**
- Agent A default: MiniMax
- Agent B default: OpenAI
- Route by agent or use `/agent` to switch

Docs: [Models](/concepts/models), [Multi-Agent Routing](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### Are opus / sonnet / gpt built‑in shortcuts?

Yes. Clawdbot ships a few default shorthands (only applied when the model exists in `agents.defaults.models`):

- `opus` → `anthropic/claude-opus-4-5`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

If you set your own alias with the same name, your value wins.

### How do I define/override model shortcuts (aliases)?

Aliases come from `agents.defaults.models.<modelId>.alias`. Example:

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-5" },
      models: {
        "anthropic/claude-opus-4-5": { alias: "opus" },
        "anthropic/claude-sonnet-4-5": { alias: "sonnet" },
        "anthropic/claude-haiku-4-5": { alias: "haiku" }
      }
    }
  }
}
```

Then `/model sonnet` (or `/<alias>` when supported) resolves to that model ID.

### How do I add models from other providers like OpenRouter or Z.AI?

OpenRouter (pay‑per‑token; many models):

```json5
{
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      models: { "openrouter/anthropic/claude-sonnet-4-5": {} }
    }
  },
  env: { OPENROUTER_API_KEY: "sk-or-..." }
}
```

Z.AI (GLM models):

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} }
    }
  },
  env: { ZAI_API_KEY: "..." }
}
```

If you reference a provider/model but the required provider key is missing, you’ll get a runtime auth error (e.g. `No API key found for provider "zai"`).

### “No API key found for provider …” after adding a new agent

This usually means the **new agent** has an empty auth store. Auth is per-agent and
stored in:

```
~/.clawdbot/agents/<agentId>/agent/auth-profiles.json
```

Fix options:
- Run `clawdbot agents add <id>` and configure auth during the wizard.
- Or copy `auth-profiles.json` from the main agent’s `agentDir` into the new agent’s `agentDir`.

Do **not** reuse `agentDir` across agents; it causes auth/session collisions.

## Model failover and “All models failed”

### How does failover work?

Failover happens in two stages:

1) **Auth profile rotation** within the same provider.
2) **Model fallback** to the next model in `agents.defaults.model.fallbacks`.

Cooldowns apply to failing profiles (exponential backoff), so Clawdbot can keep responding even when a provider is rate‑limited or temporarily failing.

### What does this error mean?

```
No credentials found for profile "anthropic:default"
```

It means the system attempted to use the auth profile ID `anthropic:default`, but could not find credentials for it in the expected auth store.

### Fix checklist for `No credentials found for profile "anthropic:default"`

- **Confirm where auth profiles live** (new vs legacy paths)
  - Current: `~/.clawdbot/agents/<agentId>/agent/auth-profiles.json`
  - Legacy: `~/.clawdbot/agent/*` (migrated by `clawdbot doctor`)
- **Confirm your env var is loaded by the Gateway**
  - If you set `ANTHROPIC_API_KEY` in your shell but run the Gateway via systemd/launchd, it may not inherit it. Put it in `~/.clawdbot/.env` or enable `env.shellEnv`.
- **Make sure you’re editing the correct agent**
  - Multi‑agent setups mean there can be multiple `auth-profiles.json` files.
- **Sanity‑check model/auth status**
  - Use `clawdbot models status` to see configured models and whether providers are authenticated.

### Fix checklist for `No credentials found for profile "anthropic:claude-cli"`

This means the run is pinned to the **Claude Code CLI** profile, but the Gateway
can’t find that profile in its auth store.

- **Sync the Claude Code CLI token on the gateway host**
  - Run `clawdbot models status` (it loads + syncs Claude Code CLI credentials).
  - If it still says missing: run `claude setup-token` (or `clawdbot models auth setup-token --provider anthropic`) and retry.
- **If the token was created on another machine**
  - Paste it into the gateway host with `clawdbot models auth paste-token --provider anthropic`.
- **Check the profile mode**
  - `auth.profiles["anthropic:claude-cli"].mode` must be `"oauth"` (token mode rejects OAuth credentials).
- **If you want to use an API key instead**
  - Put `ANTHROPIC_API_KEY` in `~/.clawdbot/.env` on the **gateway host**.
  - Clear any pinned order that forces `anthropic:claude-cli`:
    ```bash
    clawdbot models auth order clear --provider anthropic
    ```
- **Confirm you’re running commands on the gateway host**
  - In remote mode, auth profiles live on the gateway machine, not your laptop.

### Why did it also try Google Gemini and fail?

If your model config includes Google Gemini as a fallback (or you switched to a Gemini shorthand), Clawdbot will try it during model fallback. If you haven’t configured Google credentials, you’ll see `No API key found for provider "google"`.

Fix: either provide Google auth, or remove/avoid Google models in `agents.defaults.model.fallbacks` / aliases so fallback doesn’t route there.

### “LLM request rejected: messages.*.thinking.signature required (google‑antigravity)”

Cause: the session history contains **thinking blocks without signatures** (often from
an aborted/partial stream). Google Antigravity requires signatures for thinking blocks.

Fix: Clawdbot now strips unsigned thinking blocks for Google Antigravity Claude. If it still appears, start a **new session** or set `/thinking off` for that agent.

## Auth profiles: what they are and how to manage them

Related: [/concepts/oauth](/concepts/oauth) (OAuth flows, token storage, multi-account patterns, CLI sync)

### What is an auth profile?

An auth profile is a named credential record (OAuth or API key) tied to a provider. Profiles live in:

```
~/.clawdbot/agents/<agentId>/agent/auth-profiles.json
```

### What are typical profile IDs?

Clawdbot uses provider‑prefixed IDs like:

- `anthropic:default` (common when no email identity exists)
- `anthropic:<email>` for OAuth identities
- custom IDs you choose (e.g. `anthropic:work`)

### Can I control which auth profile is tried first?

Yes. Config supports optional metadata for profiles and an ordering per provider (`auth.order.<provider>`). This does **not** store secrets; it maps IDs to provider/mode and sets rotation order.

Clawdbot may temporarily skip a profile if it’s in a short **cooldown** (rate limits/timeouts/auth failures) or a longer **disabled** state (billing/insufficient credits). To inspect this, run `clawdbot models status --json` and check `auth.unusableProfiles`. Tuning: `auth.cooldowns.billingBackoffHours*`.

You can also set a **per-agent** order override (stored in that agent’s `auth-profiles.json`) via the CLI:

```bash
# Defaults to the configured default agent (omit --agent)
clawdbot models auth order get --provider anthropic

# Lock rotation to a single profile (only try this one)
clawdbot models auth order set --provider anthropic anthropic:claude-cli

# Or set an explicit order (fallback within provider)
clawdbot models auth order set --provider anthropic anthropic:claude-cli anthropic:default

# Clear override (fall back to config auth.order / round-robin)
clawdbot models auth order clear --provider anthropic
```

To target a specific agent:

```bash
clawdbot models auth order set --provider anthropic --agent main anthropic:claude-cli
```

### OAuth vs API key: what’s the difference?

Clawdbot supports both:

- **OAuth** often leverages subscription access (where applicable).
- **API keys** use pay‑per‑token billing.

The wizard explicitly supports Anthropic OAuth and OpenAI Codex OAuth and can store API keys for you.

## Gateway: ports, “already running”, and remote mode

### What port does the Gateway use?

`gateway.port` controls the single multiplexed port for WebSocket + HTTP (Control UI, hooks, etc.).

Precedence:

```
--port > CLAWDBOT_GATEWAY_PORT > gateway.port > default 18789
```

### Why does `clawdbot gateway status` say `Runtime: running` but `RPC probe: failed`?

Because “running” is the **supervisor’s** view (launchd/systemd/schtasks). The RPC probe is the CLI actually connecting to the gateway WebSocket and calling `status`.

Use `clawdbot gateway status` and trust these lines:
- `Probe target:` (the URL the probe actually used)
- `Listening:` (what’s actually bound on the port)
- `Last gateway error:` (common root cause when the process is alive but the port isn’t listening)

### Why does `clawdbot gateway status` show `Config (cli)` and `Config (service)` different?

You’re editing one config file while the service is running another (often a `--profile` / `CLAWDBOT_STATE_DIR` mismatch).

Fix:
```bash
clawdbot gateway install --force
```
Run that from the same `--profile` / environment you want the service to use.

### What does “another gateway instance is already listening” mean?

Clawdbot enforces a runtime lock by binding the WebSocket listener immediately on startup (default `ws://127.0.0.1:18789`). If the bind fails with `EADDRINUSE`, it throws `GatewayLockError` indicating another instance is already listening.

Fix: stop the other instance, free the port, or run with `clawdbot gateway --port <port>`.

### How do I run Clawdbot in remote mode (client connects to a Gateway elsewhere)?

Set `gateway.mode: "remote"` and point to a remote WebSocket URL, optionally with a token/password:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      password: "your-password"
    }
  }
}
```

Notes:
- `clawdbot gateway` only starts when `gateway.mode` is `local` (or you pass the override flag).
- The macOS app watches the config file and switches modes live when these values change.

### The Control UI says “unauthorized” (or keeps reconnecting). What now?

Your gateway is running with auth enabled (`gateway.auth.*`), but the UI is not sending the matching token/password.

Facts (from code):
- The Control UI stores the token in browser localStorage key `clawdbot.control.settings.v1`.
- The UI can import `?token=...` (and/or `?password=...`) once, then strips it from the URL.

Fix:
- Fastest: `clawdbot dashboard` (prints + copies tokenized link, tries to open; shows SSH hint if headless).
- If you don’t have a token yet: `clawdbot doctor --generate-gateway-token`.
- If remote, tunnel first: `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/?token=...`.
- Set `gateway.auth.token` (or `CLAWDBOT_GATEWAY_TOKEN`) on the gateway host.
- In the Control UI settings, paste the same token (or refresh with a one-time `?token=...` link).
- Still stuck? Run `clawdbot status --all` and follow [Troubleshooting](/gateway/troubleshooting). See [Dashboard](/web/dashboard) for auth details.

### I set `gateway.bind: "tailnet"` but it can’t bind / nothing listens

`tailnet` bind picks a Tailscale IP from your network interfaces (100.64.0.0/10). If the machine isn’t on Tailscale (or the interface is down), there’s nothing to bind to.

Fix:
- Start Tailscale on that host (so it has a 100.x address), or
- Switch to `gateway.bind: "loopback"` / `"lan"`.
  
Note: `tailnet` is explicit. `auto` prefers loopback; use `gateway.bind: "tailnet"` when you want a tailnet-only bind.

### Can I run multiple Gateways on the same host?

Usually no — one Gateway can run multiple messaging channels and agents. Use multiple Gateways only when you need redundancy (ex: rescue bot) or hard isolation.

Yes, but you must isolate:

- `CLAWDBOT_CONFIG_PATH` (per‑instance config)
- `CLAWDBOT_STATE_DIR` (per‑instance state)
- `agents.defaults.workspace` (workspace isolation)
- `gateway.port` (unique ports)

Quick setup (recommended):
- Use `clawdbot --profile <name> …` per instance (auto-creates `~/.clawdbot-<name>`).
- Set a unique `gateway.port` in each profile config (or pass `--port` for manual runs).
- Install a per-profile service: `clawdbot --profile <name> gateway install`.

Profiles also suffix service names (`com.clawdbot.<profile>`, `clawdbot-gateway-<profile>.service`, `Clawdbot Gateway (<profile>)`).
Full guide: [Multiple gateways](/gateway/multiple-gateways).

### What does “invalid handshake” / code 1008 mean?

The Gateway is a **WebSocket server**, and it expects the very first message to
be a `connect` frame. If it receives anything else, it closes the connection
with **code 1008** (policy violation).

Common causes:
- You opened the **HTTP** URL in a browser (`http://...`) instead of a WS client.
- You used the wrong port or path.
- A proxy or tunnel stripped auth headers or sent a non‑Gateway request.

Quick fixes:
1) Use the WS URL: `ws://<host>:18789` (or `wss://...` if HTTPS).
2) Don’t open the WS port in a normal browser tab.
3) If auth is on, include the token/password in the `connect` frame.

If you’re using the CLI or TUI, the URL should look like:
```
clawdbot tui --url ws://<host>:18789 --token <token>
```

Protocol details: [Gateway protocol](/gateway/protocol).

## Logging and debugging

### Where are logs?

File logs (structured):

```
/tmp/clawdbot/clawdbot-YYYY-MM-DD.log
```

You can set a stable path via `logging.file`. File log level is controlled by `logging.level`. Console verbosity is controlled by `--verbose` and `logging.consoleLevel`.

Fastest log tail:

```bash
clawdbot logs --follow
```

Service/supervisor logs (when the gateway runs via launchd/systemd):
- macOS: `$CLAWDBOT_STATE_DIR/logs/gateway.log` and `gateway.err.log` (default: `~/.clawdbot/logs/...`; profiles use `~/.clawdbot-<profile>/logs/...`)
- Linux: `journalctl --user -u clawdbot-gateway[-<profile>].service -n 200 --no-pager`
- Windows: `schtasks /Query /TN "Clawdbot Gateway (<profile>)" /V /FO LIST`

See [Troubleshooting](/gateway/troubleshooting#log-locations) for more.

### How do I start/stop/restart the Gateway service?

Use the gateway helpers:

```bash
clawdbot gateway status
clawdbot gateway restart
```

If you run the gateway manually, `clawdbot gateway --force` can reclaim the port. See [Gateway](/gateway).

### ELI5: `clawdbot gateway restart` vs `clawdbot gateway`

- `clawdbot gateway restart`: restarts the **background service** (launchd/systemd).
- `clawdbot gateway`: runs the gateway **in the foreground** for this terminal session.

If you installed the service, use the gateway commands. Use `clawdbot gateway` when
you want a one-off, foreground run.

### What’s the fastest way to get more details when something fails?

Start the Gateway with `--verbose` to get more console detail. Then inspect the log file for channel auth, model routing, and RPC errors.

## Media & attachments

### My skill generated an image/PDF, but nothing was sent

Outbound attachments from the agent must include a `MEDIA:<path-or-url>` line (on its own line). See [Clawdbot assistant setup](/start/clawd) and [Agent send](/tools/agent-send).

CLI sending:

```bash
clawdbot message send --target +15555550123 --message "Here you go" --media /path/to/file.png
```

Also check:
- The target channel supports outbound media and isn’t blocked by allowlists.
- The file is within the provider’s size limits (images are resized to max 2048px).

See [Images](/nodes/images).

## Security and access control

### Is it safe to expose Clawdbot to inbound DMs?

Treat inbound DMs as untrusted input. Defaults are designed to reduce risk:

- Default behavior on DM‑capable channels is **pairing**:
  - Unknown senders receive a pairing code; the bot does not process their message.
  - Approve with: `clawdbot pairing approve <channel> <code>`
  - Pending requests are capped at **3 per channel**; check `clawdbot pairing list <channel>` if a code didn’t arrive.
- Opening DMs publicly requires explicit opt‑in (`dmPolicy: "open"` and allowlist `"*"`).

Run `clawdbot doctor` to surface risky DM policies.

### Is prompt injection only a concern for public bots?

No. Prompt injection is about **untrusted content**, not just who can DM the bot.
If your assistant reads external content (web search/fetch, browser pages, emails,
docs, attachments, pasted logs), that content can include instructions that try
to hijack the model. This can happen even if **you are the only sender**.

The biggest risk is when tools are enabled: the model can be tricked into
exfiltrating context or calling tools on your behalf. Reduce the blast radius by:
- using a read-only or tool-disabled "reader" agent to summarize untrusted content
- keeping `web_search` / `web_fetch` / `browser` off for tool-enabled agents
- sandboxing and strict tool allowlists

Details: [Security](/gateway/security).

### Can I use cheaper models for personal assistant tasks?

Yes, **if** the agent is chat-only and the input is trusted. Smaller tiers are
more susceptible to instruction hijacking, so avoid them for tool-enabled agents
or when reading untrusted content. If you must use a smaller model, lock down
tools and run inside a sandbox. See [Security](/gateway/security).

### I ran `/start` in Telegram but didn’t get a pairing code

Pairing codes are sent **only** when an unknown sender messages the bot and
`dmPolicy: "pairing"` is enabled. `/start` by itself doesn’t generate a code.

Check pending requests:
```bash
clawdbot pairing list telegram
```

If you want immediate access, allowlist your sender id or set `dmPolicy: "open"`
for that account.

### WhatsApp: will it message my contacts? How does pairing work?

No. Default WhatsApp DM policy is **pairing**. Unknown senders only get a pairing code and their message is **not processed**. Clawdbot only replies to chats it receives or to explicit sends you trigger.

Approve pairing with:

```bash
clawdbot pairing approve whatsapp <code>
```

List pending requests:

```bash
clawdbot pairing list whatsapp
```

Wizard phone number prompt: it’s used to set your **allowlist/owner** so your own DMs are permitted. It’s not used for auto-sending. If you run on your personal WhatsApp number, use that number and enable `channels.whatsapp.selfChatMode`.

## Chat commands, aborting tasks, and “it won’t stop”

### How do I stop/cancel a running task?

Send any of these **as a standalone message** (no slash):

```
stop
abort
esc
wait
exit
interrupt
```

These are abort triggers (not slash commands).

For background processes (from the exec tool), you can ask the agent to run:

```
process action:kill sessionId:XXX
```

Slash commands overview: see [Slash commands](/tools/slash-commands).

Most commands must be sent as a **standalone** message that starts with `/`, but a few shortcuts (like `/status`) also work inline for allowlisted senders.

### Why does it feel like the bot “ignores” rapid‑fire messages?

Queue mode controls how new messages interact with an in‑flight run. Use `/queue` to change modes:

- `steer` — new messages redirect the current task
- `followup` — run messages one at a time
- `collect` — batch messages and reply once (default)
- `steer-backlog` — steer now, then process backlog
- `interrupt` — abort current run and start fresh

You can add options like `debounce:2s cap:25 drop:summarize` for followup modes.

## Answer the exact question from the screenshot/chat log

**Q: “What’s the default model for Anthropic with an API key?”**

**A:** In Clawdbot, credentials and model selection are separate. Setting `ANTHROPIC_API_KEY` (or storing an Anthropic API key in auth profiles) enables authentication, but the actual default model is whatever you configure in `agents.defaults.model.primary` (for example, `anthropic/claude-sonnet-4-5` or `anthropic/claude-opus-4-5`). If you see `No credentials found for profile "anthropic:default"`, it means the Gateway couldn’t find Anthropic credentials in the expected `auth-profiles.json` for the agent that’s running.

---

Still stuck? Ask in Discord or open a GitHub discussion.
