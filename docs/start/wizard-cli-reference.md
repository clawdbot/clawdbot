---
summary: "Step-by-step behavior for openclaw onboard: what each step does, config it writes, and internals"
read_when:
  - You need detailed behavior for a specific openclaw onboard step
  - You are debugging onboarding results or integrating onboarding clients
title: "CLI setup reference"
sidebarTitle: "CLI reference"
---

This page covers step-by-step onboarding behavior, outputs, and internals.
For a walkthrough, see [Onboarding (CLI)](/start/wizard). For the full CLI flag
reference (every `--flag`, non-interactive examples, provider-specific
commands), see [`openclaw onboard`](/cli/onboard).

## What the wizard does

Local mode (default) walks you through:

- Model and auth setup (Anthropic, OpenAI Code subscription OAuth, xAI, OpenCode, custom endpoints, and more provider-owned auth flows)
- Workspace location and bootstrap files
- Gateway settings (port, bind, auth, Tailscale)
- Channels and providers (Discord, Feishu, Google Chat, iMessage, Mattermost, Microsoft Teams, QQ Bot, Signal, Slack, Telegram, WhatsApp, and other bundled or plugin channels)
- Web search provider (optional)
- Daemon install (LaunchAgent, systemd user unit, or native Windows Scheduled Task with Startup-folder fallback)
- Health check
- Skills setup

Remote mode configures this machine to connect to a Gateway elsewhere. It does
not install or modify anything on the remote host.

## Local flow details

<Steps>
  <Step title="Existing config detection">
    - If `~/.openclaw/openclaw.json` exists, choose **Keep current values**, **Review and update**, or **Reset before setup**.
    - Re-running the wizard does not wipe anything unless you explicitly choose Reset (or pass `--reset`).
    - CLI `--reset` defaults to `config+creds+sessions`; use `--reset-scope full` to also remove the workspace.
    - If config is invalid or contains legacy keys, the wizard stops and asks you to run `openclaw doctor` before continuing.
    - Reset moves state to Trash (never deletes directly) and offers scopes:
      - Config only
      - Config + credentials + sessions
      - Full reset (also removes the workspace)

  </Step>
  <Step title="Model and auth">
    - Full option matrix is in [Auth and model options](#auth-and-model-options).

  </Step>
  <Step title="Workspace">
    - Default `~/.openclaw/workspace` (configurable).
    - Seeds workspace files needed for first-run bootstrap.
    - On rerun, an existing agent roster keeps its fleet-wide workspace unless
      you explicitly confirm the move. Non-interactive reruns warn and preserve
      the current value.
    - Workspace layout: [Agent workspace](/concepts/agent-workspace).

  </Step>
  <Step title="Gateway">
    - Prompts for port, bind, auth mode, and Tailscale exposure.
    - Recommended: keep token auth enabled even for loopback so local WS clients must authenticate.
    - In token mode, interactive setup offers:
      - **Generate/store plaintext token** (default)
      - **Use SecretRef** (opt-in)
    - In password mode, interactive setup also supports plaintext or SecretRef storage.
    - Non-interactive token SecretRef path: `--gateway-token-ref-env <ENV_VAR>`.
      - Requires a non-empty env var in the onboarding process environment.
      - Cannot be combined with `--gateway-token`.
    - Disable auth only if you fully trust every local process.
    - Non-loopback binds still require auth.

  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): optional QR login
    - [Telegram](/channels/telegram): bot token
    - [Discord](/channels/discord): bot token
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience
    - [Mattermost](/channels/mattermost): bot token + base URL
    - [Signal](/channels/signal): optional `signal-cli` install + account config
    - [iMessage](/channels/imessage): `imsg` CLI path + Messages DB access; use an SSH wrapper when the Gateway runs off-Mac
    - DM security: default is pairing. First DM sends a code; approve via
      `openclaw pairing approve <channel> <code>` or use allowlists.
  </Step>
  <Step title="Web search">
    - Pick a provider (Brave, DuckDuckGo, Exa, Firecrawl, Gemini, Grok, Kimi, MiniMax Search, Ollama Web Search, Perplexity, SearXNG, Tavily) or skip.
    - Skip this step with `--skip-search`; reconfigure later with `openclaw configure --section web`.

  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - Requires logged-in user session; for headless, use a custom LaunchDaemon (not shipped).
    - Linux and Windows via WSL2: systemd user unit
      - Wizard attempts `loginctl enable-linger <user>` so gateway stays up after logout.
      - May prompt for sudo (writes `/var/lib/systemd/linger`); it tries without sudo first.
    - Native Windows: Scheduled Task first
      - If task creation is denied, OpenClaw falls back to a per-user Startup-folder login item and starts the gateway immediately.
      - Scheduled Tasks remain preferred because they provide better supervisor status.
    - Runtime selection: Node is required because OpenClaw's canonical runtime state store uses `node:sqlite`.

  </Step>
  <Step title="Health check">
    - Starts gateway (if needed) and runs `openclaw health`.
    - `openclaw status --deep` adds the live gateway health probe to status output, including channel probes when supported.

  </Step>
  <Step title="Skills">
    - Reads available skills and checks requirements.
    - Lets you choose node manager: npm, pnpm, or bun.
    - Installs optional dependencies for trusted bundled skills when the required
      installer is available.
    - Skips unavailable Homebrew, uv, and Go installers, then groups the affected
      skills with manual setup guidance. Run `openclaw doctor` after installing
      the missing prerequisites.

  </Step>
  <Step title="Finish">
    - Summary and next steps, including iOS, Android, and macOS app options.

  </Step>
</Steps>

<Note>
If no GUI is detected, the wizard prints SSH port-forward instructions for the Control UI instead of opening a browser.
If Control UI assets are missing, the wizard attempts to build them; fallback is `pnpm ui:build` (auto-installs UI deps).
</Note>

## Remote mode details

Remote mode configures this machine to connect to a Gateway elsewhere. It does
not install or modify anything on the remote host.

What you set:

- Remote gateway URL (`ws://...` or `wss://...`)
- Token, password, or no auth, matching the remote Gateway's configuration

<Steps>
  <Step title="Discovery (optional)">
    If `dns-sd` (macOS) or `avahi-browse` (Linux) is available, onboarding
    offers to search for Bonjour/mDNS gateway beacons before falling back to
    manual URL entry. Wide-area DNS-SD discovery is also attempted when
    configured. Docs: [Gateway discovery](/gateway/discovery), [Bonjour](/gateway/bonjour).
  </Step>
  <Step title="Connection method">
    When a beacon is selected, choose direct WebSocket or an SSH tunnel:
    - **Direct**: connects over `wss://` and prompts to trust the discovered
      TLS fingerprint (trust-on-first-use pinning; only pinned if you accept).
    - **SSH tunnel**: prints an `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
      command to run first, then connects to the local tunnel endpoint.
  </Step>
  <Step title="Auth">
    Choose token (recommended), password, or no auth, then optionally store it
    as a SecretRef instead of plaintext.
  </Step>
</Steps>

<Note>
If the gateway is loopback-only and not discoverable, use SSH tunneling or a tailnet manually.
Plaintext `ws://` is accepted for loopback, private IP literals, `.local`, and Tailnet `*.ts.net` URLs; other private-DNS names need `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1`.
</Note>

## Auth and model options

If a provider setup step fails in interactive onboarding (for example a CLI reuse option
without a local sign-in), the wizard shows the error and returns to the provider picker
instead of exiting. Explicit `--auth-choice` runs still fail fast for automation.

<AccordionGroup>
  <Accordion title="Anthropic API key">
    Uses `ANTHROPIC_API_KEY` if present or prompts for a key, then saves it for daemon use.
  </Accordion>
  <Accordion title="Anthropic Claude CLI">
    Preferred local path in interactive onboarding/configure; reuses an existing Claude CLI sign-in when available.
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    Browser flow; paste `code#state`.

    On a fresh setup with no primary model, sets `agents.defaults.model` to
    `openai/gpt-5.6-sol` through the Codex runtime.

  </Accordion>
  <Accordion title="OpenAI Code subscription (device pairing)">
    Browser pairing flow with a short-lived device code.

    On a fresh setup with no primary model, sets `agents.defaults.model` to
    `openai/gpt-5.6-sol` through the Codex runtime.

  </Accordion>
  <Accordion title="OpenAI API key">
    Uses `OPENAI_API_KEY` if present or prompts for a key, then stores the credential in auth profiles.

    On a fresh setup with no primary model, sets `agents.defaults.model` to
    `openai/gpt-5.6`; the bare direct-API model id resolves to the Sol tier.

    Adding or reauthenticating OpenAI preserves an existing explicit primary
    model, including `openai/gpt-5.5`. If the account does not expose GPT-5.6,
    select `openai/gpt-5.5` explicitly; OpenClaw does not silently downgrade it.

  </Accordion>
  <Accordion title="xAI (Grok) OAuth">
    Browser sign-in for eligible SuperGrok or X Premium accounts. This is the
    recommended xAI path for most users. OpenClaw stores the resulting auth
    profile for Grok models, Grok `web_search`, `x_search`, and `code_execution`.
  </Accordion>
  <Accordion title="xAI (Grok) device code">
    Remote-friendly browser sign-in with a short code instead of a localhost
    callback. Use this from SSH, Docker, or VPS hosts.
  </Accordion>
  <Accordion title="xAI (Grok) API key">
    Prompts for `XAI_API_KEY` and configures xAI as a model provider. Use this
    when you want an xAI Console API key instead of subscription OAuth.
  </Accordion>
  <Accordion title="OpenCode">
    Prompts for `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`) and lets you choose the Zen or Go catalog (one API key covers both).
    Setup URL: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">
    Stores the key for you.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    Prompts for `AI_GATEWAY_API_KEY`.
    More detail: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Prompts for account ID, gateway ID, and `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    More detail: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax">
    Config is auto-written. Hosted default is `MiniMax-M3`; API-key setup uses
    `minimax/...`, and OAuth setup uses `minimax-portal/...`.
    More detail: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="StepFun">
    Config is auto-written for StepFun standard or Step Plan on China or global endpoints.
    Standard currently includes `step-3.5-flash`, and Step Plan also includes `step-3.5-flash-2603`.
    More detail: [StepFun](/providers/stepfun).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    Prompts for `SYNTHETIC_API_KEY`.
    More detail: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Ollama (Cloud and local open models)">
    Prompts for `Cloud + Local`, `Cloud only`, or `Local only` first.
    `Cloud only` uses `OLLAMA_API_KEY` with `https://ollama.com`.
    The host-backed modes prompt for base URL (default `http://127.0.0.1:11434`), discover available models, and suggest defaults.
    `Cloud + Local` also checks whether that Ollama host is signed in for cloud access.
    More detail: [Ollama](/providers/ollama).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    Moonshot (Kimi K2) and Kimi Coding configs are auto-written.
    More detail: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Custom provider">
    Works with OpenAI-compatible, OpenAI Responses-compatible, and Anthropic-compatible endpoints.

    Interactive onboarding supports the same API key storage choices as other provider API key flows:
    - **Paste API key now** (plaintext)
    - **Use secret reference** (env ref or configured provider ref, with preflight validation)

    Onboarding infers image support for common vision model IDs (GPT-4o/4.1/5.x, Claude 3/4, Gemini, Qwen-VL, LLaVA, Pixtral, and similar) and only asks when the model name is unknown.

    Non-interactive flags:
    - `--auth-choice custom-api-key`
    - `--custom-base-url`
    - `--custom-model-id`
    - `--custom-api-key` (optional; falls back to `CUSTOM_API_KEY`)
    - `--custom-provider-id` (optional)
    - `--custom-compatibility <openai|openai-responses|anthropic>` (optional; default `openai`)
    - `--custom-image-input` / `--custom-text-input` (optional; override inferred model input capability)

  </Accordion>
  <Accordion title="Skip">
    Leaves auth unconfigured.
  </Accordion>
</AccordionGroup>

Model behavior:

- Pick default model from detected options, or enter provider and model manually.
- When onboarding starts from a provider auth choice, the model picker prefers
  that provider automatically. For Volcengine and BytePlus, the same preference
  also matches their coding-plan variants (`volcengine-plan/*`,
  `byteplus-plan/*`).
- If that preferred-provider filter would be empty, the picker falls back to
  the full catalog instead of showing no models.
- Wizard runs a model check and warns if the configured model is unknown or missing auth.

Credential and profile paths:

- Auth profiles (API keys + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Legacy OAuth import: `~/.openclaw/credentials/oauth.json`

Credential storage mode:

- Default onboarding behavior persists API keys as plaintext values in auth profiles.
- `--secret-input-mode ref` enables reference mode instead of plaintext key storage.
  In interactive setup, you can choose either:
  - environment variable ref (for example `keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" }`)
  - configured provider ref (`file` or `exec`) with provider alias + id
- Interactive reference mode runs a fast preflight validation before saving.
  - Env refs: validates variable name + non-empty value in the current onboarding environment.
  - Provider refs: validates provider config and resolves the requested id.
  - If preflight fails, onboarding shows the error and lets you retry.
- In non-interactive mode, `--secret-input-mode ref` is env-backed only.
  - Set the provider env var in the onboarding process environment.
  - Inline key flags (for example `--openai-api-key`) require that env var to be set; otherwise onboarding fails fast.
  - For custom providers, non-interactive `ref` mode stores `models.providers.<id>.apiKey` as `{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }`.
  - In that custom-provider case, `--custom-api-key` requires `CUSTOM_API_KEY` to be set; otherwise onboarding fails fast.
- Gateway auth credentials support plaintext and SecretRef choices in interactive setup:
  - Token mode: **Generate/store plaintext token** (default) or **Use SecretRef**.
  - Password mode: plaintext or SecretRef.
- Non-interactive token SecretRef path: `--gateway-token-ref-env <ENV_VAR>`.
- Existing plaintext setups continue to work unchanged.

<Note>
Headless and server tip: complete OAuth on a machine with a browser, then copy
that agent's `auth-profiles.json` (for example
`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`, or the matching
`$OPENCLAW_STATE_DIR/...` path) to the gateway host. `credentials/oauth.json`
is only a legacy import source.
</Note>

## Outputs and internals

Typical fields in `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.skipBootstrap` when `--skip-bootstrap` is passed
- `agents.defaults.model` / `models.providers` (if Minimax chosen)
- `tools.profile` (local onboarding defaults to `"coding"` when unset; existing explicit values are preserved)
- `gateway.*` (mode, bind, auth, tailscale)
- `session.dmScope` (onboarding preserves explicit values and otherwise leaves it unset, so the `main` default keeps all direct messages across channels in the agent's rolling main session—the personal-agent default. For shared or multi-user inboxes, use `per-channel-peer`; `openclaw security audit` recommends isolation when it detects multi-user DM traffic)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.matrix.*`, `channels.signal.*`, `channels.imessage.*`
- Channel allowlists (Discord, iMessage, Signal, Slack, Telegram, WhatsApp) when you opt in during prompts; Discord and Slack also resolve entered names to IDs
- `skills.install.nodeManager`
  - The `setup --node-manager` flag accepts `npm`, `pnpm`, or `bun`.
  - Manual config can still set `skills.install.nodeManager: "yarn"` later.
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`
- `wizard.securityAcknowledgedAt`

`openclaw agents add` writes `agents.list[]` and optional `bindings`.

WhatsApp credentials go under `~/.openclaw/credentials/whatsapp/<accountId>/`.
Active sessions and transcripts are stored in
`~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`. The
`~/.openclaw/agents/<agentId>/sessions/` directory is used for legacy migration
inputs and archive/support artifacts.

<Note>
Some channels are delivered as plugins. When selected during setup, the wizard
prompts to install the plugin (npm or local path) before channel configuration.
</Note>

### Installed app recommendations

After the model access check succeeds, classic interactive onboarding on macOS scans application names and bundle IDs without requesting macOS privacy permissions. It searches the official plugin catalogs and ClawHub, then asks the configured model to reject false name matches and recommend relevant plugins or skills. Recommended matches are selected by default; optional matches require an explicit selection.

The results screen lists the detected applications and shows: "App names were matched using your configured model and ClawHub search." Set `wizard.appRecommendations` to `false` to disable both this onboarding step and Gateway access to node app inventories. The scan is not used in quickstart or non-macOS onboarding.

## Non-interactive setup

`--non-interactive` requires `--accept-risk` (acknowledges that agents are
powerful and full system access is risky):

```bash
openclaw onboard --non-interactive --accept-risk \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY"
```

Full flag reference and provider-specific examples: [`openclaw onboard`](/cli/onboard), [CLI automation](/start/wizard-cli-automation).

## Gateway wizard RPC

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

Clients (macOS app and Control UI) can render steps without re-implementing onboarding logic.

## Signal setup behavior

- Downloads the appropriate release asset from the official `signal-cli` GitHub releases (native build, Linux x86-64 only)
- On other platforms (macOS, non-x64 Linux), installs via Homebrew instead
- Stores the release-asset install under `~/.openclaw/tools/signal-cli/<version>/`
- Writes `channels.signal.cliPath` in config
- Native Windows is not supported yet; run onboarding inside WSL2 to get the Linux install path

## Related docs

- Onboarding hub: [Onboarding (CLI)](/start/wizard)
- Automation and scripts: [CLI Automation](/start/wizard-cli-automation)
- Command reference: [`openclaw onboard`](/cli/onboard)
