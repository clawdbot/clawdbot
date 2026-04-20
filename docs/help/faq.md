---
summary: "Frequently asked questions about OpenClaw setup, configuration, and usage"
read_when:
  - Answering common setup, install, onboarding, or runtime support questions
  - Triaging user-reported issues before deeper debugging
title: "FAQ"
---

# FAQ

Quick answers plus deeper troubleshooting for real-world setups (local dev, VPS, multi-agent, OAuth/API keys, model failover). For runtime diagnostics, see [Troubleshooting](/gateway/troubleshooting). For the full config reference, see [Configuration](/gateway/configuration).

## First 60 seconds if something is broken

1. **Quick status (first check)**

   ```bash
   openclaw status
   ```

   Fast local summary: OS + update, gateway/service reachability, agents/sessions, provider config + runtime issues (when gateway is reachable).

2. **Pasteable report (safe to share)**

   ```bash
   openclaw status --all
   ```

   Read-only diagnosis with log tail (tokens redacted).

3. **Daemon + port state**

   ```bash
   openclaw gateway status
   ```

   Shows supervisor runtime vs RPC reachability, the probe target URL, and which config the service likely used.

4. **Deep probes**

   ```bash
   openclaw status --deep
   ```

   Runs a live gateway health probe, including channel probes when supported
   (requires a reachable gateway). See [Health](/gateway/health).

5. **Tail the latest log**

   ```bash
   openclaw logs --follow
   ```

   If RPC is down, fall back to:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   File logs are separate from service logs; see [Logging](/logging) and [Troubleshooting](/gateway/troubleshooting).

6. **Run the doctor (repairs)**

   ```bash
   openclaw doctor
   ```

   Repairs/migrates config/state + runs health checks. See [Doctor](/gateway/doctor).

7. **Gateway snapshot**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   Asks the running gateway for a full snapshot (WS-only). See [Health](/gateway/health).

## Quick start and first-run setup

<AccordionGroup>
  <Accordion title="I am stuck, fastest way to get unstuck">
    Use a local AI agent that can **see your machine**. That is far more effective than asking
    in Discord, because most "I'm stuck" cases are **local config or environment issues** that
    remote helpers cannot inspect.

    - **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
    - **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

    These tools can read the repo, run commands, inspect logs, and help fix your machine-level
    setup (PATH, services, permissions, auth files). Give them the **full source checkout** via
    the hackable (git) install:

    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```

    This installs OpenClaw **from a git checkout**, so the agent can read the code + docs and
    reason about the exact version you are running. You can always switch back to stable later
    by re-running the installer without `--install-method git`.

    Tip: ask the agent to **plan and supervise** the fix (step-by-step), then execute only the
    necessary commands. That keeps changes small and easier to audit.

    If you discover a real bug or fix, please file a GitHub issue or send a PR:
    [https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
    [https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

    Start with these commands (share outputs when asking for help):

    ```bash
    openclaw status
    openclaw models status
    openclaw doctor
    ```

    What they do:

    - `openclaw status`: quick snapshot of gateway/agent health + basic config.
    - `openclaw models status`: checks provider auth + model availability.
    - `openclaw doctor`: validates and repairs common config/state issues.

    Other useful CLI checks: `openclaw status --all`, `openclaw logs --follow`,
    `openclaw gateway status`, `openclaw health --verbose`.

    Quick debug loop: [First 60 seconds if something is broken](#first-60-seconds-if-something-is-broken).
    Install docs: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating).

  </Accordion>

  <Accordion title="Heartbeat keeps skipping. What do the skip reasons mean?">
    Common heartbeat skip reasons:

    - `quiet-hours`: outside the configured active-hours window
    - `empty-heartbeat-file`: `HEARTBEAT.md` exists but only contains blank/header-only scaffolding
    - `no-tasks-due`: `HEARTBEAT.md` task mode is active but none of the task intervals are due yet
    - `alerts-disabled`: all heartbeat visibility is disabled (`showOk`, `showAlerts`, and `useIndicator` are all off)

    In task mode, due timestamps are only advanced after a real heartbeat run
    completes. Skipped runs do not mark tasks as completed.

    Docs: [Heartbeat](/gateway/heartbeat), [Automation & Tasks](/automation).

  </Accordion>

  <Accordion title="Recommended way to install and set up OpenClaw">
    The repo recommends running from source and using onboarding:

    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash
    openclaw onboard --install-daemon
    ```

    The wizard can also build UI assets automatically. After onboarding, you typically run the Gateway on port **18789**.

    From source (contributors/dev):

    ```bash
    git clone https://github.com/openclaw/openclaw.git
    cd openclaw
    pnpm install
    pnpm build
    pnpm ui:build
    openclaw onboard
    ```

    If you don't have a global install yet, run it via `pnpm openclaw onboard`.

  </Accordion>

  <Accordion title="How do I open the dashboard after onboarding?">
    The wizard opens your browser with a clean (non-tokenized) dashboard URL right after onboarding and also prints the link in the summary. Keep that tab open; if it didn't launch, copy/paste the printed URL on the same machine.
  </Accordion>

  <Accordion title="How do I authenticate the dashboard on localhost vs remote?">
    **Localhost (same machine):**

    - Open `http://127.0.0.1:18789/`.
    - If it asks for shared-secret auth, paste the configured token or password into Control UI settings.
    - Token source: `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`).
    - Password source: `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`).
    - If no shared secret is configured yet, generate a token with `openclaw doctor --generate-gateway-token`.

    **Not on localhost:**

    - **Tailscale Serve** (recommended): keep bind loopback, run `openclaw gateway --tailscale serve`, open `https://<magicdns>/`. If `gateway.auth.allowTailscale` is `true`, identity headers satisfy Control UI/WebSocket auth (no pasted shared secret, assumes trusted gateway host); HTTP APIs still require shared-secret auth unless you deliberately use private-ingress `none` or trusted-proxy HTTP auth.
      Bad concurrent Serve auth attempts from the same client are serialized before the failed-auth limiter records them, so the second bad retry can already show `retry later`.
    - **Tailnet bind**: run `openclaw gateway --bind tailnet --token "<token>"` (or configure password auth), open `http://<tailscale-ip>:18789/`, then paste the matching shared secret in dashboard settings.
    - **Identity-aware reverse proxy**: keep the Gateway behind a non-loopback trusted proxy, configure `gateway.auth.mode: "trusted-proxy"`, then open the proxy URL.
    - **SSH tunnel**: `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/`. Shared-secret auth still applies over the tunnel; paste the configured token or password if prompted.

    See [Dashboard](/web/dashboard) and [Web surfaces](/web) for bind modes and auth details.

  </Accordion>

  <Accordion title="Why are there two exec approval configs for chat approvals?">
    They control different layers:

    - `approvals.exec`: forwards approval prompts to chat destinations
    - `channels.<channel>.execApprovals`: makes that channel act as a native approval client for exec approvals

    The host exec policy is still the real approval gate. Chat config only controls where approval
    prompts appear and how people can answer them.

    In most setups you do **not** need both:

    - If the chat already supports commands and replies, same-chat `/approve` works through the shared path.
    - If a supported native channel can infer approvers safely, OpenClaw now auto-enables DM-first native approvals when `channels.<channel>.execApprovals.enabled` is unset or `"auto"`.
    - When native approval cards/buttons are available, that native UI is the primary path; the agent should only include a manual `/approve` command if the tool result says chat approvals are unavailable or manual approval is the only path.
    - Use `approvals.exec` only when prompts must also be forwarded to other chats or explicit ops rooms.
    - Use `channels.<channel>.execApprovals.target: "channel"` or `"both"` only when you explicitly want approval prompts posted back into the originating room/topic.
    - Plugin approvals are separate again: they use same-chat `/approve` by default, optional `approvals.plugin` forwarding, and only some native channels keep plugin-approval-native handling on top.

    Short version: forwarding is for routing, native client config is for richer channel-specific UX.
    See [Exec Approvals](/tools/exec-approvals).

  </Accordion>

  <Accordion title="What runtime do I need?">
    Node **>= 22** is required. `pnpm` is recommended. Bun is **not recommended** for the Gateway.
  </Accordion>

  <Accordion title="Does it run on Raspberry Pi?">
    Yes. The Gateway is lightweight - docs list **512MB-1GB RAM**, **1 core**, and about **500MB**
    disk as enough for personal use, and note that a **Raspberry Pi 4 can run it**.

    If you want extra headroom (logs, media, other services), **2GB is recommended**, but it's
    not a hard minimum.

    Tip: a small Pi/VPS can host the Gateway, and you can pair **nodes** on your laptop/phone for
    local screen/camera/canvas or command execution. See [Nodes](/nodes).

  </Accordion>

  <Accordion title="Any tips for Raspberry Pi installs?">
    Short version: it works, but expect rough edges.

    - Use a **64-bit** OS and keep Node >= 22.
    - Prefer the **hackable (git) install** so you can see logs and update fast.
    - Start without channels/skills, then add them one by one.
    - If you hit weird binary issues, it is usually an **ARM compatibility** problem.

    Docs: [Linux](/platforms/linux), [Install](/install).

  </Accordion>

  <Accordion title="It is stuck on wake up my friend / onboarding will not hatch. What now?">
    That screen depends on the Gateway being reachable and authenticated. The TUI also sends
    "Wake up, my friend!" automatically on first hatch. If you see that line with **no reply**
    and tokens stay at 0, the agent never ran.

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

    3. If it still hangs, run:

    ```bash
    openclaw doctor
    ```

    If the Gateway is remote, ensure the tunnel/Tailscale connection is up and that the UI
    is pointed at the right Gateway. See [Remote access](/gateway/remote).

  </Accordion>

  <Accordion title="Can I migrate my setup to a new machine (Mac mini) without redoing onboarding?">
    Yes. Copy the **state directory** and **workspace**, then run Doctor once. This
    keeps your bot "exactly the same" (memory, session history, auth, and channel
    state) as long as you copy **both** locations:

    1. Install OpenClaw on the new machine.
    2. Copy `$OPENCLAW_STATE_DIR` (default: `~/.openclaw`) from the old machine.
    3. Copy your workspace (default: `~/.openclaw/workspace`).
    4. Run `openclaw doctor` and restart the Gateway service.

    That preserves config, auth profiles, WhatsApp creds, sessions, and memory. If you're in
    remote mode, remember the gateway host owns the session store and workspace.

    **Important:** if you only commit/push your workspace to GitHub, you're backing
    up **memory + bootstrap files**, but **not** session history or auth. Those live
    under `~/.openclaw/` (for example `~/.openclaw/agents/<agentId>/sessions/`).

    Related: [Migrating](/install/migrating), [Where things live on disk](#where-things-live-on-disk),
    [Agent workspace](/concepts/agent-workspace), [Doctor](/gateway/doctor),
    [Remote mode](/gateway/remote).

  </Accordion>

  <Accordion title="Where do I see what is new in the latest version?">
    Check the GitHub changelog:
    [https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

    Newest entries are at the top. If the top section is marked **Unreleased**, the next dated
    section is the latest shipped version. Entries are grouped by **Highlights**, **Changes**, and
    **Fixes** (plus docs/other sections when needed).

  </Accordion>

  <Accordion title="Cannot access docs.openclaw.ai (SSL error)">
    Some Comcast/Xfinity connections incorrectly block `docs.openclaw.ai` via Xfinity
    Advanced Security. Disable it or allowlist `docs.openclaw.ai`, then retry.
    Please help us unblock it by reporting here: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

    If you still can't reach the site, the docs are mirrored on GitHub:
    [https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

  </Accordion>

  <Accordion title="Difference between stable and beta">
    **Stable** and **beta** are **npm dist-tags**, not separate code lines:

    - `latest` = stable
    - `beta` = early build for testing

    Usually, a stable release lands on **beta** first, then an explicit
    promotion step moves that same version to `latest`. Maintainers can also
    publish straight to `latest` when needed. That's why beta and stable can
    point at the **same version** after promotion.

    See what changed:
    [https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

    For install one-liners and the difference between beta and dev, see the accordion below.

  </Accordion>

  <Accordion title="How do I install the beta version and what is the difference between beta and dev?">
    **Beta** is the npm dist-tag `beta` (may match `latest` after promotion).
    **Dev** is the moving head of `main` (git); when published, it uses the npm dist-tag `dev`.

    One-liners (macOS/Linux):

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```

    Windows installer (PowerShell):
    [https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

    More detail: [Development channels](/install/development-channels) and [Installer flags](/install/installer).

  </Accordion>

  <Accordion title="How do I try the latest bits?">
    Two options:

    1. **Dev channel (git checkout):**

    ```bash
    openclaw update --channel dev
    ```

    This switches to the `main` branch and updates from source.

    2. **Hackable install (from the installer site):**

    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```

    That gives you a local repo you can edit, then update via git.

    If you prefer a clean clone manually, use:

    ```bash
    git clone https://github.com/openclaw/openclaw.git
    cd openclaw
    pnpm install
    pnpm build
    ```

    Docs: [Update](/cli/update), [Development channels](/install/development-channels),
    [Install](/install).

  </Accordion>

  <Accordion title="How long does install and onboarding usually take?">
    Rough guide:

    - **Install:** 2-5 minutes
    - **Onboarding:** 5-15 minutes depending on how many channels/models you configure

    If it hangs, use [Installer stuck](#quick-start-and-first-run-setup)
    and the fast debug loop in [I am stuck](#quick-start-and-first-run-setup).

  </Accordion>

  <Accordion title="Installer stuck? How do I get more feedback?">
    Re-run the installer with **verbose output**:

    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
    ```

    Beta install with verbose:

    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
    ```

    For a hackable (git) install:

    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
    ```

    Windows (PowerShell) equivalent:

    ```powershell
    # install.ps1 has no dedicated -Verbose flag yet.
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```

    More options: [Installer flags](/install/installer).

  </Accordion>

  <Accordion title="Windows install says git not found or openclaw not recognized">
    Two common Windows issues:

    **1) npm error spawn git / git not found**

    - Install **Git for Windows** and make sure `git` is on your PATH.
    - Close and reopen PowerShell, then re-run the installer.

    **2) openclaw is not recognized after install**

    - Your npm global bin folder is not on PATH.
    - Check the path:

      ```powershell
      npm config get prefix
      ```

    - Add that directory to your user PATH (no `\bin` suffix needed on Windows; on most systems it is `%AppData%\npm`).
    - Close and reopen PowerShell after updating PATH.

    If you want the smoothest Windows setup, use **WSL2** instead of native Windows.
    Docs: [Windows](/platforms/windows).

  </Accordion>

  <Accordion title="Windows exec output shows garbled Chinese text - what should I do?">
    This is usually a console code page mismatch on native Windows shells.

    Symptoms:

    - `system.run`/`exec` output renders Chinese as mojibake
    - The same command looks fine in another terminal profile

    Quick workaround in PowerShell:

    ```powershell
    chcp 65001
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    ```

    Then restart the Gateway and retry your command:

    ```powershell
    openclaw gateway restart
    ```

    If you still reproduce this on latest OpenClaw, track/report it in:

    - [Issue #30640](https://github.com/openclaw/openclaw/issues/30640)

  </Accordion>

  <Accordion title="The docs did not answer my question - how do I get a better answer?">
    Use the **hackable (git) install** so you have the full source and docs locally, then ask
    your bot (or Claude/Codex) _from that folder_ so it can read the repo and answer precisely.

    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```

    More detail: [Install](/install) and [Installer flags](/install/installer).

  </Accordion>

  <Accordion title="How do I install OpenClaw on Linux?">
    Short answer: follow the Linux guide, then run onboarding.

    - Linux quick path + service install: [Linux](/platforms/linux).
    - Full walkthrough: [Getting Started](/start/getting-started).
    - Installer + updates: [Install & updates](/install/updating).

  </Accordion>

  <Accordion title="How do I install OpenClaw on a VPS?">
    Any Linux VPS works. Install on the server, then use SSH/Tailscale to reach the Gateway.

    Guides: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
    Remote access: [Gateway remote](/gateway/remote).

  </Accordion>

  <Accordion title="Where are the cloud/VPS install guides?">
    We keep a **hosting hub** with the common providers. Pick one and follow the guide:

    - [VPS hosting](/vps) (all providers in one place)
    - [Fly.io](/install/fly)
    - [Hetzner](/install/hetzner)
    - [exe.dev](/install/exe-dev)

    How it works in the cloud: the **Gateway runs on the server**, and you access it
    from your laptop/phone via the Control UI (or Tailscale/SSH). Your state + workspace
    live on the server, so treat the host as the source of truth and back it up.

    You can pair **nodes** (Mac/iOS/Android/headless) to that cloud Gateway to access
    local screen/camera/canvas or run commands on your laptop while keeping the
    Gateway in the cloud.

    Hub: [Platforms](/platforms). Remote access: [Gateway remote](/gateway/remote).
    Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

  </Accordion>

  <Accordion title="Can I ask OpenClaw to update itself?">
    Short answer: **possible, not recommended**. The update flow can restart the
    Gateway (which drops the active session), may need a clean git checkout, and
    can prompt for confirmation. Safer: run updates from a shell as the operator.

    Use the CLI:

    ```bash
    openclaw update
    openclaw update status
    openclaw update --channel stable|beta|dev
    openclaw update --tag <dist-tag|version>
    openclaw update --no-restart
    ```

    If you must automate from an agent:

    ```bash
    openclaw update --yes --no-restart
    openclaw gateway restart
    ```

    Docs: [Update](/cli/update), [Updating](/install/updating).

  </Accordion>

  <Accordion title="What does onboarding actually do?">
    `openclaw onboard` is the recommended setup path. In **local mode** it walks you through:

    - **Model/auth setup** (provider OAuth, API keys, Anthropic setup-token, plus local model options such as LM Studio)
    - **Workspace** location + bootstrap files
    - **Gateway settings** (bind/port/auth/tailscale)
    - **Channels** (WhatsApp, Telegram, Discord, Mattermost, Signal, iMessage, plus bundled channel plugins like QQ Bot)
    - **Daemon install** (LaunchAgent on macOS; systemd user unit on Linux/WSL2)
    - **Health checks** and **skills** selection

    It also warns if your configured model is unknown or missing auth.

  </Accordion>

  <Accordion title="Do I need a Claude or OpenAI subscription to run this?">
    No. You can run OpenClaw with **API keys** (Anthropic/OpenAI/others) or with
    **local-only models** so your data stays on your device. Subscriptions (Claude
    Pro/Max or OpenAI Codex) are optional ways to authenticate those providers.

    For Anthropic in OpenClaw, the practical split is:

    - **Anthropic API key**: normal Anthropic API billing
    - **Claude CLI / Claude subscription auth in OpenClaw**: Anthropic staff
      told us this usage is allowed again, and OpenClaw is treating `claude -p`
      usage as sanctioned for this integration unless Anthropic publishes a new
      policy

    For long-lived gateway hosts, Anthropic API keys are still the more
    predictable setup. OpenAI Codex OAuth is explicitly supported for external
    tools like OpenClaw.

    OpenClaw also supports other hosted subscription-style options including
    **Qwen Cloud Coding Plan**, **MiniMax Coding Plan**, and
    **Z.AI / GLM Coding Plan**.

    Docs: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
    [Qwen Cloud](/providers/qwen),
    [MiniMax](/providers/minimax), [GLM Models](/providers/glm),
    [Local models](/gateway/local-models), [Models](/concepts/models).

  </Accordion>

  <Accordion title="Can I use Claude Max subscription without an API key?">
    Yes.

    Anthropic staff told us OpenClaw-style Claude CLI usage is allowed again, so
    OpenClaw treats Claude subscription auth and `claude -p` usage as sanctioned
    for this integration unless Anthropic publishes a new policy. If you want
    the most predictable server-side setup, use an Anthropic API key instead.

  </Accordion>

  <Accordion title="Do you support Claude subscription auth (Claude Pro or Max)?">
    Yes.

    Anthropic staff told us this usage is allowed again, so OpenClaw treats
    Claude CLI reuse and `claude -p` usage as sanctioned for this integration
    unless Anthropic publishes a new policy.

    Anthropic setup-token is still available as a supported OpenClaw token path, but OpenClaw now prefers Claude CLI reuse and `claude -p` when available.
    For production or multi-user workloads, Anthropic API key auth is still the
    safer, more predictable choice. If you want other subscription-style hosted
    options in OpenClaw, see [OpenAI](/providers/openai), [Qwen / Model
    Cloud](/providers/qwen), [MiniMax](/providers/minimax), and [GLM
    Models](/providers/glm).

  </Accordion>

<a id="why-am-i-seeing-http-429-ratelimiterror-from-anthropic"></a>
<Accordion title="Why am I seeing HTTP 429 rate_limit_error from Anthropic?">
That means your **Anthropic quota/rate limit** is exhausted for the current window. If you
use **Claude CLI**, wait for the window to reset or upgrade your plan. If you
use an **Anthropic API key**, check the Anthropic Console
for usage/billing and raise limits as needed.

    If the message is specifically:
    `Extra usage is required for long context requests`, the request is trying to use
    Anthropic's 1M context beta (`context1m: true`). That only works when your
    credential is eligible for long-context billing (API key billing or the
    OpenClaw Claude-login path with Extra Usage enabled).

    Tip: set a **fallback model** so OpenClaw can keep replying while a provider is rate-limited.
    See [Models](/cli/models), [OAuth](/concepts/oauth), and
    [/gateway/troubleshooting#anthropic-429-extra-usage-required-for-long-context](/gateway/troubleshooting#anthropic-429-extra-usage-required-for-long-context).

  </Accordion>

  <Accordion title="Is AWS Bedrock supported?">
    Yes. OpenClaw has a bundled **Amazon Bedrock (Converse)** provider. With AWS env markers present, OpenClaw can auto-discover the streaming/text Bedrock catalog and merge it as an implicit `amazon-bedrock` provider; otherwise you can explicitly enable `plugins.entries.amazon-bedrock.config.discovery.enabled` or add a manual provider entry. See [Amazon Bedrock](/providers/bedrock) and [Model providers](/providers/models). If you prefer a managed key flow, an OpenAI-compatible proxy in front of Bedrock is still a valid option.
  </Accordion>

  <Accordion title="How does Codex auth work?">
    OpenClaw supports **OpenAI Code (Codex)** via OAuth (ChatGPT sign-in). Onboarding can run the OAuth flow and will set the default model to `openai-codex/gpt-5.4` when appropriate. See [Model providers](/concepts/model-providers) and [Onboarding (CLI)](/start/wizard).
  </Accordion>

  <Accordion title="Why does ChatGPT GPT-5.4 not unlock openai/gpt-5.4 in OpenClaw?">
    OpenClaw treats the two routes separately:

    - `openai-codex/gpt-5.4` = ChatGPT/Codex OAuth
    - `openai/gpt-5.4` = direct OpenAI Platform API

    In OpenClaw, ChatGPT/Codex sign-in is wired to the `openai-codex/*` route,
    not the direct `openai/*` route. If you want the direct API path in
    OpenClaw, set `OPENAI_API_KEY` (or the equivalent OpenAI provider config).
    If you want ChatGPT/Codex sign-in in OpenClaw, use `openai-codex/*`.

  </Accordion>

  <Accordion title="Why can Codex OAuth limits differ from ChatGPT web?">
    `openai-codex/*` uses the Codex OAuth route, and its usable quota windows are
    OpenAI-managed and plan-dependent. In practice, those limits can differ from
    the ChatGPT website/app experience, even when both are tied to the same account.

    OpenClaw can show the currently visible provider usage/quota windows in
    `openclaw models status`, but it does not invent or normalize ChatGPT-web
    entitlements into direct API access. If you want the direct OpenAI Platform
    billing/limit path, use `openai/*` with an API key.

  </Accordion>

  <Accordion title="Do you support OpenAI subscription auth (Codex OAuth)?">
    Yes. OpenClaw fully supports **OpenAI Code (Codex) subscription OAuth**.
    OpenAI explicitly allows subscription OAuth usage in external tools/workflows
    like OpenClaw. Onboarding can run the OAuth flow for you.

    See [OAuth](/concepts/oauth), [Model providers](/concepts/model-providers), and [Onboarding (CLI)](/start/wizard).

  </Accordion>

  <Accordion title="How do I set up Gemini CLI OAuth?">
    Gemini CLI uses a **plugin auth flow**, not a client id or secret in `openclaw.json`.

    Steps:

    1. Install Gemini CLI locally so `gemini` is on `PATH`
       - Homebrew: `brew install gemini-cli`
       - npm: `npm install -g @google/gemini-cli`
    2. Enable the plugin: `openclaw plugins enable google`
    3. Login: `openclaw models auth login --provider google-gemini-cli --set-default`
    4. Default model after login: `google-gemini-cli/gemini-3-flash-preview`
    5. If requests fail, set `GOOGLE_CLOUD_PROJECT` or `GOOGLE_CLOUD_PROJECT_ID` on the gateway host

    This stores OAuth tokens in auth profiles on the gateway host. Details: [Model providers](/concepts/model-providers).

  </Accordion>

  <Accordion title="Is a local model OK for casual chats?">
    Usually no. OpenClaw needs large context + strong safety; small cards truncate and leak. If you must, run the **largest** model build you can locally (LM Studio) and see [/gateway/local-models](/gateway/local-models). Smaller/quantized models increase prompt-injection risk - see [Security](/gateway/security).
  </Accordion>

  <Accordion title="How do I keep hosted model traffic in a specific region?">
    Pick region-pinned endpoints. OpenRouter exposes US-hosted options for MiniMax, Kimi, and GLM; choose the US-hosted variant to keep data in-region. You can still list Anthropic/OpenAI alongside these by using `models.mode: "merge"` so fallbacks stay available while respecting the regioned provider you select.
  </Accordion>

  <Accordion title="Do I have to buy a Mac Mini to install this?">
    No. OpenClaw runs on macOS or Linux (Windows via WSL2). A Mac mini is optional - some people
    buy one as an always-on host, but a small VPS, home server, or Raspberry Pi-class box works too.

    You only need a Mac **for macOS-only tools**. For iMessage, use [BlueBubbles](/channels/bluebubbles) (recommended) - the BlueBubbles server runs on any Mac, and the Gateway can run on Linux or elsewhere. If you want other macOS-only tools, run the Gateway on a Mac or pair a macOS node.

    Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes), [Mac remote mode](/platforms/mac/remote).

  </Accordion>

  <Accordion title="Do I need a Mac mini for iMessage support?">
    You need **some macOS device** signed into Messages. It does **not** have to be a Mac mini -
    any Mac works. **Use [BlueBubbles](/channels/bluebubbles)** (recommended) for iMessage - the BlueBubbles server runs on macOS, while the Gateway can run on Linux or elsewhere.

    Common setups:

    - Run the Gateway on Linux/VPS, and run the BlueBubbles server on any Mac signed into Messages.
    - Run everything on the Mac if you want the simplest single-machine setup.

    Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),
    [Mac remote mode](/platforms/mac/remote).

  </Accordion>

  <Accordion title="If I buy a Mac mini to run OpenClaw, can I connect it to my MacBook Pro?">
    Yes. The **Mac mini can run the Gateway**, and your MacBook Pro can connect as a
    **node** (companion device). Nodes don't run the Gateway - they provide extra
    capabilities like screen/camera/canvas and `system.run` on that device.

    Common pattern:

    - Gateway on the Mac mini (always-on).
    - MacBook Pro runs the macOS app or a node host and pairs to the Gateway.
    - Use `openclaw nodes status` / `openclaw nodes list` to see it.

    Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

  </Accordion>

  <Accordion title="Can I use Bun?">
    Bun is **not recommended**. We see runtime bugs, especially with WhatsApp and Telegram.
    Use **Node** for stable gateways.

    If you still want to experiment with Bun, do it on a non-production gateway
    without WhatsApp/Telegram.

  </Accordion>

  <Accordion title="Telegram: what goes in allowFrom?">
    `channels.telegram.allowFrom` is **the human sender's Telegram user ID** (numeric). It is not the bot username.

    Setup asks for numeric user IDs only. If you already have legacy `@username` entries in config, `openclaw doctor --fix` can try to resolve them.

    Safer (no third-party bot):

    - DM your bot, then run `openclaw logs --follow` and read `from.id`.

    Official Bot API:

    - DM your bot, then call `https://api.telegram.org/bot<bot_token>/getUpdates` and read `message.from.id`.

    Third-party (less private):

    - DM `@userinfobot` or `@getidsbot`.

    See [/channels/telegram](/channels/telegram#access-control-and-activation).

  </Accordion>

  <Accordion title="Can multiple people use one WhatsApp number with different OpenClaw instances?">
    Yes, via **multi-agent routing**. Bind each sender's WhatsApp **DM** (peer `kind: "direct"`, sender E.164 like `+15551234567`) to a different `agentId`, so each person gets their own workspace and session store. Replies still come from the **same WhatsApp account**, and DM access control (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) is global per WhatsApp account. See [Multi-Agent Routing](/concepts/multi-agent) and [WhatsApp](/channels/whatsapp).
  </Accordion>

  <Accordion title='Can I run a "fast chat" agent and an "Opus for coding" agent?'>
    Yes. Use multi-agent routing: give each agent its own default model, then bind inbound routes (provider account or specific peers) to each agent. Example config lives in [Multi-Agent Routing](/concepts/multi-agent). See also [Models](/concepts/models) and [Configuration](/gateway/configuration).
  </Accordion>

  <Accordion title="Does Homebrew work on Linux?">
    Yes. Homebrew supports Linux (Linuxbrew). Quick setup:

    ```bash
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
    eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
    brew install <formula>
    ```

    If you run OpenClaw via systemd, ensure the service PATH includes `/home/linuxbrew/.linuxbrew/bin` (or your brew prefix) so `brew`-installed tools resolve in non-login shells.
    Recent builds also prepend common user bin dirs on Linux systemd services (for example `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/.bun/bin`) and honor `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, and `FNM_DIR` when set.

  </Accordion>

  <Accordion title="Difference between the hackable git install and npm install">
    - **Hackable (git) install:** full source checkout, editable, best for contributors.
      You run builds locally and can patch code/docs.
    - **npm install:** global CLI install, no repo, best for "just run it."
      Updates come from npm dist-tags.

    Docs: [Getting started](/start/getting-started), [Updating](/install/updating).

  </Accordion>

  <Accordion title="Can I switch between npm and git installs later?">
    Yes. Install the other flavor, then run Doctor so the gateway service points at the new entrypoint.
    This **does not delete your data** - it only changes the OpenClaw code install. Your state
    (`~/.openclaw`) and workspace (`~/.openclaw/workspace`) stay untouched.

    From npm to git:

    ```bash
    git clone https://github.com/openclaw/openclaw.git
    cd openclaw
    pnpm install
    pnpm build
    openclaw doctor
    openclaw gateway restart
    ```

    From git to npm:

    ```bash
    npm install -g openclaw@latest
    openclaw doctor
    openclaw gateway restart
    ```

    Doctor detects a gateway service entrypoint mismatch and offers to rewrite the service config to match the current install (use `--repair` in automation).

    Backup tips: see [Backup strategy](#where-things-live-on-disk).

  </Accordion>

  <Accordion title="Should I run the Gateway on my laptop or a VPS?">
    Short answer: **if you want 24/7 reliability, use a VPS**. If you want the
    lowest friction and you're okay with sleep/restarts, run it locally.

    **Laptop (local Gateway)**

    - **Pros:** no server cost, direct access to local files, live browser window.
    - **Cons:** sleep/network drops = disconnects, OS updates/reboots interrupt, must stay awake.

    **VPS / cloud**

    - **Pros:** always-on, stable network, no laptop sleep issues, easier to keep running.
    - **Cons:** often run headless (use screenshots), remote file access only, you must SSH for updates.

    **OpenClaw-specific note:** WhatsApp/Telegram/Slack/Mattermost/Discord all work fine from a VPS. The only real trade-off is **headless browser** vs a visible window. See [Browser](/tools/browser).

    **Recommended default:** VPS if you had gateway disconnects before. Local is great when you're actively using the Mac and want local file access or UI automation with a visible browser.

  </Accordion>

  <Accordion title="How important is it to run OpenClaw on a dedicated machine?">
    Not required, but **recommended for reliability and isolation**.

    - **Dedicated host (VPS/Mac mini/Pi):** always-on, fewer sleep/reboot interruptions, cleaner permissions, easier to keep running.
    - **Shared laptop/desktop:** totally fine for testing and active use, but expect pauses when the machine sleeps or updates.

    If you want the best of both worlds, keep the Gateway on a dedicated host and pair your laptop as a **node** for local screen/camera/exec tools. See [Nodes](/nodes).
    For security guidance, read [Security](/gateway/security).

  </Accordion>

  <Accordion title="What are the minimum VPS requirements and recommended OS?">
    OpenClaw is lightweight. For a basic Gateway + one chat channel:

    - **Absolute minimum:** 1 vCPU, 1GB RAM, ~500MB disk.
    - **Recommended:** 1-2 vCPU, 2GB RAM or more for headroom (logs, media, multiple channels). Node tools and browser automation can be resource hungry.

    OS: use **Ubuntu LTS** (or any modern Debian/Ubuntu). The Linux install path is best tested there.

    Docs: [Linux](/platforms/linux), [VPS hosting](/vps).

  </Accordion>

  <Accordion title="Can I run OpenClaw in a VM and what are the requirements?">
    Yes. Treat a VM the same as a VPS: it needs to be always on, reachable, and have enough
    RAM for the Gateway and any channels you enable.

    Baseline guidance:

    - **Absolute minimum:** 1 vCPU, 1GB RAM.
    - **Recommended:** 2GB RAM or more if you run multiple channels, browser automation, or media tools.
    - **OS:** Ubuntu LTS or another modern Debian/Ubuntu.

    If you are on Windows, **WSL2 is the easiest VM style setup** and has the best tooling
    compatibility. See [Windows](/platforms/windows), [VPS hosting](/vps).
    If you are running macOS in a VM, see [macOS VM](/install/macos-vm).

  </Accordion>
</AccordionGroup>

## What is OpenClaw?

<AccordionGroup>
  <Accordion title="What is OpenClaw, in one paragraph?">
    OpenClaw is a personal AI assistant you run on your own devices. It replies on the messaging surfaces you already use (WhatsApp, Telegram, Slack, Mattermost, Discord, Google Chat, Signal, iMessage, WebChat, and bundled channel plugins such as QQ Bot) and can also do voice + a live Canvas on supported platforms. The **Gateway** is the always-on control plane; the assistant is the product.
  </Accordion>

  <Accordion title="Value proposition">
    OpenClaw is not "just a Claude wrapper." It's a **local-first control plane** that lets you run a
    capable assistant on **your own hardware**, reachable from the chat apps you already use, with
    stateful sessions, memory, and tools - without handing control of your workflows to a hosted
    SaaS.

    Highlights:

    - **Your devices, your data:** run the Gateway wherever you want (Mac, Linux, VPS) and keep the
      workspace + session history local.
    - **Real channels, not a web sandbox:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,
      plus mobile voice and Canvas on supported platforms.
    - **Model-agnostic:** use Anthropic, OpenAI, MiniMax, OpenRouter, etc., with per-agent routing
      and failover.
    - **Local-only option:** run local models so **all data can stay on your device** if you want.
    - **Multi-agent routing:** separate agents per channel, account, or task, each with its own
      workspace and defaults.
    - **Open source and hackable:** inspect, extend, and self-host without vendor lock-in.

    Docs: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
    [Memory](/concepts/memory).

  </Accordion>

  <Accordion title="I just set it up - what should I do first?">
    Good first projects:

    - Build a website (WordPress, Shopify, or a simple static site).
    - Prototype a mobile app (outline, screens, API plan).
    - Organize files and folders (cleanup, naming, tagging).
    - Connect Gmail and automate summaries or follow ups.

    It can handle large tasks, but it works best when you split them into phases and
    use sub agents for parallel work.

  </Accordion>

  <Accordion title="What are the top five everyday use cases for OpenClaw?">
    Everyday wins usually look like:

    - **Personal briefings:** summaries of inbox, calendar, and news you care about.
    - **Research and drafting:** quick research, summaries, and first drafts for emails or docs.
    - **Reminders and follow ups:** cron or heartbeat driven nudges and checklists.
    - **Browser automation:** filling forms, collecting data, and repeating web tasks.
    - **Cross device coordination:** send a task from your phone, let the Gateway run it on a server, and get the result back in chat.

  </Accordion>

  <Accordion title="Can OpenClaw help with lead gen, outreach, ads, and blogs for a SaaS?">
    Yes for **research, qualification, and drafting**. It can scan sites, build shortlists,
    summarize prospects, and write outreach or ad copy drafts.

    For **outreach or ad runs**, keep a human in the loop. Avoid spam, follow local laws and
    platform policies, and review anything before it is sent. The safest pattern is to let
    OpenClaw draft and you approve.

    Docs: [Security](/gateway/security).

  </Accordion>

  <Accordion title="What are the advantages vs Claude Code for web development?">
    OpenClaw is a **personal assistant** and coordination layer, not an IDE replacement. Use
    Claude Code or Codex for the fastest direct coding loop inside a repo. Use OpenClaw when you
    want durable memory, cross-device access, and tool orchestration.

    Advantages:

    - **Persistent memory + workspace** across sessions
    - **Multi-platform access** (WhatsApp, Telegram, TUI, WebChat)
    - **Tool orchestration** (browser, files, scheduling, hooks)
    - **Always-on Gateway** (run on a VPS, interact from anywhere)
    - **Nodes** for local browser/screen/camera/exec

    Showcase: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

  </Accordion>
</AccordionGroup>

## Skills and automation

<AccordionGroup>
  <Accordion title="How do I customize skills without keeping the repo dirty?">
    Use managed overrides instead of editing the repo copy. Put your changes in `~/.openclaw/skills/<name>/SKILL.md` (or add a folder via `skills.load.extraDirs` in `~/.openclaw/openclaw.json`). Precedence is `<workspace>/skills` → `<workspace>/.agents/skills` → `~/.agents/skills` → `~/.openclaw/skills` → bundled → `skills.load.extraDirs`, so managed overrides still win over bundled skills without touching git. If you need the skill installed globally but only visible to some agents, keep the shared copy in `~/.openclaw/skills` and control visibility with `agents.defaults.skills` and `agents.list[].skills`. Only upstream-worthy edits should live in the repo and go out as PRs.
  </Accordion>

  <Accordion title="Can I load skills from a custom folder?">
    Yes. Add extra directories via `skills.load.extraDirs` in `~/.openclaw/openclaw.json` (lowest precedence). Default precedence is `<workspace>/skills` → `<workspace>/.agents/skills` → `~/.agents/skills` → `~/.openclaw/skills` → bundled → `skills.load.extraDirs`. `clawhub` installs into `./skills` by default, which OpenClaw treats as `<workspace>/skills` on the next session. If the skill should only be visible to certain agents, pair that with `agents.defaults.skills` or `agents.list[].skills`.
  </Accordion>

  <Accordion title="How can I use different models for different tasks?">
    Today the supported patterns are:

    - **Cron jobs**: isolated jobs can set a `model` override per job.
    - **Sub-agents**: route tasks to separate agents with different default models.
    - **On-demand switch**: use `/model` to switch the current session model at any time.

    See [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent), and [Slash commands](/tools/slash-commands).

  </Accordion>

  <Accordion title="The bot freezes while doing heavy work. How do I offload that?">
    Use **sub-agents** for long or parallel tasks. Sub-agents run in their own session,
    return a summary, and keep your main chat responsive.

    Ask your bot to "spawn a sub-agent for this task" or use `/subagents`.
    Use `/status` in chat to see what the Gateway is doing right now (and whether it is busy).

    Token tip: long tasks and sub-agents both consume tokens. If cost is a concern, set a
    cheaper model for sub-agents via `agents.defaults.subagents.model`.

    Docs: [Sub-agents](/tools/subagents), [Background Tasks](/automation/tasks).

  </Accordion>

  <Accordion title="How do thread-bound subagent sessions work on Discord?">
    Use thread bindings. You can bind a Discord thread to a subagent or session target so follow-up messages in that thread stay on that bound session.

    Basic flow:

    - Spawn with `sessions_spawn` using `thread: true` (and optionally `mode: "session"` for persistent follow-up).
    - Or manually bind with `/focus <target>`.
    - Use `/agents` to inspect binding state.
    - Use `/session idle <duration|off>` and `/session max-age <duration|off>` to control auto-unfocus.
    - Use `/unfocus` to detach the thread.

    Required config:

    - Global defaults: `session.threadBindings.enabled`, `session.threadBindings.idleHours`, `session.threadBindings.maxAgeHours`.
    - Discord overrides: `channels.discord.threadBindings.enabled`, `channels.discord.threadBindings.idleHours`, `channels.discord.threadBindings.maxAgeHours`.
    - Auto-bind on spawn: set `channels.discord.threadBindings.spawnSubagentSessions: true`.

    Docs: [Sub-agents](/tools/subagents), [Discord](/channels/discord), [Configuration Reference](/gateway/configuration-reference), [Slash commands](/tools/slash-commands).

  </Accordion>

  <Accordion title="A subagent finished, but the completion update went to the wrong place or never posted. What should I check?">
    Check the resolved requester route first:

    - Completion-mode subagent delivery prefers any bound thread or conversation route when one exists.
    - If the completion origin only carries a channel, OpenClaw falls back to the requester session's stored route (`lastChannel` / `lastTo` / `lastAccountId`) so direct delivery can still succeed.
    - If neither a bound route nor a usable stored route exists, direct delivery can fail and the result falls back to queued session delivery instead of posting immediately to chat.
    - Invalid or stale targets can still force queue fallback or final delivery failure.
    - If the child's last visible assistant reply is the exact silent token `NO_REPLY` / `no_reply`, or exactly `ANNOUNCE_SKIP`, OpenClaw intentionally suppresses the announce instead of posting stale earlier progress.
    - If the child timed out after only tool calls, the announce can collapse that into a short partial-progress summary instead of replaying raw tool output.

    Debug:

    ```bash
    openclaw tasks show <runId-or-sessionKey>
    ```

    Docs: [Sub-agents](/tools/subagents), [Background Tasks](/automation/tasks), [Session Tools](/concepts/session-tool).

  </Accordion>

  <Accordion title="Cron or reminders do not fire. What should I check?">
    Cron runs inside the Gateway process. If the Gateway is not running continuously,
    scheduled jobs will not run.

    Checklist:

    - Confirm cron is enabled (`cron.enabled`) and `OPENCLAW_SKIP_CRON` is not set.
    - Check the Gateway is running 24/7 (no sleep/restarts).
    - Verify timezone settings for the job (`--tz` vs host timezone).

    Debug:

    ```bash
    openclaw cron run <jobId>
    openclaw cron runs --id <jobId> --limit 50
    ```

    Docs: [Cron jobs](/automation/cron-jobs), [Automation & Tasks](/automation).

  </Accordion>

  <Accordion title="Cron fired, but nothing was sent to the channel. Why?">
    Check the delivery mode first:

    - `--no-deliver` / `delivery.mode: "none"` means no external message is expected.
    - Missing or invalid announce target (`channel` / `to`) means the runner skipped outbound delivery.
    - Channel auth failures (`unauthorized`, `Forbidden`) mean the runner tried to deliver but credentials blocked it.
    - A silent isolated result (`NO_REPLY` / `no_reply` only) is treated as intentionally non-deliverable, so the runner also suppresses queued fallback delivery.

    For isolated cron jobs, the runner owns final delivery. The agent is expected
    to return a plain-text summary for the runner to send. `--no-deliver` keeps
    that result internal; it does not let the agent send directly with the
    message tool instead.

    Debug:

    ```bash
    openclaw cron runs --id <jobId> --limit 50
    openclaw tasks show <runId-or-sessionKey>
    ```

    Docs: [Cron jobs](/automation/cron-jobs), [Background Tasks](/automation/tasks).

  </Accordion>

  <Accordion title="Why did an isolated cron run switch models or retry once?">
    That is usually the live model-switch path, not duplicate scheduling.

    Isolated cron can persist a runtime model handoff and retry when the active
    run throws `LiveSessionModelSwitchError`. The retry keeps the switched
    provider/model, and if the switch carried a new auth profile override, cron
    persists that too before retrying.

    Related selection rules:

    - Gmail hook model override wins first when applicable.
    - Then per-job `model`.
    - Then any stored cron-session model override.
    - Then the normal agent/default model selection.

    The retry loop is bounded. After the initial attempt plus 2 switch retries,
    cron aborts instead of looping forever.

    Debug:

    ```bash
    openclaw cron runs --id <jobId> --limit 50
    openclaw tasks show <runId-or-sessionKey>
    ```

    Docs: [Cron jobs](/automation/cron-jobs), [cron CLI](/cli/cron).

  </Accordion>

  <Accordion title="How do I install skills on Linux?">
    Use native `openclaw skills` commands or drop skills into your workspace. The macOS Skills UI isn't available on Linux.
    Browse skills at [https://clawhub.ai](https://clawhub.ai).

    ```bash
    openclaw skills search "calendar"
    openclaw skills search --limit 20
    openclaw skills install <skill-slug>
    openclaw skills install <skill-slug> --version <version>
    openclaw skills install <skill-slug> --force
    openclaw skills update --all
    openclaw skills list --eligible
    openclaw skills check
    ```

    Native `openclaw skills install` writes into the active workspace `skills/`
    directory. Install the separate `clawhub` CLI only if you want to publish or
    sync your own skills. For shared installs across agents, put the skill under
    `~/.openclaw/skills` and use `agents.defaults.skills` or
    `agents.list[].skills` if you want to narrow which agents can see it.

  </Accordion>

  <Accordion title="Can OpenClaw run tasks on a schedule or continuously in the background?">
    Yes. Use the Gateway scheduler:

    - **Cron jobs** for scheduled or recurring tasks (persist across restarts).
    - **Heartbeat** for "main session" periodic checks.
    - **Isolated jobs** for autonomous agents that post summaries or deliver to chats.

    Docs: [Cron jobs](/automation/cron-jobs), [Automation & Tasks](/automation),
    [Heartbeat](/gateway/heartbeat).

  </Accordion>

  <Accordion title="Can I run Apple macOS-only skills from Linux?">
    Not directly. macOS skills are gated by `metadata.openclaw.os` plus required binaries, and skills only appear in the system prompt when they are eligible on the **Gateway host**. On Linux, `darwin`-only skills (like `apple-notes`, `apple-reminders`, `things-mac`) will not load unless you override the gating.

    You have three supported patterns:

    **Option A - run the Gateway on a Mac (simplest).**
    Run the Gateway where the macOS binaries exist, then connect from Linux in [remote mode](#gateway-ports-already-running-and-remote-mode) or over Tailscale. The skills load normally because the Gateway host is macOS.

    **Option B - use a macOS node (no SSH).**
    Run the Gateway on Linux, pair a macOS node (menubar app), and set **Node Run Commands** to "Always Ask" or "Always Allow" on the Mac. OpenClaw can treat macOS-only skills as eligible when the required binaries exist on the node. The agent runs those skills via the `nodes` tool. If you choose "Always Ask", approving "Always Allow" in the prompt adds that command to the allowlist.

    **Option C - proxy macOS binaries over SSH (advanced).**
    Keep the Gateway on Linux, but make the required CLI binaries resolve to SSH wrappers that run on a Mac. Then override the skill to allow Linux so it stays eligible.

    1. Create an SSH wrapper for the binary (example: `memo` for Apple Notes):

       ```bash
       #!/usr/bin/env bash
       set -euo pipefail
       exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
       ```

    2. Put the wrapper on `PATH` on the Linux host (for example `~/bin/memo`).
    3. Override the skill metadata (workspace or `~/.openclaw/skills`) to allow Linux:

       ```markdown
       ---
       name: apple-notes
       description: Manage Apple Notes via the memo CLI on macOS.
       metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
       ---
       ```

    4. Start a new session so the skills snapshot refreshes.

  </Accordion>

  <Accordion title="Do you have a Notion or HeyGen integration?">
    Not built-in today.

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
    openclaw skills install <skill-slug>
    openclaw skills update --all
    ```

    Native installs land in the active workspace `skills/` directory. For shared skills across agents, place them in `~/.openclaw/skills/<name>/SKILL.md`. If only some agents should see a shared install, configure `agents.defaults.skills` or `agents.list[].skills`. Some skills expect binaries installed via Homebrew; on Linux that means Linuxbrew (see the Homebrew Linux FAQ entry above). See [Skills](/tools/skills), [Skills config](/tools/skills-config), and [ClawHub](/tools/clawhub).

  </Accordion>

  <Accordion title="How do I use my existing signed-in Chrome with OpenClaw?">
    Use the built-in `user` browser profile, which attaches through Chrome DevTools MCP:

    ```bash
    openclaw browser --browser-profile user tabs
    openclaw browser --browser-profile user snapshot
    ```

    If you want a custom name, create an explicit MCP profile:

    ```bash
    openclaw browser create-profile --name chrome-live --driver existing-session
    openclaw browser --browser-profile chrome-live tabs
    ```

    This path can use the local host browser or a connected browser node. If the Gateway runs elsewhere, either run a node host on the browser machine or use remote CDP instead.

    Current limits on `existing-session` / `user`:

    - actions are ref-driven, not CSS-selector driven
    - uploads require `ref` / `inputRef` and currently support one file at a time
    - `responsebody`, PDF export, download interception, and batch actions still need a managed browser or raw CDP profile

  </Accordion>
</AccordionGroup>

## Sandboxing and memory

<AccordionGroup>
  <Accordion title="Is there a dedicated sandboxing doc?">
    Yes. See [Sandboxing](/gateway/sandboxing). For Docker-specific setup (full gateway in Docker or sandbox images), see [Docker](/install/docker).
  </Accordion>

  <Accordion title="Docker feels limited - how do I enable full features?">
    The default image is security-first and runs as the `node` user, so it does not
    include system packages, Homebrew, or bundled browsers. For a fuller setup:

    - Persist `/home/node` with `OPENCLAW_HOME_VOLUME` so caches survive.
    - Bake system deps into the image with `OPENCLAW_DOCKER_APT_PACKAGES`.
    - Install Playwright browsers via the bundled CLI:
      `node /app/node_modules/playwright-core/cli.js install chromium`
    - Set `PLAYWRIGHT_BROWSERS_PATH` and ensure the path is persisted.

    Docs: [Docker](/install/docker), [Browser](/tools/browser).

  </Accordion>

  <Accordion title="Can I keep DMs personal but make groups public/sandboxed with one agent?">
    Yes - if your private traffic is **DMs** and your public traffic is **groups**.

    Use `agents.defaults.sandbox.mode: "non-main"` so group/channel sessions (non-main keys) run in Docker, while the main DM session stays on-host. Then restrict what tools are available in sandboxed sessions via `tools.sandbox.tools`.

    Setup walkthrough + example config: [Groups: personal DMs + public groups](/channels/groups#pattern-personal-dms-public-groups-single-agent)

    Key config reference: [Gateway configuration](/gateway/configuration-reference#agentsdefaultssandbox)

  </Accordion>

  <Accordion title="How do I bind a host folder into the sandbox?">
    Set `agents.defaults.sandbox.docker.binds` to `["host:path:mode"]` (e.g., `"/home/user/src:/src:ro"`). Global + per-agent binds merge; per-agent binds are ignored when `scope: "shared"`. Use `:ro` for anything sensitive and remember binds bypass the sandbox filesystem walls.

    OpenClaw validates bind sources against both the normalized path and the canonical path resolved through the deepest existing ancestor. That means symlink-parent escapes still fail closed even when the last path segment does not exist yet, and allowed-root checks still apply after symlink resolution.

    See [Sandboxing](/gateway/sandboxing#custom-bind-mounts) and [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) for examples and safety notes.

  </Accordion>

  <Accordion title="How does memory work?">
    OpenClaw memory is just Markdown files in the agent workspace:

    - Daily notes in `memory/YYYY-MM-DD.md`
    - Curated long-term notes in `MEMORY.md` (main/private sessions only)

    OpenClaw also runs a **silent pre-compaction memory flush** to remind the model
    to write durable notes before auto-compaction. This only runs when the workspace
    is writable (read-only sandboxes skip it). See [Memory](/concepts/memory).

  </Accordion>

  <Accordion title="Memory keeps forgetting things. How do I make it stick?">
    Ask the bot to **write the fact to memory**. Long-term notes belong in `MEMORY.md`,
    short-term context goes into `memory/YYYY-MM-DD.md`.

    This is still an area we are improving. It helps to remind the model to store memories;
    it will know what to do. If it keeps forgetting, verify the Gateway is using the same
    workspace on every run.

    Docs: [Memory](/concepts/memory), [Agent workspace](/concepts/agent-workspace).

  </Accordion>

  <Accordion title="Does memory persist forever? What are the limits?">
    Memory files live on disk and persist until you delete them. The limit is your
    storage, not the model. The **session context** is still limited by the model
    context window, so long conversations can compact or truncate. That is why
    memory search exists - it pulls only the relevant parts back into context.

    Docs: [Memory](/concepts/memory), [Context](/concepts/context).

  </Accordion>

  <Accordion title="Does semantic memory search require an OpenAI API key?">
    Only if you use **OpenAI embeddings**. Codex OAuth covers chat/completions and
    does **not** grant embeddings access, so **signing in with Codex (OAuth or the
    Codex CLI login)** does not help for semantic memory search. OpenAI embeddings
    still need a real API key (`OPENAI_API_KEY` or `models.providers.openai.apiKey`).

    If you don't set a provider explicitly, OpenClaw auto-selects a provider when it
    can resolve an API key (auth profiles, `models.providers.*.apiKey`, or env vars).
    It prefers OpenAI if an OpenAI key resolves, otherwise Gemini if a Gemini key
    resolves, then Voyage, then Mistral. If no remote key is available, memory
    search stays disabled until you configure it. If you have a local model path
    configured and present, OpenClaw
    prefers `local`. Ollama is supported when you explicitly set
    `memorySearch.provider = "ollama"`.

    If you'd rather stay local, set `memorySearch.provider = "local"` (and optionally
    `memorySearch.fallback = "none"`). If you want Gemini embeddings, set
    `memorySearch.provider = "gemini"` and provide `GEMINI_API_KEY` (or
    `memorySearch.remote.apiKey`). We support **OpenAI, Gemini, Voyage, Mistral, Ollama, or local** embedding
    models - see [Memory](/concepts/memory) for the setup details.

  </Accordion>
</AccordionGroup>

## Where things live on disk

<AccordionGroup>
  <Accordion title="Is all data used with OpenClaw saved locally?">
    No - **OpenClaw's state is local**, but **external services still see what you send them**.

    - **Local by default:** sessions, memory files, config, and workspace live on the Gateway host
      (`~/.openclaw` + your workspace directory).
    - **Remote by necessity:** messages you send to model providers (Anthropic/OpenAI/etc.) go to
      their APIs, and chat platforms (WhatsApp/Telegram/Slack/etc.) store message data on their
      servers.
    - **You control the footprint:** using local models keeps prompts on your machine, but channel
      traffic still goes through the channel's servers.

    Related: [Agent workspace](/concepts/agent-workspace), [Memory](/concepts/memory).

  </Accordion>

  <Accordion title="Where does OpenClaw store its data?">
    Everything lives under `$OPENCLAW_STATE_DIR` (default: `~/.openclaw`):

    | Path                                                            | Purpose                                                            |
    | --------------------------------------------------------------- | ------------------------------------------------------------------ |
    | `$OPENCLAW_STATE_DIR/openclaw.json`                             | Main config (JSON5)                                                |
    | `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | Legacy OAuth import (copied into auth profiles on first use)       |
    | `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | Auth profiles (OAuth, API keys, and optional `keyRef`/`tokenRef`)  |
    | `$OPENCLAW_STATE_DIR/secrets.json`                              | Optional file-backed secret payload for `file` SecretRef providers |
    | `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | Legacy compatibility file (static `api_key` entries scrubbed)      |
    | `$OPENCLAW_STATE_DIR/credentials/`                              | Provider state (e.g. `whatsapp/<accountId>/creds.json`)            |
    | `$OPENCLAW_STATE_DIR/agents/`                                   | Per-agent state (agentDir + sessions)                              |
    | `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | Conversation history & state (per agent)                           |
    | `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | Session metadata (per agent)                                       |

    Legacy single-agent path: `~/.openclaw/agent/*` (migrated by `openclaw doctor`).

    Your **workspace** (AGENTS.md, memory files, skills, etc.) is separate and configured via `agents.defaults.workspace` (default: `~/.openclaw/workspace`).

  </Accordion>

  <Accordion title="Where should AGENTS.md / SOUL.md / USER.md / MEMORY.md live?">
    These files live in the **agent workspace**, not `~/.openclaw`.

    - **Workspace (per agent)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
      `MEMORY.md` (or legacy fallback `memory.md` when `MEMORY.md` is absent),
      `memory/YYYY-MM-DD.md`, optional `HEARTBEAT.md`.
    - **State dir (`~/.openclaw`)**: config, channel/provider state, auth profiles, sessions, logs,
      and shared skills (`~/.openclaw/skills`).

    Default workspace is `~/.openclaw/workspace`, configurable via:

    ```json5
    {
      agents: { defaults: { workspace: "~/.openclaw/workspace" } },
    }
    ```

    If the bot "forgets" after a restart, confirm the Gateway is using the same
    workspace on every launch (and remember: remote mode uses the **gateway host's**
    workspace, not your local laptop).

    Tip: if you want a durable behavior or preference, ask the bot to **write it into
    AGENTS.md or MEMORY.md** rather than relying on chat history.

    See [Agent workspace](/concepts/agent-workspace) and [Memory](/concepts/memory).

  </Accordion>

  <Accordion title="Recommended backup strategy">
    Put your **agent workspace** in a **private** git repo and back it up somewhere
    private (for example GitHub private). This captures memory + AGENTS/SOUL/USER
    files, and lets you restore the assistant's "mind" later.

    Do **not** commit anything under `~/.openclaw` (credentials, sessions, tokens, or encrypted secrets payloads).
    If you need a full restore, back up both the workspace and the state directory
    separately (see the migration question above).

    Docs: [Agent workspace](/concepts/agent-workspace).

  </Accordion>

  <Accordion title="How do I completely uninstall OpenClaw?">
    See the dedicated guide: [Uninstall](/install/uninstall).
  </Accordion>

  <Accordion title="Can agents work outside the workspace?">
    Yes. The workspace is the **default cwd** and memory anchor, not a hard sandbox.
    Relative paths resolve inside the workspace, but absolute paths can access other
    host locations unless sandboxing is enabled. If you need isolation, use
    [`agents.defaults.sandbox`](/gateway/sandboxing) or per-agent sandbox settings. If you
    want a repo to be the default working directory, point that agent's
    `workspace` to the repo root. The OpenClaw repo is just source code; keep the
    workspace separate unless you intentionally want the agent to work inside it.

    Example (repo as default cwd):

    ```json5
    {
      agents: {
        defaults: {
          workspace: "~/Projects/my-repo",
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Remote mode: where is the session store?">
    Session state is owned by the **gateway host**. If you're in remote mode, the session store you care about is on the remote machine, not your local laptop. See [Session management](/concepts/session).
  </Accordion>
</AccordionGroup>

## Config basics

<AccordionGroup>
  <Accordion title="What format is the config? Where is it?">
    OpenClaw reads an optional **JSON5** config from `$OPENCLAW_CONFIG_PATH` (default: `~/.openclaw/openclaw.json`):

    ```
    $OPENCLAW_CONFIG_PATH
    ```

    If the file is missing, it uses safe-ish defaults (including a default workspace of `~/.openclaw/workspace`).

  </Accordion>

  <Accordion title='I set gateway.bind: "lan" (or "tailnet") and now nothing listens / the UI says unauthorized'>
    Non-loopback binds **require a valid gateway auth path**. In practice that means:

    - shared-secret auth: token or password
    - `gateway.auth.mode: "trusted-proxy"` behind a correctly configured non-loopback identity-aware reverse proxy

    ```json5
    {
      gateway: {
        bind: "lan",
        auth: {
          mode: "token",
          token: "replace-me",
        },
      },
    }
    ```

    Notes:

    - `gateway.remote.token` / `.password` do **not** enable local gateway auth by themselves.
    - Local call paths can use `gateway.remote.*` as fallback only when `gateway.auth.*` is unset.
    - For password auth, set `gateway.auth.mode: "password"` plus `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`) instead.
    - If `gateway.auth.token` / `gateway.auth.password` is explicitly configured via SecretRef and unresolved, resolution fails closed (no remote fallback masking).
    - Shared-secret Control UI setups authenticate via `connect.params.auth.token` or `connect.params.auth.password` (stored in app/UI settings). Identity-bearing modes such as Tailscale Serve or `trusted-proxy` use request headers instead. Avoid putting shared secrets in URLs.
    - With `gateway.auth.mode: "trusted-proxy"`, same-host loopback reverse proxies still do **not** satisfy trusted-proxy auth. The trusted proxy must be a configured non-loopback source.

  </Accordion>

  <Accordion title="Why do I need a token on localhost now?">
    OpenClaw enforces gateway auth by default, including loopback. In the normal default path that means token auth: if no explicit auth path is configured, gateway startup resolves to token mode and auto-generates one, saving it to `gateway.auth.token`, so **local WS clients must authenticate**. This blocks other local processes from calling the Gateway.

    If you prefer a different auth path, you can explicitly choose password mode (or, for non-loopback identity-aware reverse proxies, `trusted-proxy`). If you **really** want open loopback, set `gateway.auth.mode: "none"` explicitly in your config. Doctor can generate a token for you any time: `openclaw doctor --generate-gateway-token`.

  </Accordion>

  <Accordion title="Do I have to restart after changing config?">
    The Gateway watches the config and supports hot-reload:

    - `gateway.reload.mode: "hybrid"` (default): hot-apply safe changes, restart for critical ones
    - `hot`, `restart`, `off` are also supported

  </Accordion>

  <Accordion title="How do I disable funny CLI taglines?">
    Set `cli.banner.taglineMode` in config:

    ```json5
    {
      cli: {
        banner: {
          taglineMode: "off", // random | default | off
        },
      },
    }
    ```

    - `off`: hides tagline text but keeps the banner title/version line.
    - `default`: uses `All your chats, one OpenClaw.` every time.
    - `random`: rotating funny/seasonal taglines (default behavior).
    - If you want no banner at all, set env `OPENCLAW_HIDE_BANNER=1`.

  </Accordion>

  <Accordion title="How do I enable web search (and web fetch)?">
    `web_fetch` works without an API key. `web_search` depends on your selected
    provider:

    - API-backed providers such as Brave, Exa, Firecrawl, Gemini, Grok, Kimi, MiniMax Search, Perplexity, and Tavily require their normal API key setup.
    - Ollama Web Search is key-free, but it uses your configured Ollama host and requires `ollama signin`.
    - DuckDuckGo is key-free, but it is an unofficial HTML-based integration.
    - SearXNG is key-free/self-hosted; configure `SEARXNG_BASE_URL` or `plugins.entries.searxng.config.webSearch.baseUrl`.

    **Recommended:** run `openclaw configure --section web` and choose a provider.
    Environment alternatives:

    - Brave: `BRAVE_API_KEY`
    - Exa: `EXA_API_KEY`
    - Firecrawl: `FIRECRAWL_API_KEY`
    - Gemini: `GEMINI_API_KEY`
    - Grok: `XAI_API_KEY`
    - Kimi: `KIMI_API_KEY` or `MOONSHOT_API_KEY`
    - MiniMax Search: `MINIMAX_CODE_PLAN_KEY`, `MINIMAX_CODING_API_KEY`, or `MINIMAX_API_KEY`
    - Perplexity: `PERPLEXITY_API_KEY` or `OPENROUTER_API_KEY`
    - SearXNG: `SEARXNG_BASE_URL`
    - Tavily: `TAVILY_API_KEY`

    ```json5
    {
      plugins: {
        entries: {
          brave: {
            config: {
              webSearch: {
                apiKey: "BRAVE_API_KEY_HERE",
              },
            },
          },
        },
        },
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "brave",
              maxResults: 5,
            },
            fetch: {
              enabled: true,
              provider: "firecrawl", // optional; omit for auto-detect
            },
          },
        },
    }
    ```

    Provider-specific web-search config now lives under `plugins.entries.<plugin>.config.webSearch.*`.
    Legacy `tools.web.search.*` provider paths still load temporarily for compatibility, but they should not be used for new configs.
    Firecrawl web-fetch fallback config lives under `plugins.entries.firecrawl.config.webFetch.*`.

    Notes:

    - If you use allowlists, add `web_search`/`web_fetch`/`x_search` or `group:web`.
    - `web_fetch` is enabled by default (unless explicitly disabled).
    - If `tools.web.fetch.provider` is omitted, OpenClaw auto-detects the first ready fetch fallback provider from available credentials. Today the bundled provider is Firecrawl.
    - Daemons read env vars from `~/.openclaw/.env` (or the service environment).

    Docs: [Web tools](/tools/web).

  </Accordion>

  <Accordion title="config.apply wiped my config. How do I recover and avoid this?">
    `config.apply` replaces the **entire config**. If you send a partial object, everything
    else is removed.

    Recover:

    - Restore from backup (git or a copied `~/.openclaw/openclaw.json`).
    - If you have no backup, re-run `openclaw doctor` and reconfigure channels/models.
    - If this was unexpected, file a bug and include your last known config or any backup.
    - A local coding agent can often reconstruct a working config from logs or history.

    Avoid it:

    - Use `openclaw config set` for small changes.
    - Use `openclaw configure` for interactive edits.
    - Use `config.schema.lookup` first when you are not sure about an exact path or field shape; it returns a shallow schema node plus immediate child summaries for drill-down.
    - Use `config.patch` for partial RPC edits; keep `config.apply` for full-config replacement only.
    - If you are using the owner-only `gateway` tool from an agent run, it will still reject writes to `tools.exec.ask` / `tools.exec.security` (including legacy `tools.bash.*` aliases that normalize to the same protected exec paths).

    Docs: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

  </Accordion>

  <Accordion title="How do I run a central Gateway with specialized workers across devices?">
    The common pattern is **one Gateway** (e.g. Raspberry Pi) plus **nodes** and **agents**:

    - **Gateway (central):** owns channels (Signal/WhatsApp), routing, and sessions.
    - **Nodes (devices):** Macs/iOS/Android connect as peripherals and expose local tools (`system.run`, `canvas`, `camera`).
    - **Agents (workers):** separate brains/workspaces for special roles (e.g. "Hetzner ops", "Personal data").
    - **Sub-agents:** spawn background work from a main agent when you want parallelism.
    - **TUI:** connect to the Gateway and switch agents/sessions.

    Docs: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

  </Accordion>

  <Accordion title="Can the OpenClaw browser run headless?">
    Yes. It's a config option:

    ```json5
    {
      browser: { headless: true },
      agents: {
        defaults: {
          sandbox: { browser: { headless: true } },
        },
      },
    }
    ```

    Default is `false` (headful). Headless is more likely to trigger anti-bot checks on some sites. See [Browser](/tools/browser).

    Headless uses the **same Chromium engine** and works for most automation (forms, clicks, scraping, logins). The main differences:

    - No visible browser window (use screenshots if you need visuals).
    - Some sites are stricter about automation in headless mode (CAPTCHAs, anti-bot).
      For example, X/Twitter often blocks headless sessions.

  </Accordion>

  <Accordion title="How do I use Brave for browser control?">
    Set `browser.executablePath` to your Brave binary (or any Chromium-based browser) and restart the Gateway.
    See the full config examples in [Browser](/tools/browser#use-brave-or-another-chromium-based-browser).
  </Accordion>
</AccordionGroup>

## Remote gateways and nodes

<AccordionGroup>
  <Accordion title="How do commands propagate between Telegram, the gateway, and nodes?">
    Telegram messages are handled by the **gateway**. The gateway runs the agent and
    only then calls nodes over the **Gateway WebSocket** when a node tool is needed:

    Telegram → Gateway → Agent → `node.*` → Node → Gateway → Telegram

    Nodes don't see inbound provider traffic; they only receive node RPC calls.

  </Accordion>

  <Accordion title="How can my agent access my computer if the Gateway is hosted remotely?">
    Short answer: **pair your computer as a node**. The Gateway runs elsewhere, but it can
    call `node.*` tools (screen, camera, system) on your local machine over the Gateway WebSocket.

    Typical setup:

    1. Run the Gateway on the always-on host (VPS/home server).
    2. Put the Gateway host + your computer on the same tailnet.
    3. Ensure the Gateway WS is reachable (tailnet bind or SSH tunnel).
    4. Open the macOS app locally and connect in **Remote over SSH** mode (or direct tailnet)
       so it can register as a node.
    5. Approve the node on the Gateway:

       ```bash
       openclaw devices list
       openclaw devices approve <requestId>
       ```

    No separate TCP bridge is required; nodes connect over the Gateway WebSocket.

    Security reminder: pairing a macOS node allows `system.run` on that machine. Only
    pair devices you trust, and review [Security](/gateway/security).

    Docs: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remote mode](/platforms/mac/remote), [Security](/gateway/security).

  </Accordion>

  <Accordion title="Tailscale is connected but I get no replies. What now?">
    Check the basics:

    - Gateway is running: `openclaw gateway status`
    - Gateway health: `openclaw status`
    - Channel health: `openclaw channels status`

    Then verify auth and routing:

    - If you use Tailscale Serve, make sure `gateway.auth.allowTailscale` is set correctly.
    - If you connect via SSH tunnel, confirm the local tunnel is up and points at the right port.
    - Confirm your allowlists (DM or group) include your account.

    Docs: [Tailscale](/gateway/tailscale), [Remote access](/gateway/remote), [Channels](/channels).

  </Accordion>

  <Accordion title="Can two OpenClaw instances talk to each other (local + VPS)?">
    Yes. There is no built-in "bot-to-bot" bridge, but you can wire it up in a few
    reliable ways:

    **Simplest:** use a normal chat channel both bots can access (Telegram/Slack/WhatsApp).
    Have Bot A send a message to Bot B, then let Bot B reply as usual.

    **CLI bridge (generic):** run a script that calls the other Gateway with
    `openclaw agent --message ... --deliver`, targeting a chat where the other bot
    listens. If one bot is on a remote VPS, point your CLI at that remote Gateway
    via SSH/Tailscale (see [Remote access](/gateway/remote)).

    Example pattern (run from a machine that can reach the target Gateway):

    ```bash
    openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
    ```

    Tip: add a guardrail so the two bots do not loop endlessly (mention-only, channel
    allowlists, or a "do not reply to bot messages" rule).

    Docs: [Remote access](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send).

  </Accordion>

  <Accordion title="Do I need separate VPSes for multiple agents?">
    No. One Gateway can host multiple agents, each with its own workspace, model defaults,
    and routing. That is the normal setup and it is much cheaper and simpler than running
    one VPS per agent.

    Use separate VPSes only when you need hard isolation (security boundaries) or very
    different configs that you do not want to share. Otherwise, keep one Gateway and
    use multiple agents or sub-agents.

  </Accordion>

  <Accordion title="Is there a benefit to using a node on my personal laptop instead of SSH from a VPS?">
    Yes - nodes are the first-class way to reach your laptop from a remote Gateway, and they
    unlock more than shell access. The Gateway runs on macOS/Linux (Windows via WSL2) and is
    lightweight (a small VPS or Raspberry Pi-class box is fine; 4 GB RAM is plenty), so a common
    setup is an always-on host plus your laptop as a node.

    - **No inbound SSH required.** Nodes connect out to the Gateway WebSocket and use device pairing.
    - **Safer execution controls.** `system.run` is gated by node allowlists/approvals on that laptop.
    - **More device tools.** Nodes expose `canvas`, `camera`, and `screen` in addition to `system.run`.
    - **Local browser automation.** Keep the Gateway on a VPS, but run Chrome locally through a node host on the laptop, or attach to local Chrome on the host via Chrome MCP.

    SSH is fine for ad-hoc shell access, but nodes are simpler for ongoing agent workflows and
    device automation.

    Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Browser](/tools/browser).

  </Accordion>

  <Accordion title="Do nodes run a gateway service?">
    No. Only **one gateway** should run per host unless you intentionally run isolated profiles (see [Multiple gateways](/gateway/multiple-gateways)). Nodes are peripherals that connect
    to the gateway (iOS/Android nodes, or macOS "node mode" in the menubar app). For headless node
    hosts and CLI control, see [Node host CLI](/cli/node).

    A full restart is required for `gateway`, `discovery`, and `canvasHost` changes.

  </Accordion>

  <Accordion title="Is there an API / RPC way to apply config?">
    Yes.

    - `config.schema.lookup`: inspect one config subtree with its shallow schema node, matched UI hint, and immediate child summaries before writing
    - `config.get`: fetch the current snapshot + hash
    - `config.patch`: safe partial update (preferred for most RPC edits); hot-reloads when possible and restarts when required
    - `config.apply`: validate + replace the full config; hot-reloads when possible and restarts when required
    - The owner-only `gateway` runtime tool still refuses to rewrite `tools.exec.ask` / `tools.exec.security`; legacy `tools.bash.*` aliases normalize to the same protected exec paths

  </Accordion>

  <Accordion title="Minimal sane config for a first install">
    ```json5
    {
      agents: { defaults: { workspace: "~/.openclaw/workspace" } },
      channels: { whatsapp: { allowFrom: ["+15555550123"] } },
    }
    ```

    This sets your workspace and restricts who can trigger the bot.

  </Accordion>

  <Accordion title="How do I set up Tailscale on a VPS and connect from my Mac?">
    Minimal steps:

    1. **Install + login on the VPS**

       ```bash
       curl -fsSL https://tailscale.com/install.sh | sh
       sudo tailscale up
       ```

    2. **Install + login on your Mac**
       - Use the Tailscale app and sign in to the same tailnet.
    3. **Enable MagicDNS (recommended)**
       - In the Tailscale admin console, enable MagicDNS so the VPS has a stable name.
    4. **Use the tailnet hostname**
       - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
       - Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

    If you want the Control UI without SSH, use Tailscale Serve on the VPS:

    ```bash
    openclaw gateway --tailscale serve
    ```

    This keeps the gateway bound to loopback and exposes HTTPS via Tailscale. See [Tailscale](/gateway/tailscale).

  </Accordion>

  <Accordion title="How do I connect a Mac node to a remote Gateway (Tailscale Serve)?">
    Serve exposes the **Gateway Control UI + WS**. Nodes connect over the same Gateway WS endpoint.

    Recommended setup:

    1. **Make sure the VPS + Mac are on the same tailnet**.
    2. **Use the macOS app in Remote mode** (SSH target can be the tailnet hostname).
       The app will tunnel the Gateway port and connect as a node.
    3. **Approve the node** on the gateway:

       ```bash
       openclaw devices list
       openclaw devices approve <requestId>
       ```

    Docs: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

  </Accordion>

  <Accordion title="Should I install on a second laptop or just add a node?">
    If you only need **local tools** (screen/camera/exec) on the second laptop, add it as a
    **node**. That keeps a single Gateway and avoids duplicated config. Local node tools are
    currently macOS-only, but we plan to extend them to other OSes.

    Install a second Gateway only when you need **hard isolation** or two fully separate bots.

    Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Multiple gateways](/gateway/multiple-gateways).

  </Accordion>
</AccordionGroup>

## Env vars and .env loading

<AccordionGroup>
  <Accordion title="How does OpenClaw load environment variables?">
    OpenClaw reads env vars from the parent process (shell, launchd/systemd, CI, etc.) and additionally loads:

    - `.env` from the current working directory
    - a global fallback `.env` from `~/.openclaw/.env` (aka `$OPENCLAW_STATE_DIR/.env`)

    Neither `.env` file overrides existing env vars.

    You can also define inline env vars in config (applied only if missing from the process env):

    ```json5
    {
      env: {
        OPENROUTER_API_KEY: "sk-or-...",
        vars: { GROQ_API_KEY: "gsk-..." },
      },
    }
    ```

    See [/environment](/help/environment) for full precedence and sources.

  </Accordion>

  <Accordion title="I started the Gateway via the service and my env vars disappeared. What now?">
    Two common fixes:

    1. Put the missing keys in `~/.openclaw/.env` so they're picked up even when the service doesn't inherit your shell env.
    2. Enable shell import (opt-in convenience):

    ```json5
    {
      env: {
        shellEnv: {
          enabled: true,
          timeoutMs: 15000,
        },
      },
    }
    ```

    This runs your login shell and imports only missing expected keys (never overrides). Env var equivalents:
    `OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

  </Accordion>

  <Accordion title='I set COPILOT_GITHUB_TOKEN, but models status shows "Shell env: off." Why?'>
    `openclaw models status` reports whether **shell env import** is enabled. "Shell env: off"
    does **not** mean your env vars are missing - it just means OpenClaw won't load
    your login shell automatically.

    If the Gateway runs as a service (launchd/systemd), it won't inherit your shell
    environment. Fix by doing one of these:

    1. Put the token in `~/.openclaw/.env`:

       ```
       COPILOT_GITHUB_TOKEN=...
       ```

    2. Or enable shell import (`env.shellEnv.enabled: true`).
    3. Or add it to your config `env` block (applies only if missing).

    Then restart the gateway and recheck:

    ```bash
    openclaw models status
    ```

    Copilot tokens are read from `COPILOT_GITHUB_TOKEN` (also `GH_TOKEN` / `GITHUB_TOKEN`).
    See [/concepts/model-providers](/concepts/model-providers) and [/environment](/help/environment).

  </Accordion>
</AccordionGroup>

## Sessions and multiple chats

<AccordionGroup>
  <Accordion title="How do I start a fresh conversation?">
    Send `/new` or `/reset` as a standalone message. See [Session management](/concepts/session).
  </Accordion>

  <Accordion title="Do sessions reset automatically if I never send /new?">
    Sessions can expire after `session.idleMinutes`, but this is **disabled by default** (default **0**).
    Set it to a positive value to enable idle expiry. When enabled, the **next**
    message after the idle period starts a fresh session id for that chat key.
    This does not delete transcripts - it just starts a new session.

    ```json5
    {
      session: {
        idleMinutes: 240,
      },
    }
    ```

  </Accordion>

  <Accordion title="Is there a way to make a team of OpenClaw instances (one CEO and many agents)?">
    Yes, via **multi-agent routing** and **sub-agents**. You can create one coordinator
    agent and several worker agents with their own workspaces and models.

    That said, this is best seen as a **fun experiment**. It is token heavy and often
    less efficient than using one bot with separate sessions. The typical model we
    envision is one bot you talk to, with different sessions for parallel work. That
    bot can also spawn sub-agents when needed.

    Docs: [Multi-agent routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agents CLI](/cli/agents).

  </Accordion>

  <Accordion title="Why did context get truncated mid-task? How do I prevent it?">
    Session context is limited by the model window. Long chats, large tool outputs, or many
    files can trigger compaction or truncation.

    What helps:

    - Ask the bot to summarize the current state and write it to a file.
    - Use `/compact` before long tasks, and `/new` when switching topics.
    - Keep important context in the workspace and ask the bot to read it back.
    - Use sub-agents for long or parallel work so the main chat stays smaller.
    - Pick a model with a larger context window if this happens often.

  </Accordion>

  <Accordion title="How do I completely reset OpenClaw but keep it installed?">
    Use the reset command:

    ```bash
    openclaw reset
    ```

    Non-interactive full reset:

    ```bash
    openclaw reset --scope full --yes --non-interactive
    ```

    Then re-run setup:

    ```bash
    openclaw onboard --install-daemon
    ```

    Notes:

    - Onboarding also offers **Reset** if it sees an existing config. See [Onboarding (CLI)](/start/wizard).
    - If you used profiles (`--profile` / `OPENCLAW_PROFILE`), reset each state dir (defaults are `~/.openclaw-<profile>`).
    - Dev reset: `openclaw gateway --dev --reset` (dev-only; wipes dev config + credentials + sessions + workspace).

  </Accordion>

  <Accordion title='I am getting "context too large" errors - how do I reset or compact?'>
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

  </Accordion>

  <Accordion title='Why am I seeing "LLM request rejected: messages.content.tool_use.input field required"?'>
    This is a provider validation error: the model emitted a `tool_use` block without the required
    `input`. It usually means the session history is stale or corrupted (often after long threads
    or a tool/schema change).

    Fix: start a fresh session with `/new` (standalone message).

  </Accordion>

  <Accordion title="Why am I getting heartbeat messages every 30 minutes?">
    Heartbeats run every **30m** by default (**1h** when using OAuth auth). Tune or disable them:

    ```json5
    {
      agents: {
        defaults: {
          heartbeat: {
            every: "2h", // or "0m" to disable
          },
        },
      },
    }
    ```

    If `HEARTBEAT.md` exists but is effectively empty (only blank lines and markdown
    headers like `# Heading`), OpenClaw skips the heartbeat run to save API calls.
    If the file is missing, the heartbeat still runs and the model decides what to do.

    Per-agent overrides use `agents.list[].heartbeat`. Docs: [Heartbeat](/gateway/heartbeat).

  </Accordion>

  <Accordion title='Do I need to add a "bot account" to a WhatsApp group?'>
    No. OpenClaw runs on **your own account**, so if you're in the group, OpenClaw can see it.
    By default, group replies are blocked until you allow senders (`groupPolicy: "allowlist"`).

    If you want only **you** to be able to trigger group replies:

    ```json5
    {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15551234567"],
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="How do I get the JID of a WhatsApp group?">
    Option 1 (fastest): tail logs and send a test message in the group:

    ```bash
    openclaw logs --follow --json
    ```

    Look for `chatId` (or `from`) ending in `@g.us`, like:
    `1234567890-1234567890@g.us`.

    Option 2 (if already configured/allowlisted): list groups from config:

    ```bash
    openclaw directory groups list --channel whatsapp
    ```

    Docs: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

  </Accordion>

  <Accordion title="Why does OpenClaw not reply in a group?">
    Two common causes:

    - Mention gating is on (default). You must @mention the bot (or match `mentionPatterns`).
    - You configured `channels.whatsapp.groups` without `"*"` and the group isn't allowlisted.

    See [Groups](/channels/groups) and [Group messages](/channels/group-messages).

  </Accordion>

  <Accordion title="Do groups/threads share context with DMs?">
    Direct chats collapse to the main session by default. Groups/channels have their own session keys, and Telegram topics / Discord threads are separate sessions. See [Groups](/channels/groups) and [Group messages](/channels/group-messages).
  </Accordion>

  <Accordion title="How many workspaces and agents can I create?">
    No hard limits. Dozens (even hundreds) are fine, but watch for:

    - **Disk growth:** sessions + transcripts live under `~/.openclaw/agents/<agentId>/sessions/`.
    - **Token cost:** more agents means more concurrent model usage.
    - **Ops overhead:** per-agent auth profiles, workspaces, and channel routing.

    Tips:

    - Keep one **active** workspace per agent (`agents.defaults.workspace`).
    - Prune old sessions (delete JSONL or store entries) if disk grows.
    - Use `openclaw doctor` to spot stray workspaces and profile mismatches.

  </Accordion>

  <Accordion title="Can I run multiple bots or chats at the same time (Slack), and how should I set that up?">
    Yes. Use **Multi-Agent Routing** to run multiple isolated agents and route inbound messages by
    channel/account/peer. Slack is supported as a channel and can be bound to specific agents.

    Browser access is powerful but not "do anything a human can" - anti-bot, CAPTCHAs, and MFA can
    still block automation. For the most reliable browser control, use local Chrome MCP on the host,
    or use CDP on the machine that actually runs the browser.

    Best-practice setup:

    - Always-on Gateway host (VPS/Mac mini).
    - One agent per role (bindings).
    - Slack channel(s) bound to those agents.
    - Local browser via Chrome MCP or a node when needed.

    Docs: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack),
    [Browser](/tools/browser), [Nodes](/nodes).

  </Accordion>
</AccordionGroup>

## Models: defaults, selection, aliases, switching

<AccordionGroup>
  <Accordion title='What is the "default model"?'>
    OpenClaw's default model is whatever you set as:

    ```
    agents.defaults.model.primary
    ```

    Models are referenced as `provider/model` (example: `openai/gpt-5.4`). If you omit the provider, OpenClaw first tries an alias, then a unique configured-provider match for that exact model id, and only then falls back to the configured default provider as a deprecated compatibility path. If that provider no longer exposes the configured default model, OpenClaw falls back to the first configured provider/model instead of surfacing a stale removed-provider default. You should still **explicitly** set `provider/model`.

  </Accordion>

  <Accordion title="What model do you recommend?">
    **Recommended default:** use the strongest latest-generation model available in your provider stack.
    **For tool-enabled or untrusted-input agents:** prioritize model strength over cost.
    **For routine/low-stakes chat:** use cheaper fallback models and route by agent role.

    MiniMax has its own docs: [MiniMax](/providers/minimax) and
    [Local models](/gateway/local-models).

    Rule of thumb: use the **best model you can afford** for high-stakes work, and a cheaper
    model for routine chat or summaries. You can route models per agent and use sub-agents to
    parallelize long tasks (each sub-agent consumes tokens). See [Models](/concepts/models) and
    [Sub-agents](/tools/subagents).

    Strong warning: weaker/over-quantized models are more vulnerable to prompt
    injection and unsafe behavior. See [Security](/gateway/security).

    More context: [Models](/concepts/models).

  </Accordion>

  <Accordion title="How do I switch models without wiping my config?">
    Use **model commands** or edit only the **model** fields. Avoid full config replaces.

    Safe options:

    - `/model` in chat (quick, per-session)
    - `openclaw models set ...` (updates just model config)
    - `openclaw configure --section model` (interactive)
    - edit `agents.defaults.model` in `~/.openclaw/openclaw.json`

    Avoid `config.apply` with a partial object unless you intend to replace the whole config.
    For RPC edits, inspect with `config.schema.lookup` first and prefer `config.patch`. The lookup payload gives you the normalized path, shallow schema docs/constraints, and immediate child summaries.
    for partial updates.
    If you did overwrite config, restore from backup or re-run `openclaw doctor` to repair.

    Docs: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

  </Accordion>

  <Accordion title="Can I use self-hosted models (llama.cpp, vLLM, Ollama)?">
    Yes. Ollama is the easiest path for local models.

    Quickest setup:

    1. Install Ollama from `https://ollama.com/download`
    2. Pull a local model such as `ollama pull gemma4`
    3. If you want cloud models too, run `ollama signin`
    4. Run `openclaw onboard` and choose `Ollama`
    5. Pick `Local` or `Cloud + Local`

    Notes:

    - `Cloud + Local` gives you cloud models plus your local Ollama models
    - cloud models such as `kimi-k2.5:cloud` do not need a local pull
    - for manual switching, use `openclaw models list` and `openclaw models set ollama/<model>`

    Security note: smaller or heavily quantized models are more vulnerable to prompt
    injection. We strongly recommend **large models** for any bot that can use tools.
    If you still want small models, enable sandboxing and strict tool allowlists.

    Docs: [Ollama](/providers/ollama), [Local models](/gateway/local-models),
    [Model providers](/concepts/model-providers), [Security](/gateway/security),
    [Sandboxing](/gateway/sandboxing).

  </Accordion>

  <Accordion title="What do OpenClaw, Flawd, and Krill use for models?">
    - These deployments can differ and may change over time; there is no fixed provider recommendation.
    - Check the current runtime setting on each gateway with `openclaw models status`.
    - For security-sensitive/tool-enabled agents, use the strongest latest-generation model available.
  </Accordion>

  <Accordion title="How do I switch models on the fly (without restarting)?">
    Use the `/model` command as a standalone message:

    ```
    /model sonnet
    /model opus
    /model gpt
    /model gpt-mini
    /model gemini
    /model gemini-flash
    /model gemini-flash-lite
    ```

    These are the built-in aliases. Custom aliases can be added via `agents.defaults.models`.

    You can list available models with `/model`, `/model list`, or `/model status`.

    `/model` (and `/model list`) shows a compact, numbered picker. Select by number:

    ```
    /model 3
    ```

    You can also force a specific auth profile for the provider (per session):

    ```
    /model opus@anthropic:default
    /model opus@anthropic:work
    ```

    Tip: `/model status` shows which agent is active, which `auth-profiles.json` file is being used, and which auth profile will be tried next.
    It also shows the configured provider endpoint (`baseUrl`) and API mode (`api`) when available.

    **How do I unpin a profile I set with @profile?**

    Re-run `/model` **without** the `@profile` suffix:

    ```
    /model anthropic/claude-opus-4-6
    ```

    If you want to return to the default, pick it from `/model` (or send `/model <default provider/model>`).
    Use `/model status` to confirm which auth profile is active.

  </Accordion>

  <Accordion title="Can I use GPT 5.2 for daily tasks and Codex 5.3 for coding?">
    Yes. Set one as default and switch as needed:

    - **Quick switch (per session):** `/model gpt-5.4` for daily tasks, `/model openai-codex/gpt-5.4` for coding with Codex OAuth.
    - **Default + switch:** set `agents.defaults.model.primary` to `openai/gpt-5.4`, then switch to `openai-codex/gpt-5.4` when coding (or the other way around).
    - **Sub-agents:** route coding tasks to sub-agents with a different default model.

    See [Models](/concepts/models) and [Slash commands](/tools/slash-commands).

  </Accordion>

  <Accordion title="How do I configure fast mode for GPT 5.4?">
    Use either a session toggle or a config default:

    - **Per session:** send `/fast on` while the session is using `openai/gpt-5.4` or `openai-codex/gpt-5.4`.
    - **Per model default:** set `agents.defaults.models["openai/gpt-5.4"].params.fastMode` to `true`.
    - **Codex OAuth too:** if you also use `openai-codex/gpt-5.4`, set the same flag there.

    Example:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": {
              params: {
                fastMode: true,
              },
            },
            "openai-codex/gpt-5.4": {
              params: {
                fastMode: true,
              },
            },
          },
        },
      },
    }
    ```

    For OpenAI, fast mode maps to `service_tier = "priority"` on supported native Responses requests. Session `/fast` overrides beat config defaults.

    See [Thinking and fast mode](/tools/thinking) and [OpenAI fast mode](/providers/openai#openai-fast-mode).

  </Accordion>

  <Accordion title='Why do I see "Model ... is not allowed" and then no reply?'>
    If `agents.defaults.models` is set, it becomes the **allowlist** for `/model` and any
    session overrides. Choosing a model that isn't in that list returns:

    ```
    Model "provider/model" is not allowed. Use /model to list available models.
    ```

    That error is returned **instead of** a normal reply. Fix: add the model to
    `agents.defaults.models`, remove the allowlist, or pick a model from `/model list`.

  </Accordion>

  <Accordion title='Why do I see "Unknown model: minimax/MiniMax-M2.7"?'>
    This means the **provider isn't configured** (no MiniMax provider config or auth
    profile was found), so the model can't be resolved.

    Fix checklist:

    1. Upgrade to a current OpenClaw release (or run from source `main`), then restart the gateway.
    2. Make sure MiniMax is configured (wizard or JSON), or that MiniMax auth
       exists in env/auth profiles so the matching provider can be injected
       (`MINIMAX_API_KEY` for `minimax`, `MINIMAX_OAUTH_TOKEN` or stored MiniMax
       OAuth for `minimax-portal`).
    3. Use the exact model id (case-sensitive) for your auth path:
       `minimax/MiniMax-M2.7` or `minimax/MiniMax-M2.7-highspeed` for API-key
       setup, or `minimax-portal/MiniMax-M2.7` /
       `minimax-portal/MiniMax-M2.7-highspeed` for OAuth setup.
    4. Run:

       ```bash
       openclaw models list
       ```

       and pick from the list (or `/model list` in chat).

    See [MiniMax](/providers/minimax) and [Models](/concepts/models).

  </Accordion>

  <Accordion title="Can I use MiniMax as my default and OpenAI for complex tasks?">
    Yes. Use **MiniMax as the default** and switch models **per session** when needed.
    Fallbacks are for **errors**, not "hard tasks," so use `/model` or a separate agent.

    **Option A: switch per session**

    ```json5
    {
      env: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-..." },
      agents: {
        defaults: {
          model: { primary: "minimax/MiniMax-M2.7" },
          models: {
            "minimax/MiniMax-M2.7": { alias: "minimax" },
            "openai/gpt-5.4": { alias: "gpt" },
          },
        },
      },
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

  </Accordion>

  <Accordion title="Are opus / sonnet / gpt built-in shortcuts?">
    Yes. OpenClaw ships a few default shorthands (only applied when the model exists in `agents.defaults.models`):

    - `opus` → `anthropic/claude-opus-4-6`
    - `sonnet` → `anthropic/claude-sonnet-4-6`
    - `gpt` → `openai/gpt-5.4`
    - `gpt-mini` → `openai/gpt-5.4-mini`
    - `gpt-nano` → `openai/gpt-5.4-nano`
    - `gemini` → `google/gemini-3.1-pro-preview`
    - `gemini-flash` → `google/gemini-3-flash-preview`
    - `gemini-flash-lite` → `google/gemini-3.1-flash-lite-preview`

    If you set your own alias with the same name, your value wins.

  </Accordion>

  <Accordion title="How do I define/override model shortcuts (aliases)?">
    Aliases come from `agents.defaults.models.<modelId>.alias`. Example:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          models: {
            "anthropic/claude-opus-4-6": { alias: "opus" },
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
            "anthropic/claude-haiku-4-5": { alias: "haiku" },
          },
        },
      },
    }
    ```

    Then `/model sonnet` (or `/<alias>` when supported) resolves to that model ID.

  </Accordion>

  <Accordion title="How do I add models from other providers like OpenRouter or Z.AI?">
    OpenRouter (pay-per-token; many models):

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "openrouter/anthropic/claude-sonnet-4-6" },
          models: { "openrouter/anthropic/claude-sonnet-4-6": {} },
        },
      },
      env: { OPENROUTER_API_KEY: "sk-or-..." },
    }
    ```

    Z.AI (GLM models):

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "zai/glm-5" },
          models: { "zai/glm-5": {} },
        },
      },
      env: { ZAI_API_KEY: "..." },
    }
    ```

    If you reference a provider/model but the required provider key is missing, you'll get a runtime auth error (e.g. `No API key found for provider "zai"`).

    **No API key found for provider after adding a new agent**

    This usually means the **new agent** has an empty auth store. Auth is per-agent and
    stored in:

    ```
    ~/.openclaw/agents/<agentId>/agent/auth-profiles.json
    ```

    Fix options:

    - Run `openclaw agents add <id>` and configure auth during the wizard.
    - Or copy `auth-profiles.json` from the main agent's `agentDir` into the new agent's `agentDir`.

    Do **not** reuse `agentDir` across agents; it causes auth/session collisions.

  </Accordion>
</AccordionGroup>

## Model failover and "All models failed"

<AccordionGroup>
  <Accordion title="How does failover work?">
    Failover happens in two stages:

    1. **Auth profile rotation** within the same provider.
    2. **Model fallback** to the next model in `agents.defaults.model.fallbacks`.

    Cooldowns apply to failing profiles (exponential backoff), so OpenClaw can keep responding even when a provider is rate-limited or temporarily failing.

    The rate-limit bucket includes more than plain `429` responses. OpenClaw
    also treats messages like `Too many concurrent requests`,
    `ThrottlingException`, `concurrency limit reached`,
    `workers_ai ... quota limit exceeded`, `resource exhausted`, and periodic
    usage-window limits (`weekly/monthly limit reached`) as failover-worthy
    rate limits.

    Some billing-looking responses are not `402`, and some HTTP `402`
    responses also stay in that transient bucket. If a provider returns
    explicit billing text on `401` or `403`, OpenClaw can still keep that in
    the billing lane, but provider-specific text matchers stay scoped to the
    provider that owns them (for example OpenRouter `Key limit exceeded`). If a `402`
    message instead looks like a retryable usage-window or
    organization/workspace spend limit (`daily limit reached, resets tomorrow`,
    `organization spending limit exceeded`), OpenClaw treats it as
    `rate_limit`, not a long billing disable.

    Context-overflow errors are different: signatures such as
    `request_too_large`, `input exceeds the maximum number of tokens`,
    `input token count exceeds the maximum number of input tokens`,
    `input is too long for the model`, or `ollama error: context length
    exceeded` stay on the compaction/retry path instead of advancing model
    fallback.

    Generic server-error text is intentionally narrower than "anything with
    unknown/error in it". OpenClaw does treat provider-scoped transient shapes
    such as Anthropic bare `An unknown error occurred`, OpenRouter bare
    `Provider returned error`, stop-reason errors like `Unhandled stop reason:
    error`, JSON `api_error` payloads with transient server text
    (`internal server error`, `unknown error, 520`, `upstream error`, `backend
    error`), and provider-busy errors such as `ModelNotReadyException` as
    failover-worthy timeout/overloaded signals when the provider context
    matches.
    Generic internal fallback text like `LLM request failed with an unknown
    error.` stays conservative and does not trigger model fallback by itself.

  </Accordion>

  <Accordion title='What does "No credentials found for profile anthropic:default" mean?'>
    It means the system attempted to use the auth profile ID `anthropic:default`, but could not find credentials for it in the expected auth store.

    **Fix checklist:**

    - **Confirm where auth profiles live** (new vs legacy paths)
      - Current: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
      - Legacy: `~/.openclaw/agent/*` (migrated by `openclaw doctor`)
    - **Confirm your env var is loaded by the Gateway**
      - If you set `ANTHROPIC_API_KEY` in your shell but run the Gateway via systemd/launchd, it may not inherit it. Put it in `~/.openclaw/.env` or enable `env.shellEnv`.
    - **Make sure you're editing the correct agent**
      - Multi-agent setups mean there can be multiple `auth-profiles.json` files.
    - **Sanity-check model/auth status**
      - Use `openclaw models status` to see configured models and whether providers are authenticated.

    **Fix checklist for "No credentials found for profile anthropic"**

    This means the run is pinned to an Anthropic auth profile, but the Gateway
    can't find it in its auth store.

    - **Use Claude CLI**
      - Run `openclaw models auth login --provider anthropic --method cli --set-default` on the gateway host.
    - **If you want to use an API key instead**
      - Put `ANTHROPIC_API_KEY` in `~/.openclaw/.env` on the **gateway host**.
      - Clear any pinned order that forces a missing profile:

        ```bash
        openclaw models auth order clear --provider anthropic
        ```

    - **Confirm you're running commands on the gateway host**
      - In remote mode, auth profiles live on the gateway machine, not your laptop.

  </Accordion>

  <Accordion title="Why did it also try Google Gemini and fail?">
    If your model config includes Google Gemini as a fallback (or you switched to a Gemini shorthand), OpenClaw will try it during model fallback. If you haven't configured Google credentials, you'll see `No API key found for provider "google"`.

    Fix: either provide Google auth, or remove/avoid Google models in `agents.defaults.model.fallbacks` / aliases so fallback doesn't route there.

    **LLM request rejected: thinking signature required (Google Antigravity)**

    Cause: the session history contains **thinking blocks without signatures** (often from
    an aborted/partial stream). Google Antigravity requires signatures for thinking blocks.

    Fix: OpenClaw now strips unsigned thinking blocks for Google Antigravity Claude. If it still appears, start a **new session** or set `/thinking off` for that agent.

  </Accordion>
</AccordionGroup>

## Auth profiles: what they are and how to manage them

Related: [/concepts/oauth](/concepts/oauth) (OAuth flows, token storage, multi-account patterns)

<AccordionGroup>
  <Accordion title="What is an auth profile?">
    An auth profile is a named credential record (OAuth or API key) tied to a provider. Profiles live in:

    ```
    ~/.openclaw/agents/<agentId>/agent/auth-profiles.json
    ```

  </Accordion>

  <Accordion title="What are typical profile IDs?">
    OpenClaw uses provider-prefixed IDs like:

    - `anthropic:default` (common when no email identity exists)
    - `anthropic:<email>` for OAuth identities
    - custom IDs you choose (e.g. `anthropic:work`)

  </Accordion>

  <Accordion title="Can I control which auth profile is tried first?">
    Yes. Config supports optional metadata for profiles and an ordering per provider (`auth.order.<provider>`). This does **not** store secrets; it maps IDs to provider/mode and sets rotation order.

    OpenClaw may temporarily skip a profile if it's in a short **cooldown** (rate limits/timeouts/auth failures) or a longer **disabled** state (billing/insufficient credits). To inspect this, run `openclaw models status --json` and check `auth.unusableProfiles`. Tuning: `auth.cooldowns.billingBackoffHours*`.

    Rate-limit cooldowns can be model-scoped. A profile that is cooling down
    for one model can still be usable for a sibling model on the same provider,
    while billing/disabled windows still block the whole profile.

    You can also set a **per-agent** order override (stored in that agent's `auth-state.json`) via the CLI:

    ```bash
    # Defaults to the configured default agent (omit --agent)
    openclaw models auth order get --provider anthropic

    # Lock rotation to a single profile (only try this one)
    openclaw models auth order set --provider anthropic anthropic:default

    # Or set an explicit order (fallback within provider)
    openclaw models auth order set --provider anthropic anthropic:work anthropic:default

    # Clear override (fall back to config auth.order / round-robin)
    openclaw models auth order clear --provider anthropic
    ```

    To target a specific agent:

    ```bash
    openclaw models auth order set --provider anthropic --agent main anthropic:default
    ```

    To verify what will actually be tried, use:

    ```bash
    openclaw models status --probe
    ```

    If a stored profile is omitted from the explicit order, probe reports
    `excluded_by_auth_order` for that profile instead of trying it silently.

  </Accordion>

  <Accordion title="OAuth vs API key - what is the difference?">
    OpenClaw supports both:

    - **OAuth** often leverages subscription access (where applicable).
    - **API keys** use pay-per-token billing.

    The wizard explicitly supports Anthropic Claude CLI, OpenAI Codex OAuth, and API keys.

  </Accordion>
</AccordionGroup>

## Gateway: ports, "already running", and remote mode

<AccordionGroup>
  <Accordion title="What port does the Gateway use?">
    `gateway.port` controls the single multiplexed port for WebSocket + HTTP (Control UI, hooks, etc.).

    Precedence:

    ```
    --port > OPENCLAW_GATEWAY_PORT > gateway.port > default 18789
    ```

  </Accordion>

  <Accordion title='Why does openclaw gateway status say "Runtime: running" but "Connectivity probe: failed"?'>
    Because "running" is the **supervisor's** view (launchd/systemd/schtasks). The connectivity probe is the CLI actually connecting to the gateway WebSocket.

    Use `openclaw gateway status` and trust these lines:

    - `Probe target:` (the URL the probe actually used)
    - `Listening:` (what's actually bound on the port)
    - `Last gateway error:` (common root cause when the process is alive but the port isn't listening)

  </Accordion>

  <Accordion title='Why does openclaw gateway status show "Config (cli)" and "Config (service)" different?'>
    You're editing one config file while the service is running another (often a `--profile` / `OPENCLAW_STATE_DIR` mismatch).

    Fix:

    ```bash
    openclaw gateway install --force
    ```

    Run that from the same `--profile` / environment you want the service to use.

  </Accordion>

  <Accordion title='What does "another gateway instance is already listening" mean?'>
    OpenClaw enforces a runtime lock by binding the WebSocket listener immediately on startup (default `ws://127.0.0.1:18789`). If the bind fails with `EADDRINUSE`, it throws `GatewayLockError` indicating another instance is already listening.

    Fix: stop the other instance, free the port, or run with `openclaw gateway --port <port>`.

  </Accordion>

  <Accordion title="How do I run OpenClaw in remote mode (client connects to a Gateway elsewhere)?">
    Set `gateway.mode: "remote"` and point to a remote WebSocket URL, optionally with shared-secret remote credentials:

    ```json5
    {
      gateway: {
        mode: "remote",
        remote: {
          url: "ws://gateway.tailnet:18789",
          token: "your-token",
          password: "your-password",
        },
      },
    }
    ```

    Notes:

    - `openclaw gateway` only starts when `gateway.mode` is `local` (or you pass the override flag).
    - The macOS app watches the config file and switches modes live when these values change.
    - `gateway.remote.token` / `.password` are client-side remote credentials only; they do not enable local gateway auth by themselves.

  </Accordion>

  <Accordion title='The Control UI says "unauthorized" (or keeps reconnecting). What now?'>
    Your gateway auth path and the UI's auth method do not match.

    Facts (from code):

    - The Control UI keeps the token in `sessionStorage` for the current browser tab session and selected gateway URL, so same-tab refreshes keep working without restoring long-lived localStorage token persistence.
    - On `AUTH_TOKEN_MISMATCH`, trusted clients can attempt one bounded retry with a cached device token when the gateway returns retry hints (`canRetryWithDeviceToken=true`, `recommendedNextStep=retry_with_device_token`).
    - That cached-token retry now reuses the cached approved scopes stored with the device token. Explicit `deviceToken` / explicit `scopes` callers still keep their requested scope set instead of inheriting cached scopes.
    - Outside that retry path, connect auth precedence is explicit shared token/password first, then explicit `deviceToken`, then stored device token, then bootstrap token.
    - Bootstrap token scope checks are role-prefixed. The built-in bootstrap operator allowlist only satisfies operator requests; node or other non-operator roles still need scopes under their own role prefix.

    Fix:

    - Fastest: `openclaw dashboard` (prints + copies the dashboard URL, tries to open; shows SSH hint if headless).
    - If you don't have a token yet: `openclaw doctor --generate-gateway-token`.
    - If remote, tunnel first: `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/`.
    - Shared-secret mode: set `gateway.auth.token` / `OPENCLAW_GATEWAY_TOKEN` or `gateway.auth.password` / `OPENCLAW_GATEWAY_PASSWORD`, then paste the matching secret in Control UI settings.
    - Tailscale Serve mode: make sure `gateway.auth.allowTailscale` is enabled and you are opening the Serve URL, not a raw loopback/tailnet URL that bypasses Tailscale identity headers.
    - Trusted-proxy mode: make sure you are coming through the configured non-loopback identity-aware proxy, not a same-host loopback proxy or raw gateway URL.
    - If mismatch persists after the one retry, rotate/re-approve the paired device token:
      - `openclaw devices list`
      - `openclaw devices rotate --device <id> --role operator`
    - If that rotate call says it was denied, check two things:
      - paired-device sessions can rotate only their **own** device unless they also have `operator.admin`
      - explicit `--scope` values cannot exceed the caller's current operator scopes
    - Still stuck? Run `openclaw status --all` and follow [Troubleshooting](/gateway/troubleshooting). See [Dashboard](/web/dashboard) for auth details.

  </Accordion>

  <Accordion title="I set gateway.bind tailnet but it cannot bind and nothing listens">
    `tailnet` bind picks a Tailscale IP from your network interfaces (100.64.0.0/10). If the machine isn't on Tailscale (or the interface is down), there's nothing to bind to.

    Fix:

    - Start Tailscale on that host (so it has a 100.x address), or
    - Switch to `gateway.bind: "loopback"` / `"lan"`.

    Note: `tailnet` is explicit. `auto` prefers loopback; use `gateway.bind: "tailnet"` when you want a tailnet-only bind.

  </Accordion>

  <Accordion title="Can I run multiple Gateways on the same host?">
    Usually no - one Gateway can run multiple messaging channels and agents. Use multiple Gateways only when you need redundancy (ex: rescue bot) or hard isolation.

    Yes, but you must isolate:

    - `OPENCLAW_CONFIG_PATH` (per-instance config)
    - `OPENCLAW_STATE_DIR` (per-instance state)
    - `agents.defaults.workspace` (workspace isolation)
    - `gateway.port` (unique ports)

    Quick setup (recommended):

    - Use `openclaw --profile <name> ...` per instance (auto-creates `~/.openclaw-<name>`).
    - Set a unique `gateway.port` in each profile config (or pass `--port` for manual runs).
    - Install a per-profile service: `openclaw --profile <name> gateway install`.

    Profiles also suffix service names (`ai.openclaw.<profile>`; legacy `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).
    Full guide: [Multiple gateways](/gateway/multiple-gateways).

  </Accordion>

  <Accordion title='What does "invalid handshake" / code 1008 mean?'>
    The Gateway is a **WebSocket server**, and it expects the very first message to
    be a `connect` frame. If it receives anything else, it closes the connection
    with **code 1008** (policy violation).

    Common causes:

    - You opened the **HTTP** URL in a browser (`http://...`) instead of a WS client.
    - You used the wrong port or path.
    - A proxy or tunnel stripped auth headers or sent a non-Gateway request.

    Quick fixes:

    1. Use the WS URL: `ws://<host>:18789` (or `wss://...` if HTTPS).
    2. Don't open the WS port in a normal browser tab.
    3. If auth is on, include the token/password in the `connect` frame.

    If you're using the CLI or TUI, the URL should look like:

    ```
    openclaw tui --url ws://<host>:18789 --token <token>
    ```

    Protocol details: [Gateway protocol](/gateway/protocol).

  </Accordion>
</AccordionGroup>

## Logging and debugging

<AccordionGroup>
  <Accordion title="Where are logs?">
    File logs (structured):

    ```
    /tmp/openclaw/openclaw-YYYY-MM-DD.log
    ```

    You can set a stable path via `logging.file`. File log level is controlled by `logging.level`. Console verbosity is controlled by `--verbose` and `logging.consoleLevel`.

    Fastest log tail:

    ```bash
    openclaw logs --follow
    ```

    Service/supervisor logs (when the gateway runs via launchd/systemd):

    - macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` and `gateway.err.log` (default: `~/.openclaw/logs/...`; profiles use `~/.openclaw-<profile>/logs/...`)
    - Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
    - Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

    See [Troubleshooting](/gateway/troubleshooting) for more.

  </Accordion>

  <Accordion title="How do I start/stop/restart the Gateway service?">
    Use the gateway helpers:

    ```bash
    openclaw gateway status
    openclaw gateway restart
    ```

    If you run the gateway manually, `openclaw gateway --force` can reclaim the port. See [Gateway](/gateway).

  </Accordion>

  <Accordion title="I closed my terminal on Windows - how do I restart OpenClaw?">
    There are **two Windows install modes**:

    **1) WSL2 (recommended):** the Gateway runs inside Linux.

    Open PowerShell, enter WSL, then restart:

    ```powershell
    wsl
    openclaw gateway status
    openclaw gateway restart
    ```

    If you never installed the service, start it in the foreground:

    ```bash
    openclaw gateway run
    ```

    **2) Native Windows (not recommended):** the Gateway runs directly in Windows.

    Open PowerShell and run:

    ```powershell
    openclaw gateway status
    openclaw gateway restart
    ```

    If you run it manually (no service), use:

    ```powershell
    openclaw gateway run
    ```

    Docs: [Windows (WSL2)](/platforms/windows), [Gateway service runbook](/gateway).

  </Accordion>

  <Accordion title="The Gateway is up but replies never arrive. What should I check?">
    Start with a quick health sweep:

    ```bash
    openclaw status
    openclaw models status
    openclaw channels status
    openclaw logs --follow
    ```

    Common causes:

    - Model auth not loaded on the **gateway host** (check `models status`).
    - Channel pairing/allowlist blocking replies (check channel config + logs).
    - WebChat/Dashboard is open without the right token.

    If you are remote, confirm the tunnel/Tailscale connection is up and that the
    Gateway WebSocket is reachable.

    Docs: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Remote access](/gateway/remote).

  </Accordion>

  <Accordion title='"Disconnected from gateway: no reason" - what now?'>
    This usually means the UI lost the WebSocket connection. Check:

    1. Is the Gateway running? `openclaw gateway status`
    2. Is the Gateway healthy? `openclaw status`
    3. Does the UI have the right token? `openclaw dashboard`
    4. If remote, is the tunnel/Tailscale link up?

    Then tail logs:

    ```bash
    openclaw logs --follow
    ```

    Docs: [Dashboard](/web/dashboard), [Remote access](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

  </Accordion>

  <Accordion title="Telegram setMyCommands fails. What should I check?">
    Start with logs and channel status:

    ```bash
    openclaw channels status
    openclaw channels logs --channel telegram
    ```

    Then match the error:

    - `BOT_COMMANDS_TOO_MUCH`: the Telegram menu has too many entries. OpenClaw already trims to the Telegram limit and retries with fewer commands, but some menu entries still need to be dropped. Reduce plugin/skill/custom commands, or disable `channels.telegram.commands.native` if you do not need the menu.
    - `TypeError: fetch failed`, `Network request for 'setMyCommands' failed!`, or similar network errors: if you are on a VPS or behind a proxy, confirm outbound HTTPS is allowed and DNS works for `api.telegram.org`.

    If the Gateway is remote, make sure you are looking at logs on the Gateway host.

    Docs: [Telegram](/channels/telegram), [Channel troubleshooting](/channels/troubleshooting).

  </Accordion>

  <Accordion title="TUI shows no output. What should I check?">
    First confirm the Gateway is reachable and the agent can run:

    ```bash
    openclaw status
    openclaw models status
    openclaw logs --follow
    ```

    In the TUI, use `/status` to see the current state. If you expect replies in a chat
    channel, make sure delivery is enabled (`/deliver on`).

    Docs: [TUI](/web/tui), [Slash commands](/tools/slash-commands).

  </Accordion>

  <Accordion title="How do I completely stop then start the Gateway?">
    If you installed the service:

    ```bash
    openclaw gateway stop
    openclaw gateway start
    ```

    This stops/starts the **supervised service** (launchd on macOS, systemd on Linux).
    Use this when the Gateway runs in the background as a daemon.

    If you're running in the foreground, stop with Ctrl-C, then:

    ```bash
    openclaw gateway run
    ```

    Docs: [Gateway service runbook](/gateway).

  </Accordion>

  <Accordion title="ELI5: openclaw gateway restart vs openclaw gateway">
    - `openclaw gateway restart`: restarts the **background service** (launchd/systemd).
    - `openclaw gateway`: runs the gateway **in the foreground** for this terminal session.

    If you installed the service, use the gateway commands. Use `openclaw gateway` when
    you want a one-off, foreground run.

  </Accordion>

  <Accordion title="Fastest way to get more details when something fails">
    Start the Gateway with `--verbose` to get more console detail. Then inspect the log file for channel auth, model routing, and RPC errors.
  </Accordion>
</AccordionGroup>

## Media and attachments

<AccordionGroup>
  <Accordion title="My skill generated an image/PDF, but nothing was sent">
    Outbound attachments from the agent must include a `MEDIA:<path-or-url>` line (on its own line). See [OpenClaw assistant setup](/start/openclaw) and [Agent send](/tools/agent-send).

    CLI sending:

    ```bash
    openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png
    ```

    Also check:

    - The target channel supports outbound media and isn't blocked by allowlists.
    - The file is within the provider's size limits (images are resized to max 2048px).
    - `tools.fs.workspaceOnly=true` keeps local-path sends limited to workspace, temp/media-store, and sandbox-validated files.
    - `tools.fs.workspaceOnly=false` lets `MEDIA:` send host-local files the agent can already read, but only for media plus safe document types (images, audio, video, PDF, and Office docs). Plain text and secret-like files are still blocked.

    See [Images](/nodes/images).

  </Accordion>
</AccordionGroup>

## Security and access control

<AccordionGroup>
  <Accordion title="Is it safe to expose OpenClaw to inbound DMs?">
    Treat inbound DMs as untrusted input. Defaults are designed to reduce risk:

    - Default behavior on DM-capable channels is **pairing**:
      - Unknown senders receive a pairing code; the bot does not process their message.
      - Approve with: `openclaw pairing approve --channel <channel> [--account <id>] <code>`
      - Pending requests are capped at **3 per channel**; check `openclaw pairing list --channel <channel> [--account <id>]` if a code didn't arrive.
    - Opening DMs publicly requires explicit opt-in (`dmPolicy: "open"` and allowlist `"*"`).

    Run `openclaw doctor` to surface risky DM policies.

  </Accordion>

  <Accordion title="Is prompt injection only a concern for public bots?">
    No. Prompt injection is about **untrusted content**, not just who can DM the bot.
    If your assistant reads external content (web search/fetch, browser pages, emails,
    docs, attachments, pasted logs), that content can include instructions that try
    to hijack the model. This can happen even if **you are the only sender**.

    The biggest risk is when tools are enabled: the model can be tricked into
    exfiltrating context or calling tools on your behalf. Reduce the blast radius by:

    - using a read-only or tool-disabled "reader" agent to summarize untrusted content
    - keeping `web_search` / `web_fetch` / `browser` off for tool-enabled agents
    - treating decoded file/document text as untrusted too: OpenResponses
      `input_file` and media-attachment extraction both wrap extracted text in
      explicit external-content boundary markers instead of passing raw file text
    - sandboxing and strict tool allowlists

    Details: [Security](/gateway/security).

  </Accordion>

  <Accordion title="Should my bot have its own email, GitHub account, or phone number?">
    Yes, for most setups. Isolating the bot with separate accounts and phone numbers
    reduces the blast radius if something goes wrong. This also makes it easier to rotate
    credentials or revoke access without impacting your personal accounts.

    Start small. Give access only to the tools and accounts you actually need, and expand
    later if required.

    Docs: [Security](/gateway/security), [Pairing](/channels/pairing).

  </Accordion>

  <Accordion title="Can I give it autonomy over my text messages and is that safe?">
    We do **not** recommend full autonomy over your personal messages. The safest pattern is:

    - Keep DMs in **pairing mode** or a tight allowlist.
    - Use a **separate number or account** if you want it to message on your behalf.
    - Let it draft, then **approve before sending**.

    If you want to experiment, do it on a dedicated account and keep it isolated. See
    [Security](/gateway/security).

  </Accordion>

  <Accordion title="Can I use cheaper models for personal assistant tasks?">
    Yes, **if** the agent is chat-only and the input is trusted. Smaller tiers are
    more susceptible to instruction hijacking, so avoid them for tool-enabled agents
    or when reading untrusted content. If you must use a smaller model, lock down
    tools and run inside a sandbox. See [Security](/gateway/security).
  </Accordion>

  <Accordion title="I ran /start in Telegram but did not get a pairing code">
    Pairing codes are sent **only** when an unknown sender messages the bot and
    `dmPolicy: "pairing"` is enabled. `/start` by itself doesn't generate a code.

    Check pending requests:

    ```bash
    openclaw pairing list telegram
    ```

    If you want immediate access, allowlist your sender id or set `dmPolicy: "open"`
    for that account.

  </Accordion>

  <Accordion title="WhatsApp: will it message my contacts? How does pairing work?">
    No. Default WhatsApp DM policy is **pairing**. Unknown senders only get a pairing code and their message is **not processed**. OpenClaw only replies to chats it receives or to explicit sends you trigger.

    Approve pairing with:

    ```bash
    openclaw pairing approve whatsapp <code>
    ```

    List pending requests:

    ```bash
    openclaw pairing list whatsapp
    ```

    Wizard phone number prompt: it's used to set your **allowlist/owner** so your own DMs are permitted. It's not used for auto-sending. If you run on your personal WhatsApp number, use that number and enable `channels.whatsapp.selfChatMode`.

  </Accordion>
</AccordionGroup>

## Chat commands, aborting tasks, and "it will not stop"

<AccordionGroup>
  <Accordion title="How do I stop internal system messages from showing in chat?">
    Most internal or tool messages only appear when **verbose**, **trace**, or **reasoning** is enabled
    for that session.

    Fix in the chat where you see it:

    ```
    /verbose off
    /trace off
    /reasoning off
    ```

    If it is still noisy, check the session settings in the Control UI and set verbose
    to **inherit**. Also confirm you are not using a bot profile with `verboseDefault` set
    to `on` in config.

    Docs: [Thinking and verbose](/tools/thinking), [Security](/gateway/security#reasoning-verbose-output-in-groups).

  </Accordion>

  <Accordion title="How do I stop/cancel a running task?">
    Send any of these **as a standalone message** (no slash):

    ```
    stop
    stop action
    stop current action
    stop run
    stop current run
    stop agent
    stop the agent
    stop openclaw
    openclaw stop
    stop don't do anything
    stop do not do anything
    stop doing anything
    please stop
    stop please
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

  </Accordion>

  <Accordion title='How do I send a Discord message from Telegram? ("Cross-context messaging denied")'>
    OpenClaw blocks **cross-provider** messaging by default. If a tool call is bound
    to Telegram, it won't send to Discord unless you explicitly allow it.

    Enable cross-provider messaging for the agent:

    ```json5
    {
      tools: {
        message: {
          crossContext: {
            allowAcrossProviders: true,
            marker: { enabled: true, prefix: "[from {channel}] " },
          },
        },
      },
    }
    ```

    Restart the gateway after editing config.

  </Accordion>

  <Accordion title='Why does it feel like the bot "ignores" rapid-fire messages?'>
    Queue mode controls how new messages interact with an in-flight run. Use `/queue` to change modes:

    - `steer` - new messages redirect the current task
    - `followup` - run messages one at a time
    - `collect` - batch messages and reply once (default)
    - `steer-backlog` - steer now, then process backlog
    - `interrupt` - abort current run and start fresh

    You can add options like `debounce:2s cap:25 drop:summarize` for followup modes.

  </Accordion>
</AccordionGroup>

## Miscellaneous

<AccordionGroup>
  <Accordion title='What is the default model for Anthropic with an API key?'>
    In OpenClaw, credentials and model selection are separate. Setting `ANTHROPIC_API_KEY` (or storing an Anthropic API key in auth profiles) enables authentication, but the actual default model is whatever you configure in `agents.defaults.model.primary` (for example, `anthropic/claude-sonnet-4-6` or `anthropic/claude-opus-4-6`). If you see `No credentials found for profile "anthropic:default"`, it means the Gateway couldn't find Anthropic credentials in the expected `auth-profiles.json` for the agent that's running.
  </Accordion>
</AccordionGroup>

---

Still stuck? Ask in [Discord](https://discord.com/invite/clawd) or open a [GitHub discussion](https://github.com/openclaw/openclaw/discussions).
