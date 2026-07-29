---
summary: "Full reference for CLI onboarding: every step, flag, and config field"
read_when:
  - Looking up a specific onboarding step or flag
  - Automating onboarding with non-interactive mode
  - Debugging onboarding behavior
title: "Onboarding reference"
sidebarTitle: "Onboarding Reference"
---

This is the full reference for `openclaw onboard`.
For a high-level overview, see [Onboarding (CLI)](/start/wizard). For step-by-step
behavior and outputs, see [CLI setup reference](/start/wizard-cli-reference).

## Flow details (local mode)

<Steps>
  <Step title="Reset (optional)">
    - `--reset` resets state before setup runs; without it, re-running onboarding
      keeps existing config and reuses it as defaults.
    - `--reset-scope` controls what `--reset` removes: `config` (config file
      only), `config+creds+sessions` (default), or `full` (also removes the
      workspace).
    - If the config file is invalid, onboarding stops and tells you to run
      `openclaw doctor` first, then re-run setup.
    - Reset moves state to Trash (never deletes directly).

  </Step>
  <Step title="Risk acknowledgement">
    - First run (or any run before `wizard.securityAcknowledgedAt` is set)
      asks you to confirm you understand that agents are powerful and full
      system access is risky.
    - `--non-interactive` requires `--accept-risk` explicitly; without it,
      onboarding exits with an error instead of prompting.
    - Interactive runs get a confirm prompt instead of the flag; declining
      cancels setup.

  </Step>
  <Step title="Model/Auth">
    - **Anthropic API key**: uses `ANTHROPIC_API_KEY` if present or prompts for a key, then saves it for daemon use.
    - **Anthropic Claude CLI**: preferred local path when a Claude CLI sign-in already exists; OpenClaw still supports Anthropic setup-token auth as an alternative.
    - **OpenAI Code (Codex) subscription (OAuth)**: browser flow; paste the `code#state`.
      - On a fresh setup with no primary model, sets `agents.defaults.model` to `openai/gpt-5.6-sol` through the Codex runtime.
    - **OpenAI Code (Codex) subscription (device pairing)**: browser pairing flow with a short-lived device code.
      - On a fresh setup with no primary model, sets `agents.defaults.model` to `openai/gpt-5.6-sol` through the Codex runtime.
    - **OpenAI API key**: uses `OPENAI_API_KEY` if present or prompts for a key, then stores it in auth profiles.
      - On a fresh setup with no primary model, sets `agents.defaults.model` to `openai/gpt-5.6`; the bare direct-API model id resolves to the Sol tier.
    - Adding or reauthenticating OpenAI preserves an existing explicit primary model, including `openai/gpt-5.5`. If the account does not expose GPT-5.6, select `openai/gpt-5.5` explicitly; OpenClaw does not silently downgrade the model.
    - **xAI OAuth**: device-code browser sign-in with no localhost callback required, so it works over SSH/Docker/VPS too (`--auth-choice xai-oauth`).
    - **xAI API key**: prompts for `XAI_API_KEY` (`--auth-choice xai-api-key`).
    - `--auth-choice xai-device-code` still works as a manual-only compatibility alias for the same xAI OAuth device-code flow; use `xai-oauth` for new scripts.
    - **OpenCode**: prompts for `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`, get it at https://opencode.ai/auth) and lets you pick the Zen or Go catalog.
    - **Ollama**: offers **Cloud + Local**, **Cloud only**, or **Local only** first. `Cloud only` prompts for `OLLAMA_API_KEY` and uses `https://ollama.com`; the host-backed modes prompt for the Ollama base URL (default `http://127.0.0.1:11434`), discover available models, and auto-pull the selected local model when needed; `Cloud + Local` also checks whether that Ollama host is signed in for cloud access.
    - More detail: [Ollama](/providers/ollama)
    - **API key**: stores the key for you.
    - **Vercel AI Gateway (multi-model proxy)**: prompts for `AI_GATEWAY_API_KEY`.
    - More detail: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: prompts for Account ID, Gateway ID, and `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - More detail: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax**: config is auto-written; hosted default is `MiniMax-M3`.
      API-key setup uses `minimax/...`, and OAuth setup uses
      `minimax-portal/...`.
    - More detail: [MiniMax](/providers/minimax)
    - **StepFun**: config is auto-written for StepFun standard or Step Plan on China or global endpoints.
    - Standard currently defaults to `step-3.5-flash`; Step Plan also includes `step-3.5-flash-2603`.
    - More detail: [StepFun](/providers/stepfun)
    - **Synthetic (Anthropic-compatible)**: prompts for `SYNTHETIC_API_KEY`.
    - More detail: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: config is auto-written.
    - **Kimi Coding**: config is auto-written.
    - More detail: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Custom Provider**: works with OpenAI-compatible, OpenAI Responses-compatible, or Anthropic-compatible endpoints. Non-interactive flags: `--auth-choice custom-api-key`, `--custom-base-url`, `--custom-model-id`, `--custom-api-key` (optional; falls back to `CUSTOM_API_KEY`), `--custom-provider-id` (optional; auto-derived from the base URL), `--custom-compatibility openai|openai-responses|anthropic` (default `openai`), `--custom-image-input` / `--custom-text-input` (override inferred vision-model detection).
    - **Skip**: no auth configured yet.
    - Pick a default model from detected options (or enter provider/model manually). For best quality and lower prompt-injection risk, choose the strongest latest-generation model available in your provider stack.
    - Onboarding runs a model check and warns if the configured model is unknown or missing auth.
    - API key storage mode defaults to plaintext auth-profile values. Use `--secret-input-mode ref` to store env-backed refs instead (for example `keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" }`); the referenced env var must already be set, or onboarding fails fast.
    - Auth profiles live in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (API keys + OAuth). `~/.openclaw/credentials/oauth.json` is legacy import-only.
    - More detail: [OAuth](/concepts/oauth)
    <Note>
    Headless/server tip: complete OAuth on a machine with a browser, then copy
    that agent's `auth-profiles.json` (for example
    `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`, or the matching
    `$OPENCLAW_STATE_DIR/...` path) to the gateway host. `credentials/oauth.json`
    is only a legacy import source.
    </Note>
  </Step>
  <Step title="Workspace">
    - Default `~/.openclaw/workspace` (configurable).
    - Seeds the workspace files needed for the agent bootstrap ritual.
    - Full workspace layout + backup guide: [Agent workspace](/concepts/agent-workspace)

  </Step>
  <Step title="Gateway">
    - Port (default **18789**), bind, auth mode, tailscale exposure.
    - Auth recommendation: keep **Token** even for loopback so local WS clients must authenticate.
    - In token mode, interactive setup offers:
      - **Generate/store plaintext token** (default)
      - **Use SecretRef** (opt-in)
      - Quickstart reuses existing `gateway.auth.token` SecretRefs across `env`, `file`, and `exec` providers for onboarding probe/dashboard bootstrap.
      - If that SecretRef is configured but cannot be resolved, onboarding fails early with a clear fix message instead of silently degrading runtime auth.
    - In password mode, interactive setup also supports plaintext or SecretRef storage.
    - Non-interactive token SecretRef path: `--gateway-token-ref-env <ENV_VAR>`.
      - Requires a non-empty env var in the onboarding process environment.
      - Cannot be combined with `--gateway-token`.
    - Disable auth only if you fully trust every local process.
    - Non-loopback binds still require auth.

  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): optional QR login.
    - [Telegram](/channels/telegram): bot token.
    - [Discord](/channels/discord): bot token.
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience.
    - [Mattermost](/channels/mattermost) (plugin): bot token + base URL.
    - [Signal](/channels/signal) (plugin): optional `signal-cli` install + account config.
    - [iMessage](/channels/imessage): `imsg` CLI path + Messages DB access; use an SSH wrapper when the Gateway runs off-Mac.
    - Discord, Feishu, Microsoft Teams, QQ Bot, Slack, and other channels ship as
      plugins onboarding can install for you. Full catalog: [Channels](/channels).
    - DM security: default is pairing. First DM sends a code; approve via `openclaw pairing approve <channel> <code>` or use allowlists.

  </Step>
  <Step title="Web search">
    - Pick a supported provider such as Brave, Codex (Hosted Search), DuckDuckGo, Exa, Firecrawl, Gemini, Grok, Kimi, MiniMax Search, Ollama Web Search, Parallel, Perplexity, SearXNG, or Tavily (or skip).
    - API-backed providers can use env vars or existing config for quick setup; key-free providers use their provider-specific prerequisites instead.
    - Skip with `--skip-search`.
    - Configure later: `openclaw configure --section web`.

  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - Requires a logged-in user session; for headless, use a custom LaunchDaemon (not shipped).
    - Linux (and Windows via WSL2): systemd user unit
      - Onboarding attempts to enable lingering via `loginctl enable-linger <user>` so the Gateway stays up after logout.
      - May prompt for sudo (writes `/var/lib/systemd/linger`); it tries without sudo first.
    - Native Windows: Scheduled Task first; if task creation is denied, OpenClaw falls back to a per-user Startup-folder login item and starts the Gateway immediately.
    - **Runtime selection:** Node is required because the canonical runtime state store uses `node:sqlite`. Legacy Bun services are migrated to Node during repair.
    - If token auth requires a token and `gateway.auth.token` is SecretRef-managed, daemon install validates it but does not persist resolved plaintext token values into supervisor service environment metadata.
    - If token auth requires a token and the configured token SecretRef is unresolved, daemon install is blocked with actionable guidance.
    - If both `gateway.auth.token` and `gateway.auth.password` are configured and `gateway.auth.mode` is unset, daemon install is blocked until mode is set explicitly.

  </Step>
  <Step title="Health check">
    - Starts the Gateway (if needed) and runs `openclaw health`.
    - Tip: `openclaw status --deep` adds the live gateway health probe to status output, including channel probes when supported (requires a reachable gateway).

  </Step>
  <Step title="Skills (recommended)">
    - Reads the available skills and checks requirements.
    - Lets you choose a node manager: **npm / pnpm / bun**.
    - Auto-installs optional dependencies for trusted bundled skills (some use Homebrew on macOS).
    - Skips skills whose Homebrew, uv, or Go installer prerequisite is unavailable, groups them with manual setup guidance, and points you at `openclaw doctor` once the prerequisite is installed.

  </Step>
  <Step title="Finish">
    - Summary + next steps, including the **How do you want to hatch your agent?** prompt for Terminal, Browser, or later.

  </Step>
</Steps>

<Note>
If no GUI is detected, onboarding prints SSH port-forward instructions for the Control UI instead of opening a browser.
If the Control UI assets are missing, onboarding attempts to build them; fallback is `pnpm ui:build` (auto-installs UI deps).
</Note>

## Non-interactive mode

Use `--non-interactive --accept-risk` to automate or script onboarding (the
flag is the required risk acknowledgement; onboarding exits with an error
without it):

```bash
openclaw onboard --non-interactive --accept-risk \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

Add `--json` for a machine-readable summary.

Gateway token SecretRef in non-interactive mode:

```bash
export OPENCLAW_GATEWAY_TOKEN="your-token"
openclaw onboard --non-interactive --accept-risk \
  --mode local \
  --auth-choice skip \
  --gateway-auth token \
  --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN
```

`--gateway-token` and `--gateway-token-ref-env` are mutually exclusive.

<Note>
`--json` does **not** imply non-interactive mode. Use `--non-interactive --accept-risk` (and `--workspace`) for scripts.
</Note>

Provider-specific command examples live in [CLI Automation](/start/wizard-cli-automation#provider-specific-examples).
Use this reference page for flag semantics and step ordering.

### Add agent (non-interactive)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.6-sol \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

`main` is a reserved agent id and cannot be used for `openclaw agents add`.

## Gateway wizard RPC

The Gateway exposes the onboarding flow over RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Clients (macOS app, Control UI) can render steps without re-implementing onboarding logic.

## Signal setup (signal-cli)

Onboarding detects whether `signal-cli` is on `PATH` and, if missing, offers to install it:

- Linux x86-64: downloads the official native GraalVM build from the `signal-cli` GitHub releases and stores it under `~/.openclaw/tools/signal-cli/<version>/`.
- macOS and other architectures: installs via Homebrew instead.
- Native Windows: not supported yet; run onboarding inside WSL2 to get the Linux install path.
- Writes `channels.signal.transport.cliPath` with `kind: "managed-native"` either way.

## What the wizard writes

Typical fields in `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.skipBootstrap` when `--skip-bootstrap` is passed
- `agents.defaults.model` / `models.providers` (if Minimax chosen)
- `tools.profile` (local onboarding defaults to `"coding"` when unset; existing explicit values are preserved)
- `gateway.*` (mode, bind, auth, tailscale)
- `session.dmScope` (onboarding preserves explicit values and otherwise leaves it unset, so the `"main"` default keeps all direct messages across channels in the agent's rolling main session—the personal-agent default. For shared or multi-user inboxes, use `"per-channel-peer"`; `openclaw security audit` recommends isolation when it detects multi-user DM traffic. Details: [CLI Setup Reference](/start/wizard-cli-reference#outputs-and-internals))
- `channels.telegram.botToken`, `channels.discord.token`, `channels.matrix.*`, `channels.signal.*`, `channels.imessage.*`
- Channel DM allowlists when you opt in during the channel prompts. Discord, Matrix, Microsoft Teams, and Slack resolve names to IDs when possible; other channels take IDs directly (for example numeric Telegram sender IDs or WhatsApp phone numbers).
- `skills.install.nodeManager`
  - `setup --node-manager` accepts `npm`, `pnpm`, or `bun`.
  - Manual config can still use `yarn` by setting `skills.install.nodeManager` directly.
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`
- `wizard.securityAcknowledgedAt`

`openclaw agents add` writes `agents.entries.*` and optional `bindings`.

WhatsApp credentials go under `~/.openclaw/credentials/whatsapp/<accountId>/`.
Active sessions and transcripts are stored in
`~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`. The
`~/.openclaw/agents/<agentId>/sessions/` directory is used for legacy migration
inputs and archive/support artifacts.

Some channels are delivered as plugins. When you pick one during setup, onboarding
will prompt to install it (npm or a local path) before it can be configured.

## Related docs

- Onboarding overview: [Onboarding (CLI)](/start/wizard)
- CLI setup reference: [CLI setup reference](/start/wizard-cli-reference)
- macOS app onboarding: [Onboarding](/start/onboarding)
- Config reference: [Gateway configuration](/gateway/configuration)
- Providers: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [iMessage](/channels/imessage)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
