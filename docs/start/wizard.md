---
summary: "CLI onboarding wizard: guided setup for gateway, workspace, channels, and skills"
read_when:
  - Running or configuring the onboarding wizard
  - Setting up a new machine
---

# Onboarding Wizard (CLI)

The onboarding wizard is the **recommended** way to set up Clawdbot on macOS,
Linux, or Windows (via WSL2; strongly recommended).
It configures a local Gateway or a remote Gateway connection, plus channels, skills,
and workspace defaults in one guided flow.

Primary entrypoint:

```bash
clawdbot onboard
```

Follow‑up reconfiguration:

```bash
clawdbot configure
```

## QuickStart vs Advanced

The wizard starts with **QuickStart** (defaults) vs **Advanced** (full control).

**QuickStart** keeps the defaults:
- Local gateway (loopback)
- Workspace default (or existing workspace)
- Gateway port **18789**
- Gateway auth **Token** (auto‑generated, even on loopback)
- Tailscale exposure **Off**
- Telegram + WhatsApp DMs default to **allowlist** (you’ll be prompted for your phone number)

**Advanced** exposes every step (mode, workspace, gateway, channels, daemon, skills).

## What the wizard does

**Local mode (default)** walks you through:
- Model/auth (OpenAI Code (Codex) subscription OAuth, Anthropic API key (recommended) or `claude setup-token`, plus MiniMax/GLM/Moonshot options)
- Workspace location + bootstrap files
- Gateway settings (port/bind/auth/tailscale)
- Providers (Telegram, WhatsApp, Discord, Signal)
- Daemon install (LaunchAgent / systemd user unit)
- Health check
- Skills (recommended)

**Remote mode** only configures the local client to connect to a Gateway elsewhere.
It does **not** install or change anything on the remote host.

To add more isolated agents (separate workspace + sessions + auth), use:

```bash
clawdbot agents add <name>
```

Tip: `--json` does **not** imply non-interactive mode. Use `--non-interactive` (and `--workspace`) for scripts.

## Flow details (local)

1) **Existing config detection**
   - If `~/.clawdbot/clawdbot.json` exists, choose **Keep / Modify / Reset**.
   - If the config is invalid or contains legacy keys, the wizard stops and asks
     you to run `clawdbot doctor` before continuing.
   - Reset uses `trash` (never `rm`) and offers scopes:
     - Config only
     - Config + credentials + sessions
     - Full reset (also removes workspace)

2) **Model/Auth**
   - **Anthropic API key (recommended)**: uses `ANTHROPIC_API_KEY` if present or prompts for a key, then saves it for daemon use.
   - **Anthropic token (setup-token)**: run `claude setup-token` on the gateway host (the wizard can run it for you and reuse the token).
   - **Anthropic OAuth (Claude CLI)**: on macOS the wizard checks Keychain item "Claude Code-credentials" (choose "Always Allow" so launchd starts don't block); on Linux/Windows it reuses `~/.claude/.credentials.json` if present.
   - **Anthropic token (paste setup-token)**: run `claude setup-token` in your terminal, then paste the token (you can name it; blank = default).
   - **OpenAI Code (Codex) subscription (Codex CLI)**: if `~/.codex/auth.json` exists, the wizard can reuse it.
   - **OpenAI Code (Codex) subscription (OAuth)**: browser flow; paste the `code#state`.
     - Sets `agents.defaults.model` to `openai-codex/gpt-5.2` when model is unset or `openai/*`.
   - **OpenAI API key**: uses `OPENAI_API_KEY` if present or prompts for a key, then saves it to `~/.clawdbot/.env` so launchd can read it.
   - **OpenCode Zen (multi-model proxy)**: prompts for `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`, get it at https://opencode.ai/auth).
   - **API key**: stores the key for you.
   - **MiniMax M2.1**: config is auto-written.
   - More detail: [MiniMax](/providers/minimax)
   - **Synthetic (Anthropic-compatible)**: prompts for `SYNTHETIC_API_KEY`.
   - More detail: [Synthetic](/providers/synthetic)
   - **Moonshot (Kimi K2)**: config is auto-written.
   - More detail: [Moonshot AI](/providers/moonshot)
   - **Skip**: no auth configured yet.
   - Pick a default model from detected options (or enter provider/model manually).
   - Wizard runs a model check and warns if the configured model is unknown or missing auth.
  - OAuth credentials live in `~/.clawdbot/credentials/oauth.json`; auth profiles live in `~/.clawdbot/agents/<agentId>/agent/auth-profiles.json` (API keys + OAuth).
   - More detail: [/concepts/oauth](/concepts/oauth)

3) **Workspace**
   - Default `~/clawd` (configurable).
   - Seeds the workspace files needed for the agent bootstrap ritual.
   - Full workspace layout + backup guide: [Agent workspace](/concepts/agent-workspace)

4) **Gateway**
   - Port, bind, auth mode, tailscale exposure.
   - Auth recommendation: keep **Token** even for loopback so local WS clients must authenticate.
   - Disable auth only if you fully trust every local process.
   - Non‑loopback binds still require auth.

5) **Channels**
   - WhatsApp: optional QR login.
   - Telegram: bot token.
   - Discord: bot token.
   - Signal: optional `signal-cli` install + account config.
   - iMessage: local `imsg` CLI path + DB access.
  - DM security: default is pairing. First DM sends a code; approve via `clawdbot pairing approve <channel> <code>` or use allowlists.

6) **Daemon install**
   - macOS: LaunchAgent
     - Requires a logged-in user session; for headless, use a custom LaunchDaemon (not shipped).
   - Linux (and Windows via WSL2): systemd user unit
     - Wizard attempts to enable lingering via `loginctl enable-linger <user>` so the Gateway stays up after logout.
     - May prompt for sudo (writes `/var/lib/systemd/linger`); it tries without sudo first.
   - **Runtime selection:** Node (recommended; required for WhatsApp/Telegram). Bun is **not recommended**.

7) **Health check**
   - Starts the Gateway (if needed) and runs `clawdbot health`.
   - Tip: `clawdbot status --deep` adds gateway health probes to status output (requires a reachable gateway).

8) **Skills (recommended)**
   - Reads the available skills and checks requirements.
   - Lets you choose a node manager: **npm / pnpm** (bun not recommended).
   - Installs optional dependencies (some use Homebrew on macOS).

9) **Finish**
   - Summary + next steps, including iOS/Android/macOS apps for extra features.
  - If no GUI is detected, the wizard prints SSH port-forward instructions for the Control UI instead of opening a browser.
  - If the Control UI assets are missing, the wizard attempts to build them; fallback is `pnpm ui:build` (auto-installs UI deps).

## Remote mode

Remote mode configures a local client to connect to a Gateway elsewhere.

What you’ll set:
- Remote Gateway URL (`ws://...`)
- Token if the remote Gateway requires auth (recommended)

Notes:
- No remote installs or daemon changes are performed.
- If the Gateway is loopback‑only, use SSH tunneling or a tailnet.
- Discovery hints:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)

## Add another agent

Use `clawdbot agents add <name>` to create a separate agent with its own workspace,
sessions, and auth profiles. Running without `--workspace` launches the wizard.

What it sets:
- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Notes:
- Default workspaces follow `~/clawd-<agentId>`.
- Add `bindings` to route inbound messages (the wizard can do this).
- Non-interactive flags: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Non‑interactive mode

Use `--non-interactive` to automate or script onboarding:

```bash
clawdbot onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

Add `--json` for a machine‑readable summary.

Gemini example:

```bash
clawdbot onboard --non-interactive \
  --mode local \
  --auth-choice gemini-api-key \
  --gemini-api-key "$GEMINI_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback
```

Z.AI example:

```bash
clawdbot onboard --non-interactive \
  --mode local \
  --auth-choice zai-api-key \
  --zai-api-key "$ZAI_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback
```

Moonshot example:

```bash
clawdbot onboard --non-interactive \
  --mode local \
  --auth-choice moonshot-api-key \
  --moonshot-api-key "$MOONSHOT_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback
```

Synthetic example:

```bash
clawdbot onboard --non-interactive \
  --mode local \
  --auth-choice synthetic-api-key \
  --synthetic-api-key "$SYNTHETIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback
```

OpenCode Zen example:

```bash
clawdbot onboard --non-interactive \
  --mode local \
  --auth-choice opencode-zen \
  --opencode-zen-api-key "$OPENCODE_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback
```

Add agent (non‑interactive) example:

```bash
clawdbot agents add work \
  --workspace ~/clawd-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway wizard RPC

The Gateway exposes the wizard flow over RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Clients (macOS app, Control UI) can render steps without re‑implementing onboarding logic.

## Signal setup (signal-cli)

The wizard can install `signal-cli` from GitHub releases:
- Downloads the appropriate release asset.
- Stores it under `~/.clawdbot/tools/signal-cli/<version>/`.
- Writes `channels.signal.cliPath` to your config.

Notes:
- JVM builds require **Java 21**.
- Native builds are used when available.
- Windows uses WSL2; signal-cli install follows the Linux flow inside WSL.

## What the wizard writes

Typical fields in `~/.clawdbot/clawdbot.json`:
- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (if Minimax chosen)
- `gateway.*` (mode, bind, auth, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`clawdbot agents add` writes `agents.list[]` and optional `bindings`.

WhatsApp credentials go under `~/.clawdbot/credentials/whatsapp/<accountId>/`.
Sessions are stored under `~/.clawdbot/agents/<agentId>/sessions/`.

## Related docs

- macOS app onboarding: [Onboarding](/start/onboarding)
- Config reference: [Gateway configuration](/gateway/configuration)
- Providers: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Signal](/channels/signal), [iMessage](/channels/imessage)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
