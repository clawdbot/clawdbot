---
summary: "CLI onboarding wizard: guided setup for gateway, workspace, providers, and skills"
read_when:
  - Running or configuring the onboarding wizard
  - Setting up a new machine
---

# Onboarding Wizard (CLI)

The onboarding wizard is the **recommended** way to set up Clawdbot on any OS.
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

## What the wizard does

**Local mode (default)** walks you through:
- Model/auth (Anthropic or OpenAI Codex OAuth recommended, API key optional, Minimax M2.1 via LM Studio)
- Workspace location + bootstrap files
- Gateway settings (port/bind/auth/tailscale)
- Providers (WhatsApp, Telegram, Discord, Signal)
- Daemon install (LaunchAgent / systemd user unit / Scheduled Task)
- Health check
- Skills (recommended)

**Remote mode** only configures the local client to connect to a Gateway elsewhere.
It does **not** install or change anything on the remote host.

## Flow details (local)

1) **Existing config detection**
   - If `~/.clawdbot/clawdbot.json` exists, choose **Keep / Modify / Reset**.
   - Reset uses `trash` (never `rm`) and offers scopes:
     - Config only
     - Config + credentials + sessions
     - Full reset (also removes workspace)

2) **Model/Auth**
   - **Anthropic OAuth (recommended)**: browser flow; paste the `code#state`.
   - **OpenAI Codex OAuth**: browser flow; paste the `code#state`.
     - Sets `agent.model` to `openai-codex/gpt-5.2` when model is unset or `openai/*`.
   - **API key**: stores the key for you.
   - **Minimax M2.1 (LM Studio)**: config is auto‑written for the LM Studio endpoint.
   - **Skip**: no auth configured yet.
   - Wizard runs a model check and warns if the configured model is unknown or missing auth.
   - OAuth credentials live in `~/.clawdbot/credentials/oauth.json`; auth profiles live in `~/.clawdbot/agent/auth-profiles.json` (API keys + OAuth).

3) **Workspace**
   - Default `~/clawd` (configurable).
   - Seeds the workspace files needed for the agent bootstrap ritual.

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

6) **Daemon install**
   - macOS: LaunchAgent
     - Requires a logged-in user session; for headless, use a custom LaunchDaemon (not shipped).
   - Linux: systemd user unit
     - Wizard attempts to enable lingering via `loginctl enable-linger <user>` so the Gateway stays up after logout.
     - May prompt for sudo (writes `/var/lib/systemd/linger`); it tries without sudo first.
   - Windows: Scheduled Task
     - Runs on user logon; headless/system services are not configured by default.

7) **Health check**
   - Starts the Gateway (if needed) and runs `clawdbot health`.

8) **Skills (recommended)**
   - Reads the available skills and checks requirements.
   - Lets you choose a node manager: **npm / pnpm / bun**.
   - Installs optional dependencies (some use Homebrew on macOS).

9) **Finish**
   - Summary + next steps, including iOS/Android/macOS apps for extra features.
   - If no GUI is detected, the wizard prints SSH port-forward instructions for the Control UI instead of opening a browser.

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

## Non‑interactive mode

Use `--non-interactive` to automate or script onboarding:

```bash
clawdbot onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --skip-skills
```

Add `--json` for a machine‑readable summary.

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
- Windows auto‑install is not supported yet (manual install required).

## What the wizard writes

Typical fields in `~/.clawdbot/clawdbot.json`:
- `agent.workspace`
- `agent.model` / `models.providers` (if Minimax chosen)
- `gateway.*` (mode, bind, auth, tailscale)
- `telegram.botToken`, `discord.token`, `signal.*`, `imessage.*`
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

WhatsApp credentials go to `~/.clawdbot/credentials/`.
Sessions are stored under `~/.clawdbot/sessions/`.

## Related docs

- macOS app onboarding: `docs/onboarding.md`
- Config reference: `docs/configuration.md`
- Providers: `docs/whatsapp.md`, `docs/telegram.md`, `docs/discord.md`, `docs/signal.md`, `docs/imessage.md`
- Skills: `docs/skills.md`, `docs/skills-config.md`
