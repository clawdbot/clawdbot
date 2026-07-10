---
summary: "FAQ: quick-start and first-run setup — install, onboard, auth, subscriptions, initial failures"
read_when:
  - New install, onboarding stuck, or first-run errors
  - Choosing auth and provider subscriptions
  - Cannot access docs.openclaw.ai, cannot open dashboard, install stuck
title: "FAQ: first-run setup"
sidebarTitle: "First-run FAQ"
---

Quick-start and first-run Q&A. For everyday operations, models, auth, sessions,
and troubleshooting see the main [FAQ](/help/faq).

## Quick start and first-run setup

<AccordionGroup>
  <Accordion title="I am stuck, fastest way to get unstuck">
    Use a local AI agent that can **see your machine**. Most "I'm stuck" cases are
    **local config or environment issues** a remote helper cannot inspect, so this beats
    asking in Discord.

    - **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
    - **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

    Give the agent the full source checkout via the hackable (git) install so it can read
    code + docs and reason about the exact version you run:

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```

    Ask the agent to plan and supervise the fix step-by-step, then execute only the
    necessary commands - smaller diffs are easier to audit.

    Share these outputs when asking for help (in Discord or a GitHub issue):

    | Command | Shows |
    | --- | --- |
    | `openclaw status` | Gateway/agent health + basic config snapshot |
    | `openclaw status --all` | Full read-only diagnosis, pasteable |
    | `openclaw models status` | Provider auth + model availability |
    | `openclaw doctor` | Validates and repairs common config/state issues |
    | `openclaw logs --follow` | Live log tail |
    | `openclaw gateway status --deep` | Deep gateway/config/plugin health check |
    | `openclaw health --verbose` | Detailed health report |

    Found a real bug or fix? File an issue or send a PR:
    [Issues](https://github.com/openclaw/openclaw/issues) /
    [Pull requests](https://github.com/openclaw/openclaw/pulls).

    Quick debug loop: [First 60 seconds if something is broken](/help/faq#first-60-seconds-if-something-is-broken).
    Install docs: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating).

  </Accordion>

  <Accordion title="Heartbeat keeps skipping. What do the skip reasons mean?">
    | Skip reason | Meaning |
    | --- | --- |
    | `quiet-hours` | Outside the configured active-hours window |
    | `empty-heartbeat-file` | `HEARTBEAT.md` exists but only has blank, comment, header, fence, or empty-checklist scaffolding |
    | `no-tasks-due` | Task mode is active but no task interval is due yet |
    | `alerts-disabled` | All heartbeat visibility is off (`showOk`, `showAlerts`, and `useIndicator` all disabled) |

    In task mode, due timestamps advance only after a real heartbeat run completes.
    Skipped runs do not mark tasks as completed.

    Docs: [Heartbeat](/gateway/heartbeat), [Automation](/automation).

  </Accordion>

  <Accordion title="Recommended way to install and set up OpenClaw">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    openclaw onboard --install-daemon
    ```

    From source (contributors/dev):

    ```bash
    git clone https://github.com/openclaw/openclaw.git
    cd openclaw
    pnpm install
    pnpm build
    pnpm ui:build
    openclaw onboard
    ```

    No global install yet? Run `pnpm openclaw onboard` instead. If Control UI assets are
    missing, onboarding tries to build them itself, falling back to `pnpm ui:build`.

  </Accordion>

  <Accordion title="How do I open the dashboard after onboarding?">
    Onboarding opens your browser to a clean (non-tokenized) dashboard URL right after
    setup and prints the link in the summary. Keep that tab open; if it did not launch,
    copy/paste the printed URL on the same machine.
  </Accordion>

  <Accordion title="How do I authenticate the dashboard on localhost vs remote?">
    **Localhost (same machine):**

    - Open `http://127.0.0.1:18789/`.
    - If it asks for shared-secret auth, paste the configured token or password into Control UI settings.
    - Token source: `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`).
    - Password source: `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`).
    - No shared secret configured yet? Run `openclaw doctor --generate-gateway-token` (or `openclaw doctor --fix --generate-gateway-token`).

    **Not on localhost:**

    - **Tailscale Serve** (recommended): keep bind loopback, run `openclaw gateway --tailscale serve`, open `https://<magicdns>/`. With `gateway.auth.allowTailscale: true`, identity headers satisfy Control UI/WebSocket auth (no pasted shared secret, assumes a trusted gateway host); HTTP APIs still need shared-secret auth unless you deliberately use private-ingress `none` or trusted-proxy HTTP auth.
      Concurrent bad-auth Serve attempts from the same client are serialized before the failed-auth limiter records them, so a second bad retry can already show `retry later`.
    - **Tailnet bind**: run `openclaw gateway --bind tailnet --token "<token>"` (or configure password auth), open `http://<tailscale-ip>:18789/`, paste the matching shared secret in dashboard settings.
    - **Identity-aware reverse proxy**: keep the Gateway behind a trusted proxy, set `gateway.auth.mode: "trusted-proxy"`, open the proxy URL. Same-host loopback proxies need explicit `gateway.auth.trustedProxy.allowLoopback: true`.
    - **SSH tunnel**: `ssh -N -L 18789:127.0.0.1:18789 user@gateway-host`, then open `http://127.0.0.1:18789/`. Shared-secret auth still applies over the tunnel; paste the configured token or password if prompted.

    See [Dashboard](/web/dashboard) and [Web surfaces](/web) for bind modes and auth details.

  </Accordion>

  <Accordion title="Why are there two exec approval configs for chat approvals?">
    They control different layers:

    - `approvals.exec` - forwards approval prompts to chat destinations.
    - `channels.<channel>.execApprovals` - makes that channel a native approval client for exec approvals.

    The host exec policy is still the real approval gate; chat config only controls where
    prompts appear and how people answer them.

    You rarely need both:

    - If the chat already supports commands and replies, same-chat `/approve` works through the shared path.
    - When a supported native channel can infer approvers safely, OpenClaw auto-enables DM-first native approvals if `channels.<channel>.execApprovals.enabled` is unset or `"auto"`.
    - When native approval cards/buttons are available, that UI is primary; only mention a manual `/approve` command if the tool result says chat approvals are unavailable.
    - Use `approvals.exec` only when prompts must also reach other chats or explicit ops rooms.
    - Use `channels.<channel>.execApprovals.target: "channel"` or `"both"` only when you want approval prompts posted back into the originating room/topic.
    - Plugin approvals are separate: same-chat `/approve` by default, optional `approvals.plugin` forwarding, and only some native channels keep native handling for those too.

    Short version: forwarding is for routing, native client config is for richer channel-specific UX.
    See [Exec Approvals](/tools/exec-approvals).

  </Accordion>

  <Accordion title="What runtime do I need?">
    Node **22.19+** is required (Node 24 recommended). `pnpm` is the repo package manager.
    Bun is **not recommended** for the Gateway.
  </Accordion>

  <Accordion title="Does it run on Raspberry Pi?">
    Yes, but check RAM first: Pi 5 and Pi 4 (2 GB+) are the sweet spot; Pi 3B+ (1 GB) works but is slow; Pi Zero 2 W (512 MB) is not recommended.

    | Model | RAM | Fit |
    | --- | --- | --- |
    | Pi 5 | 4/8 GB | Best |
    | Pi 4 | 4 GB | Good |
    | Pi 4 | 2 GB | OK, add swap |
    | Pi 4 | 1 GB | Tight |
    | Pi 3B+ | 1 GB | Slow |
    | Pi Zero 2 W | 512 MB | Not recommended |

    Absolute minimum: 1 GB RAM, 1 core, 500 MB free disk, 64-bit OS. Since the Pi only runs
    the Gateway (models call out to cloud APIs), even a modest Pi handles the load.

    A small Pi/VPS can also host just the Gateway while you pair **nodes** on your
    laptop/phone for local screen/camera/canvas or command execution. See [Nodes](/nodes).

    Full setup walkthrough: [Raspberry Pi](/install/raspberry-pi).

  </Accordion>

  <Accordion title="Any tips for Raspberry Pi installs?">
    - Use a **64-bit** OS; do not use 32-bit Raspberry Pi OS.
    - Add swap on 2 GB or smaller boards.
    - Prefer a **USB SSD** over an SD card for performance and longevity.
    - Prefer the hackable (git) install so you can see logs and update fast.
    - Start without channels/skills, add them one by one.
    - Weird binary failures ("exec format error") are usually a missing ARM64 build for an optional skill tool.

    Full guide: [Raspberry Pi](/install/raspberry-pi). Also see [Linux](/platforms/linux).

  </Accordion>

  <Accordion title="It is stuck on wake up my friend / onboarding will not hatch. What now?">
    That screen depends on the Gateway being reachable and authenticated. The TUI also sends
    "Wake up, my friend!" automatically on first hatch when a model provider is configured. If
    you skipped model/auth setup, onboarding shows a "Model auth missing" note and opens the
    TUI without sending anything — add a provider with `openclaw configure --section model`.
    If you see the wake-up line with **no reply** and tokens stay at 0, the agent never ran.

    1. Restart the Gateway:

    ```bash
    openclaw gateway restart
    ```

    2. Check status + auth:

    ```bash
    openclaw status
    openclaw models status
    openclaw logs --follow
    ```

    3. Still hanging? Run:

    ```bash
    openclaw doctor
    ```

    If the Gateway is remote, confirm the tunnel/Tailscale connection is up and the UI
    points at the right Gateway. See [Remote access](/gateway/remote).

  </Accordion>

  <Accordion title="Can I migrate my setup to a new machine without redoing onboarding?">
    Yes. Copy the **state directory** and **workspace**, then run Doctor once:

    1. Install OpenClaw on the new machine.
    2. Copy `$OPENCLAW_STATE_DIR` (default: `~/.openclaw`) from the old machine.
    3. Copy your workspace (default: `~/.openclaw/workspace`).
    4. Run `openclaw doctor` and restart the Gateway service.

    This preserves config, auth profiles, WhatsApp creds, sessions, and memory - it keeps
    your bot exactly the same, as long as you copy **both** locations. In remote mode, the
    gateway host owns the session store and workspace.

    **Important:** if you only commit/push your workspace to GitHub, you back up
    **memory + bootstrap files**, but not session history or auth. Those live under
    `~/.openclaw/` (for example `~/.openclaw/agents/<agentId>/sessions/`).

    Related: [Migrating](/install/migrating), [Where things live on disk](/help/faq#where-things-live-on-disk),
    [Agent workspace](/concepts/agent-workspace), [Doctor](/gateway/doctor),
    [Remote mode](/gateway/remote).

  </Accordion>

  <Accordion title="Where do I see what is new in the latest version?">
    Check the GitHub changelog:
    [https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

    Newest entries are at the top. If the top section is **Unreleased**, the next dated
    section is the latest shipped version. Entries group under **Highlights**, **Changes**,
    and **Fixes** (plus docs/other sections when needed).

  </Accordion>

  <Accordion title="Cannot access docs.openclaw.ai (SSL error)">
    Some Comcast/Xfinity connections incorrectly block `docs.openclaw.ai` via Xfinity
    Advanced Security. Disable it or allowlist `docs.openclaw.ai`, then retry. Help us
    get it unblocked: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

    Still blocked? Docs are mirrored on GitHub:
    [https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

  </Accordion>

  <Accordion title="Difference between stable and beta">
    **Stable** and **beta** are **npm dist-tags**, not separate code lines:

    - `latest` = stable
    - `beta` = early build for testing (falls back to `latest` when beta is missing or older than the current stable release)

    A stable release usually lands on **beta** first, then an explicit promotion step
    moves that same version to `latest` without changing the version number. Maintainers
    can also publish straight to `latest`. That is why beta and stable can point at the
    **same version** after promotion.

    See what changed: [CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md).

    For install one-liners and the difference between beta and dev, see the next accordion.

  </Accordion>

  <Accordion title="How do I install the beta version and what is the difference between beta and dev?">
    **Beta** is the npm dist-tag `beta` (may match `latest` after promotion).
    **Dev** is the moving head of `main` (git); when published to npm it uses dist-tag `dev`.

    One-liners (macOS/Linux):

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```

    Windows installer (PowerShell): `iwr -useb https://openclaw.ai/install.ps1 | iex`

    More detail: [Development channels](/install/development-channels) and [Installer flags](/install/installer).

  </Accordion>

  <Accordion title="How do I try the latest bits?">
    Two options:

    1. **Dev channel (existing install):**

    ```bash
    openclaw update --channel dev
    ```

    This switches to a git checkout of `main`, rebases on upstream, builds, and installs
    the CLI from that checkout.

    2. **Hackable (git) install (fresh machine):**

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```

    Prefer a manual clone:

    ```bash
    git clone https://github.com/openclaw/openclaw.git
    cd openclaw
    pnpm install
    pnpm build
    ```

    Docs: [Update](/cli/update), [Development channels](/install/development-channels), [Install](/install).

  </Accordion>

  <Accordion title="How long does install and onboarding usually take?">
    Rough guide:

    - **Install:** 2-5 minutes.
    - **QuickStart onboarding:** a few minutes (loopback gateway, auto token, default workspace).
    - **Advanced/full onboarding:** longer when provider sign-in, channel pairing, daemon install, network downloads, or skills need extra setup.

    The wizard shows this timeline up front. Skip optional steps and return later with
    `openclaw configure`.

    Hanging? See [I am stuck](#quick-start-and-first-run-setup) above.

  </Accordion>

  <Accordion title="Installer stuck? How do I get more feedback?">
    Re-run with `--verbose`:

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --verbose
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta --verbose
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
    ```

    `install.ps1` has no dedicated verbose switch; wrap it in `Set-PSDebug -Trace 1` /
    `-Trace 0` instead. Full flag reference: [Installer flags](/install/installer).

  </Accordion>

  <Accordion title="Windows install says git not found or openclaw not recognized">
    Two common Windows issues:

    **1) npm error spawn git / git not found**

    - Install **Git for Windows**, make sure `git` is on PATH.
    - Close and reopen PowerShell, then re-run the installer.

    **2) openclaw is not recognized after install**

    - Your npm global bin folder is not on PATH.
    - Check it: `npm config get prefix`.
    - Add that directory to your user PATH (no `\bin` suffix needed; on most systems it is `%AppData%\npm`).
    - Close and reopen PowerShell.

    Prefer a desktop app? Use **Windows Hub**. Terminal-only setup: the PowerShell
    installer and WSL2 Gateway paths are both supported. Docs: [Windows](/platforms/windows).

  </Accordion>

  <Accordion title="Windows exec output shows garbled Chinese text - what should I do?">
    Usually a console code page mismatch on native Windows shells.

    Symptoms: `system.run`/`exec` output renders Chinese as mojibake; the same command
    looks fine in another terminal profile.

    Workaround in PowerShell:

    ```powershell
    chcp 65001
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    ```

    Then restart the Gateway and retry:

    ```powershell
    openclaw gateway restart
    ```

    Still reproducing this on latest OpenClaw? Track/report it: [Issue #30640](https://github.com/openclaw/openclaw/issues/30640).

  </Accordion>

  <Accordion title="The docs did not answer my question - how do I get a better answer?">
    Use the hackable (git) install so you have the full source and docs locally, then ask
    your bot (or Claude/Codex) **from that folder** so it can read the repo and answer precisely.

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```

    More detail: [Install](/install) and [Installer flags](/install/installer).

  </Accordion>

  <Accordion title="How do I install OpenClaw on Linux?">
    - Linux quick path + service install: [Linux](/platforms/linux).
    - Full walkthrough: [Getting Started](/start/getting-started).
    - Installer + updates: [Install & updates](/install/updating).

  </Accordion>

  <Accordion title="How do I install OpenClaw on a VPS?">
    Any Linux VPS works. Install on the server, then reach the Gateway over SSH/Tailscale.

    Guides: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
    Remote access: [Gateway remote](/gateway/remote).

  </Accordion>

  <Accordion title="Where are the cloud/VPS install guides?">
    Hosting hub with common providers:

    - [VPS hosting](/vps) (all providers in one place)
    - [Fly.io](/install/fly)
    - [Hetzner](/install/hetzner)
    - [exe.dev](/install/exe-dev)

    In the cloud, the **Gateway runs on the server** and you access it from your laptop/phone
    via the Control UI (or Tailscale/SSH). Your state + workspace live on the server, so
    treat the host as the source of truth and back it up.

    Pair **nodes** (Mac/iOS/Android/headless) to that cloud Gateway for local
    screen/camera/canvas or command execution on your laptop while the Gateway stays in
    the cloud.

    Hub: [Platforms](/platforms). Remote access: [Gateway remote](/gateway/remote).
    Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

  </Accordion>

  <Accordion title="Can I ask OpenClaw to update itself?">
    Possible, not recommended. The update flow can restart the Gateway (dropping the
    active session), may need a clean git checkout, and can prompt for confirmation.
    Safer to run updates from a shell as the operator.

    ```bash
    openclaw update
    openclaw update status
    openclaw update --channel stable|extended-stable|beta|dev
    openclaw update --tag <dist-tag|version>
    openclaw update --no-restart
    ```

    Automating from an agent:

    ```bash
    openclaw update --yes --no-restart
    openclaw gateway restart
    ```

    Docs: [Update](/cli/update), [Updating](/install/updating).

  </Accordion>

  <Accordion title="What does onboarding actually do?">
    `openclaw onboard` is the recommended setup path. In **local mode** it walks through:

    1. **Model/Auth** - provider OAuth, API keys, or manual auth (including local options like LM Studio); pick a default model.
    2. **Workspace** - location + bootstrap files.
    3. **Gateway** - port, bind address, auth mode, Tailscale exposure.
    4. **Channels** - built-in and official plugin chat channels: iMessage, Discord, Feishu, Google Chat, Mattermost, Microsoft Teams, QQ Bot, Signal, Slack, Telegram, WhatsApp, and more.
    5. **Daemon** - LaunchAgent (macOS), systemd user unit (Linux/WSL2), or native Windows Scheduled Task.
    6. **Health check** - starts the Gateway and verifies it is running.
    7. **Skills** - installs recommended skills and optional dependencies.

    It sets duration expectations up front and warns if your configured model is unknown
    or missing auth. Full breakdown: [Onboarding (CLI)](/start/wizard).

  </Accordion>

  <Accordion title="Do I need a Claude or OpenAI subscription to run this?">
    No. Run OpenClaw with **API keys** (Anthropic/OpenAI/others) or **local-only models**
    so your data stays on your device. Subscriptions (Claude Pro/Max, ChatGPT/Codex) are
    optional ways to authenticate those providers.

    For Anthropic: an **API key** gives standard pay-as-you-go billing; **Claude CLI**
    reuses an existing Claude Code login on the same host. Anthropic currently treats
    Claude CLI's non-interactive `claude -p` path as Agent SDK/programmatic usage that
    still draws from your subscription's plan limits - check current Anthropic billing
    docs before relying on subscription behavior. For long-lived gateway hosts and shared
    automation, an Anthropic API key is the more predictable choice.

    OpenAI Codex OAuth (ChatGPT/Codex subscription) is fully supported for agent models.
    OpenClaw also supports hosted subscription-style options including **Qwen Cloud
    Coding Plan**, **MiniMax Coding Plan**, and **Z.AI / GLM Coding Plan**.

    Docs: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
    [Qwen Cloud](/providers/qwen), [MiniMax](/providers/minimax), [Z.AI (GLM)](/providers/zai),
    [Local models](/gateway/local-models), [Models](/concepts/models).

  </Accordion>

  <Accordion title="Can I use Claude Max subscription without an API key?">
    Yes. OpenClaw supports Claude CLI reuse for Pro/Max/Team/Enterprise plans. Anthropic
    currently treats the `claude -p` path OpenClaw uses as subscription-plan usage subject
    to your plan's limits, not a separate free allowance - see
    [Anthropic](/providers/anthropic) for the current billing detail and links to
    Anthropic's own support articles. For the most predictable server-side setup, use an
    Anthropic API key instead.
  </Accordion>

  <Accordion title="Do you support Claude subscription auth (Claude Pro or Max)?">
    Yes, via Claude CLI reuse. Anthropic's billing treatment of `claude -p`/Agent SDK usage
    has changed over time; see [Anthropic](/providers/anthropic) for the current state and
    dated links to Anthropic's support articles before relying on specific billing
    behavior.

    Anthropic setup-token auth is also still a supported token path, but OpenClaw prefers
    Claude CLI reuse and `claude -p` when available. For production or multi-user
    workloads, an Anthropic API key remains the safer, more predictable choice. Other
    subscription-style hosted options: [OpenAI](/providers/openai), [Qwen Cloud](/providers/qwen),
    [MiniMax](/providers/minimax), [Z.AI (GLM)](/providers/zai).

  </Accordion>

</AccordionGroup>

<a id="why-am-i-seeing-http-429-ratelimiterror-from-anthropic"></a>

<AccordionGroup>
  <Accordion title="Why am I seeing HTTP 429 rate_limit_error from Anthropic?">
    Your **Anthropic quota/rate limit** is exhausted for the current window. On **Claude
    CLI**, wait for the window to reset or upgrade your plan. On an **Anthropic API key**,
    check usage/billing in the Anthropic Console and raise limits as needed.

    If the message is specifically `Extra usage is required for long context requests`,
    the request is trying to use Anthropic's 1M context window (a GA-capable 1M Claude 4.x
    model, or legacy `params.context1m: true` config), and your current credential is not
    eligible for long-context billing.

    Set a **fallback model** so OpenClaw keeps replying while a provider is rate-limited.
    See [Models](/cli/models), [OAuth](/concepts/oauth), and
    [Anthropic 429 extra usage required for long context](/gateway/troubleshooting#anthropic-429-extra-usage-required-for-long-context).

  </Accordion>

  <Accordion title="Is AWS Bedrock supported?">
    Yes. OpenClaw has a bundled **Amazon Bedrock (Converse)** provider. With AWS env
    markers present (`AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, `AWS_BEARER_TOKEN_BEDROCK`),
    OpenClaw auto-enables the implicit Bedrock provider for model discovery; otherwise
    set `plugins.entries.amazon-bedrock.config.discovery.enabled: true` or add a manual
    provider entry. See [Amazon Bedrock](/providers/bedrock) and [Model providers](/providers/models).
    An OpenAI-compatible proxy in front of Bedrock is still a valid option if you prefer a managed key flow.
  </Accordion>

  <Accordion title="How does Codex auth work?">
    OpenClaw supports **OpenAI Codex** via OAuth (ChatGPT sign-in). A fresh
    setup with no primary model uses exact `openai/gpt-5.6-sol` for
    ChatGPT/Codex subscription auth plus native Codex app-server execution.
    Reauthentication preserves an existing explicit model, including
    `openai/gpt-5.5`. If the Codex workspace does not expose GPT-5.6, select
    `openai/gpt-5.5` explicitly; OpenClaw does not silently downgrade. Legacy
    Codex-prefixed model refs are legacy config repaired by `openclaw doctor
    --fix`. Direct OpenAI API-key access remains available for non-agent OpenAI
    API surfaces and, through an ordered `openai` API-key profile, for agent
    models too. See [Model providers](/concepts/model-providers) and
    [Onboarding (CLI)](/start/wizard).
  </Accordion>

  <Accordion title="Why does OpenClaw still mention legacy OpenAI Codex prefix?">
    `openai` is the current provider and auth-profile id for both OpenAI API keys and
    ChatGPT/Codex OAuth - OpenAI Codex is folded into it. You may still see a legacy
    `openai-codex` prefix in older config and migration warnings:

    - `openai/gpt-5.6-sol` = fresh ChatGPT/Codex subscription setup with the native Codex runtime for agent turns.
    - `openai/gpt-5.5` = explicit supported selection for existing config or accounts without GPT-5.6 access.
    - Legacy `openai-codex/*` model refs = legacy route repaired by `openclaw doctor --fix`.
    - `openai/gpt-5.5` plus an ordered `openai` API-key profile = API-key auth for an OpenAI agent model.
    - Legacy `openai-codex` auth profile ids = legacy ids migrated by `openclaw doctor --fix`.

    Want direct OpenAI Platform billing? Set `OPENAI_API_KEY`. Want ChatGPT/Codex
    subscription auth? Run `openclaw models auth login --provider openai`. Keep
    model refs under the canonical `openai/*` provider. Fresh subscription
    setup uses exact `openai/gpt-5.6-sol`; doctor repairs legacy Codex-prefixed
    refs without upgrading an explicit `openai/gpt-5.5` selection.

  </Accordion>

  <Accordion title="Why can Codex OAuth limits differ from ChatGPT web?">
    Codex OAuth uses OpenAI-managed, plan-dependent quota windows that can differ from the
    ChatGPT website/app experience, even on the same account.

    `openclaw models status` shows the currently visible provider usage/quota windows, but
    does not invent or normalize ChatGPT-web entitlements into direct API access. For the
    direct OpenAI Platform billing/limit path, use `openai/*` with an API key.

  </Accordion>

  <Accordion title="Do you support OpenAI subscription auth (Codex OAuth)?">
    Yes, fully. OpenAI explicitly allows subscription OAuth usage in external
    tools/workflows like OpenClaw. Onboarding can run the OAuth flow for you.

    See [OAuth](/concepts/oauth), [Model providers](/concepts/model-providers), and [Onboarding (CLI)](/start/wizard).

  </Accordion>

  <Accordion title="How do I set up Gemini CLI OAuth?">
    Gemini CLI uses a **plugin auth flow**, not a client id or secret in `openclaw.json`.

    1. Install Gemini CLI locally so `gemini` is on `PATH`:
       - Homebrew: `brew install gemini-cli`
       - npm: `npm install -g @google/gemini-cli`
    2. Enable the plugin: `openclaw plugins enable google`
    3. Login: `openclaw models auth login --provider google-gemini-cli --set-default`
    4. Default model after login: `google/gemini-3.1-pro-preview` (runtime `google-gemini-cli`)
    5. Requests failing after login? Set `GOOGLE_CLOUD_PROJECT` or `GOOGLE_CLOUD_PROJECT_ID` on the gateway host and retry.

    OAuth tokens are stored in auth profiles on the gateway host. Details: [Google](/providers/google), [Model providers](/concepts/model-providers).

  </Accordion>

  <Accordion title="Is a local model OK for casual chats?">
    Usually no. OpenClaw needs large context + strong safety; small cards truncate context
    and skip provider-side safety filters. If you must, run the **largest** model build you
    can locally (LM Studio) - see [Local models](/gateway/local-models). Smaller/quantized
    models raise prompt-injection risk - see [Security](/gateway/security).
  </Accordion>

  <Accordion title="How do I keep hosted model traffic in a specific region?">
    Pick region-pinned endpoints. OpenRouter exposes US-hosted options for MiniMax, Kimi,
    and GLM; choose the US-hosted variant to keep data in-region. You can still list
    Anthropic/OpenAI alongside these with `models.mode: "merge"` so fallbacks stay
    available while respecting the regioned provider you select.
  </Accordion>

  <Accordion title="Do I have to buy a Mac Mini to install this?">
    No. OpenClaw runs on macOS or Linux (Windows via WSL2). A Mac mini is a popular
    always-on host choice, but a small VPS, home server, or Raspberry Pi-class box works too.

    You only need a Mac **for macOS-only tools**. For iMessage, use [iMessage](/channels/imessage)
    with `imsg` on any Mac signed into Messages - if the Gateway runs on Linux or elsewhere,
    set `channels.imessage.cliPath` to an SSH wrapper that runs `imsg` on that Mac. For other
    macOS-only tools, run the Gateway on a Mac or pair a macOS node.

    Docs: [iMessage](/channels/imessage), [Nodes](/nodes), [Mac remote mode](/platforms/mac/remote).

  </Accordion>

  <Accordion title="Do I need a Mac mini for iMessage support?">
    You need **some macOS device** signed into Messages - not necessarily a Mac mini, any
    Mac works. Use [iMessage](/channels/imessage) with `imsg`; the Gateway can run on that
    Mac, or elsewhere with an SSH wrapper `cliPath`.

    Common setups:

    - Gateway on Linux/VPS, `channels.imessage.cliPath` set to an SSH wrapper that runs `imsg` on a Mac signed into Messages.
    - Everything on one Mac for the simplest single-machine setup.

    Docs: [iMessage](/channels/imessage), [Nodes](/nodes), [Mac remote mode](/platforms/mac/remote).

  </Accordion>

  <Accordion title="If I buy a Mac mini to run OpenClaw, can I connect it to my MacBook Pro?">
    Yes. The **Mac mini can run the Gateway**, and your MacBook Pro connects as a **node**
    (companion device). Nodes do not run the Gateway - they add capabilities like
    screen/camera/canvas and `system.run` on that device.

    Common pattern: Gateway on the always-on Mac mini; MacBook Pro runs the macOS app or a
    node host and pairs to the Gateway. Check with `openclaw nodes status` / `openclaw nodes list`.

    Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

  </Accordion>

  <Accordion title="Can I use Bun?">
    Not recommended - Bun has runtime bugs, especially with WhatsApp and Telegram. Use
    **Node** for stable gateways. If you still want to experiment, do it on a
    non-production gateway without WhatsApp/Telegram.
  </Accordion>

  <Accordion title="Telegram: what goes in allowFrom?">
    `channels.telegram.allowFrom` is the **human sender's Telegram user ID** (numeric),
    not the bot username. Setup asks for numeric user IDs only; `openclaw doctor --fix`
    can try to resolve legacy `@username` entries.

    Safer (no third-party bot): DM your bot, run `openclaw logs --follow`, read `from.id`.

    Official Bot API: DM your bot, call `https://api.telegram.org/bot<bot_token>/getUpdates`, read `message.from.id`.

    Third-party (less private): DM `@userinfobot` or `@getidsbot`.

    See [Telegram access control](/channels/telegram#access-control-and-activation).

  </Accordion>

  <Accordion title="Can multiple people use one WhatsApp number with different OpenClaw instances?">
    Yes, via **multi-agent routing**. Bind each sender's WhatsApp DM (`peer: { kind: "direct", id: "+15551234567" }`) to a different `agentId`, giving each person their own workspace and session store. Replies still come from the **same WhatsApp account**; DM access control (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) is global per account. See [Multi-Agent Routing](/concepts/multi-agent) and [WhatsApp](/channels/whatsapp).
  </Accordion>

  <Accordion title='Can I run a "fast chat" agent and an "Opus for coding" agent?'>
    Yes. Use multi-agent routing: give each agent its own default model, then bind inbound
    routes (provider account or specific peers) to each agent. Example config:
    [Multi-Agent Routing](/concepts/multi-agent). See also [Models](/concepts/models) and
    [Configuration](/gateway/configuration).
  </Accordion>

  <Accordion title="Does Homebrew work on Linux?">
    Yes, via Linuxbrew:

    ```bash
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
    eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
    brew install <formula>
    ```

    Running OpenClaw via systemd: make sure the service PATH includes
    `/home/linuxbrew/.linuxbrew/bin` (or your brew prefix) so `brew`-installed tools
    resolve in non-login shells. Recent builds also prepend common user bin dirs on Linux
    systemd services (for example `~/.local/bin`, `~/.npm-global/bin`,
    `~/.local/share/pnpm`, `~/.bun/bin`) and honor `PNPM_HOME`, `NPM_CONFIG_PREFIX`,
    `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, and `FNM_DIR` when set.

  </Accordion>

  <Accordion title="Difference between the hackable git install and npm install">
    - **Hackable (git) install:** full source checkout, editable, best for contributors. You build locally and can patch code/docs.
    - **npm install:** global CLI install, no repo, best for "just run it." Updates come from npm dist-tags.

    Docs: [Getting started](/start/getting-started), [Updating](/install/updating).

  </Accordion>

  <Accordion title="Can I switch between npm and git installs later?">
    Yes, with `openclaw update --channel ...` on an existing install. This does **not
    delete your data** - only the OpenClaw code install changes. State (`~/.openclaw`) and
    workspace (`~/.openclaw/workspace`) stay untouched.

    npm to git:

    ```bash
    openclaw update --channel dev
    ```

    git to npm:

    ```bash
    openclaw update --channel stable
    ```

    Add `--dry-run` to preview the planned mode switch first. The updater runs Doctor
    follow-ups, refreshes plugin sources for the target channel, and restarts the gateway
    unless you pass `--no-restart`.

    The installer can force either mode too:

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method npm
    ```

    Backup tips: [Where things live on disk](/help/faq#where-things-live-on-disk).

  </Accordion>

  <Accordion title="Should I run the Gateway on my laptop or a VPS?">
    Want 24/7 reliability? Use a **VPS**. Want the lowest friction and you are OK with
    sleep/restarts? Run it locally.

    **Laptop (local Gateway)**

    - **Pros:** no server cost, direct access to local files, a live browser window.
    - **Cons:** sleep/network drops disconnect it, OS updates/reboots interrupt it, must stay awake.

    **VPS / cloud**

    - **Pros:** always-on, stable network, no laptop sleep issues, easier to keep running.
    - **Cons:** often headless (use screenshots), remote file access only, SSH needed for updates.

    WhatsApp/Telegram/Slack/Mattermost/Discord all work fine from a VPS - the real
    trade-off is headless browser vs a visible window. See [Browser](/tools/browser).

    Default recommendation: VPS if you have had gateway disconnects before; local is great
    when you are actively using the Mac and want local file access or visible-browser UI
    automation.

  </Accordion>

  <Accordion title="How important is it to run OpenClaw on a dedicated machine?">
    Not required, but recommended for reliability and isolation.

    - **Dedicated host (VPS/Mac mini/Raspberry Pi):** always-on, fewer sleep/reboot interruptions, cleaner permissions, easier to keep running.
    - **Shared laptop/desktop:** fine for testing and active use, but expect pauses when the machine sleeps or updates.

    Best of both worlds: keep the Gateway on a dedicated host and pair your laptop as a
    **node** for local screen/camera/exec tools. See [Nodes](/nodes) and [Security](/gateway/security).

  </Accordion>

  <Accordion title="What are the minimum VPS requirements and recommended OS?">
    - **Absolute minimum:** 1 vCPU, 1 GB RAM, ~500 MB disk.
    - **Recommended:** 1-2 vCPU, 2 GB+ RAM for headroom (logs, media, multiple channels). Node tools and browser automation can be resource hungry.

    OS: **Ubuntu LTS** (or any modern Debian/Ubuntu) - the best-tested Linux install path.

    Docs: [Linux](/platforms/linux), [VPS hosting](/vps).

  </Accordion>

  <Accordion title="Can I run OpenClaw in a VM and what are the requirements?">
    Yes. Treat a VM like a VPS: it needs to be always on, reachable, and have enough RAM
    for the Gateway and any channels you enable.

    - **Absolute minimum:** 1 vCPU, 1 GB RAM.
    - **Recommended:** 2 GB+ RAM for multiple channels, browser automation, or media tools.
    - **OS:** Ubuntu LTS or another modern Debian/Ubuntu.

    On Windows, use **Windows Hub** for desktop setup, or WSL2 for a Linux-style Gateway VM
    with broad tooling compatibility. See [Windows](/platforms/windows), [VPS hosting](/vps).
    Running macOS in a VM: see [macOS VM](/install/macos-vm).

  </Accordion>
</AccordionGroup>

## Related

- [FAQ](/help/faq) - the main FAQ (models, sessions, gateway, security, more)
- [Install overview](/install)
- [Getting started](/start/getting-started)
- [Troubleshooting](/help/troubleshooting)
