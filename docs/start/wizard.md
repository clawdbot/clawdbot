---
summary: "CLI onboarding wizard: guided setup for gateway, workspace, providers, and skills"
read_when:
  - Running or configuring the onboarding wizard
  - Setting up a new machine
---

# Onboarding Wizard (CLI)

The onboarding wizard is the **recommended** way to set up Clawdbot on macOS,
Linux, or Windows (via WSL2; strongly recommended).
It configures a local Gateway or a remote Gateway connection, plus providers, skills,
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
- Gateway auth **Off** (loopback only)
- Tailscale exposure **Off**
- Telegram + WhatsApp DMs default to **allowlist** (you’ll be prompted for your phone number)

**Advanced** exposes every step (mode, workspace, gateway, providers, daemon, skills).

## What the wizard does

**Local mode (default)** walks you through:
- Model/auth (Anthropic or OpenAI Codex OAuth recommended, API key optional, Minimax M2.1 via LM Studio)
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
   - Reset uses `trash` (never `rm`) and offers scopes:
     - Config only
     - Config + credentials + sessions
     - Full reset (also removes workspace)

2) **Model/Auth**
   - **Preferred Anthropic setup:** install Claude CLI on the gateway host and run `claude setup-token` (the wizard can run it for you and reuse the token).
   - **Anthropic OAuth (Claude CLI)**: on macOS the wizard checks Keychain item "Claude Code-credentials" (choose "Always Allow" so launchd starts don't block); on Linux/Windows it reuses `~/.claude/.credentials.json` if present.
   - **Anthropic token (paste setup-token)**: run `claude setup-token` in your terminal, then paste the token (you can name it; blank = default).
   - **OpenAI Codex OAuth (Codex CLI)**: if `~/.codex/auth.json` exists, the wizard can reuse it.
   - **OpenAI Codex OAuth**: browser flow; paste the `code#state`.
     - Sets `agents.defaults.model` to `openai-codex/gpt-5.2` when model is unset or `openai/*`.
   - **OpenAI API key**: uses `OPENAI_API_KEY` if present or prompts for a key, then saves it to `~/.clawdbot/.env` so launchd can read it.
   - **API key**: stores the key for you.
   - **Minimax M2.1 (LM Studio)**: config is auto‑written for the LM Studio endpoint.
   - **Skip**: no auth configured yet.
   - Wizard runs a model check and warns if the configured model is unknown or missing auth.
  - OAuth credentials live in `~/.clawdbot/credentials/oauth.json`; auth profiles live in `~/.clawdbot/agents/<agentId>/agent/auth-profiles.json` (API keys + OAuth).
   - More detail: [/concepts/oauth](/concepts/oauth)

3) **Workspace**
   - Default `~/clawd` (configurable).
   - Seeds the workspace files needed for the agent bootstrap ritual.
   - Full workspace layout + backup guide: [`docs/agent-workspace.md`](/concepts/agent-workspace)

4) **Gateway**
   - Port, bind, auth mode, tailscale exposure.
   - Auth recommendation: keep **Off** for single-machine loopback setups. Use **Token** for multi-machine access or non-loopback binds.
   - Non‑loopback binds require auth.

5) **Providers**
   - WhatsApp: optional QR login.
   - Telegram: bot token.
   - Discord: bot token.
   - Signal: optional `signal-cli` install + account config.
   - iMessage: local `imsg` CLI path + DB access.
  - DM security: default is pairing. First DM sends a code; approve via `clawdbot pairing approve --provider <provider> <code>` or use allowlists.

6) **Daemon install**
   - macOS: LaunchAgent
     - Requires a logged-in user session; for headless, use a custom LaunchDaemon (not shipped).
   - Linux (and Windows via WSL2): systemd user unit
     - Wizard attempts to enable lingering via `loginctl enable-linger <user>` so the Gateway stays up after logout.
     - May prompt for sudo (writes `/var/lib/systemd/linger`); it tries without sudo first.
   - **Runtime selection:** Node (recommended; required for WhatsApp) or Bun (faster, but incompatible with WhatsApp).

7) **Health check**
   - Starts the Gateway (if needed) and runs `clawdbot health`.
   - Tip: `clawdbot status --deep` runs local provider probes without a gateway.

8) **Skills (recommended)**
   - Reads the available skills and checks requirements.
   - Lets you choose a node manager: **npm / pnpm / bun**.
   - Installs optional dependencies (some use Homebrew on macOS).

9) **Finish**
   - Summary + next steps, including iOS/Android/macOS apps for extra features.
  - If no GUI is detected, the wizard prints SSH port-forward instructions for the Control UI instead of opening a browser.
  - If the Control UI assets are missing, the wizard attempts to build them; fallback is `pnpm ui:build` (auto-installs UI deps).

## Remote mode

Remote mode configures a local client to connect to a Gateway elsewhere.

What you’ll set:
- Remote Gateway URL (`ws://...`)
- Optional token

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
- Writes `signal.cliPath` to your config.

Notes:
- JVM builds require **Java 21**.
- Native builds are used when available.
- Windows uses WSL2; signal-cli install follows the Linux flow inside WSL.

## What the wizard writes

Typical fields in `~/.clawdbot/clawdbot.json`:
- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (if Minimax chosen)
- `gateway.*` (mode, bind, auth, tailscale)
- `telegram.botToken`, `discord.token`, `signal.*`, `imessage.*`
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

- macOS app onboarding: [`docs/onboarding.md`](/start/onboarding)
- Config reference: [`docs/configuration.md`](/gateway/configuration)
- Providers: [`docs/whatsapp.md`](/providers/whatsapp), [`docs/telegram.md`](/providers/telegram), [`docs/discord.md`](/providers/discord), [`docs/signal.md`](/providers/signal), [`docs/imessage.md`](/providers/imessage)
- Skills: [`docs/skills.md`](/tools/skills), [`docs/skills-config.md`](/tools/skills-config)
