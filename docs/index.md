---
summary: "OpenClaw is an open-source AI assistant that runs on your own hardware and meets you in every chat app you already use."
read_when:
  - Introducing OpenClaw to newcomers
title: "OpenClaw"
---

# OpenClaw 🦞

<p align="center">
    <img
        src="/assets/openclaw-hero-light.png"
        alt="OpenClaw"
        width="500"
        class="dark:hidden"
    />
    <img
        src="/assets/openclaw-hero-dark.png"
        alt="OpenClaw"
        width="500"
        class="hidden dark:block"
    />
</p>

> _"EXFOLIATE! EXFOLIATE!"_ — A space lobster, probably

<p align="center">
  <strong>Your AI assistant, on your own hardware, in every chat app you already use.</strong><br />
  One Gateway. Any model. Any device. No hosted service in the middle.<br />
  Developed in the open by the <a href="https://openclaw.org">OpenClaw Foundation</a>, an independent 501(c)(3). No paid tier, no telemetry by default beyond a <a href="/gateway/telemetry">version check</a> you can turn off, no lab owns it.
</p>

<Columns>
  <Card title="Get Started" href="/start/getting-started" icon="rocket">
    Install OpenClaw and bring up the Gateway in minutes.
  </Card>
  <Card title="Run Onboarding" href="/start/wizard" icon="list-checks">
    Guided setup with `openclaw onboard` and pairing flows.
  </Card>
  <Card title="Connect a Channel" href="/channels" icon="message-circle">
    Link Discord, Signal, Telegram, WhatsApp, and more to chat from anywhere.
  </Card>
  <Card title="Open the Control UI" href="/web/control-ui" icon="layout-dashboard">
    Launch the browser dashboard for chat, config, and sessions.
  </Card>
</Columns>

## Browse docs

Mobile browsers may show the section menu without the full desktop tab bar. Use
these hub links to reach the same top-level docs areas from the page body.

<Columns>
  <Card title="Get started" href="/start/getting-started" icon="rocket">
    Overview, showcase, first steps, and setup guides.
  </Card>
  <Card title="Install" href="/install" icon="download">
    Install paths, updates, containers, hosting, and advanced setup.
  </Card>
  <Card title="Channels" href="/channels" icon="messages-square">
    Messaging channels, pairing, routing, access groups, and channel QA.
  </Card>
  <Card title="Agents" href="/concepts/architecture" icon="bot">
    Architecture, sessions, context, memory, and multi-agent routing.
  </Card>
  <Card title="Capabilities" href="/tools" icon="wand-sparkles">
    Tools, skills, cron, webhooks, and automation capabilities.
  </Card>
  <Card title="ClawHub" href="/clawhub" icon="store">
    Plugin marketplace, publishing, curation, and trust guidance.
  </Card>
  <Card title="Models" href="/providers" icon="brain">
    Providers, model configuration, failover, and local model services.
  </Card>
  <Card title="Platforms" href="/platforms" icon="monitor-smartphone">
    macOS, Windows, iOS, Android, nodes, and web surfaces.
  </Card>
  <Card title="Gateway & Ops" href="/gateway" icon="server">
    Gateway configuration, security, diagnostics, and operations.
  </Card>
  <Card title="Reference" href="/cli" icon="terminal">
    CLI reference, schemas, RPC, release notes, and templates.
  </Card>
  <Card title="Help" href="/help" icon="life-buoy">
    Troubleshooting, FAQs, testing, diagnostics, and environment checks.
  </Card>
</Columns>

## What is OpenClaw?

OpenClaw is a **self-hosted gateway** that connects your favorite chat apps — Discord, Google Chat, iMessage, Matrix, Microsoft Teams, Signal, Slack, Telegram, WhatsApp, Zalo, and more via channel plugins — to AI coding agents. You run a single Gateway process on your own machine (or a server), and it becomes the bridge between your messaging apps and an always-available AI assistant.

**Who is it for?** Developers, power users, and teams who want an AI assistant they can message from anywhere — without giving up control of their data or relying on a hosted service. The same gateway runs as a personal assistant on one laptop or as a shared [team deployment](/start/teams); configuration is the only difference.

**What makes it different?**

- **Self-hosted**: runs on your hardware, your rules
- **Multi-channel**: one Gateway serves every configured channel plugin simultaneously
- **Agent-native**: built for coding agents with tool use, sessions, memory, and multi-agent routing
- **Open source**: MIT licensed, community-driven

The full architecture case — a trusted gateway, untrusted execution, deterministic policy, and how one product spans personal and team use — is in [Why OpenClaw](/start/why-openclaw).

**What do you need?** Node 26 (recommended), or another supported release: Node 24.16+ or Node 26.1+. You also need an API key from your chosen provider and 5 minutes. For best quality and security, use the strongest latest-generation model available.

## How it works

```mermaid
flowchart LR
  A["Chat apps + plugins"] --> B["Gateway"]
  B --> C["OpenClaw agent"]
  B --> D["CLI"]
  B --> E["Web Control UI"]
  B --> F["macOS app"]
  B --> G["iOS and Android nodes"]
```

The Gateway is the single source of truth for sessions, routing, and channel connections.

## Key capabilities

<Columns>
  <Card title="Multi-channel gateway" icon="network" href="/channels">
    Discord, iMessage, Signal, Slack, Telegram, WhatsApp, WebChat, and more with a single Gateway process.
  </Card>
  <Card title="Plugin channels" icon="plug" href="/tools/plugin">
    Channel plugins add Matrix, Nostr, Twitch, Zalo, and more; official plugins install on demand.
  </Card>
  <Card title="Multi-agent routing" icon="route" href="/concepts/multi-agent">
    Isolated sessions per agent, workspace, or sender.
  </Card>
  <Card title="Media support" icon="image" href="/nodes/images">
    Send and receive images, audio, and documents.
  </Card>
  <Card title="Web Control UI" icon="monitor" href="/web/control-ui">
    Browser dashboard for chat, config, sessions, and nodes.
  </Card>
  <Card title="Mobile nodes" icon="smartphone" href="/nodes">
    Pair iOS and Android nodes for camera, screen, and voice-enabled workflows.
  </Card>
</Columns>

## Quick start

<Steps>
  <Step title="Install OpenClaw">
    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    The installer detects your OS, installs Node if needed, installs OpenClaw,
    and then starts onboarding. Other install methods (npm, pnpm, bun, Docker,
    Nix, from source) are on the [Install](/install) page.

  </Step>
  <Step title="Complete onboarding">
    Onboarding offers **Quick start** and **Custom setup**. Quick start reuses
    detected AI access, verifies it with a real completion, and opens the web
    dashboard with a Gateway in the foreground. Custom setup walks the full
    guided flow. `openclaw onboard --classic` opens the classic step-by-step
    wizard instead.

  </Step>
  <Step title="Install the Gateway service">
    Quick start leaves the Gateway in the foreground. Press **Ctrl+C**, then
    install the background service:

    ```bash
    openclaw gateway install
    ```

  </Step>
  <Step title="Chat">
    Open the Control UI in your browser and send a message:

    ```bash
    openclaw dashboard
    ```

    Or connect a channel ([Telegram](/channels/telegram) is fastest) and chat from your phone.

  </Step>
</Steps>

Need the full install and dev setup? See [Getting Started](/start/getting-started).

## Dashboard

Open the browser Control UI after the Gateway starts.

- Local default: [http://127.0.0.1:18789/](http://127.0.0.1:18789/)
- Remote access: [Web surfaces](/web) and [Tailscale](/gateway/tailscale)

<p align="center">
  <img src="/whatsapp-openclaw.jpg" alt="OpenClaw" width="420" />
</p>

## Configuration (optional)

Config lives at `~/.openclaw/openclaw.json`.

- If you **do nothing**, OpenClaw uses the bundled OpenClaw agent runtime; DMs share the agent's main session, and each group chat gets its own session.
- If you want to lock it down, start with `channels.whatsapp.allowFrom` and (for groups) mention rules.

Example:

```json5
{
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
  messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
}
```

## Start here

<Columns>
  <Card title="Docs hubs" href="/start/hubs" icon="book-open">
    All docs and guides, organized by use case.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="settings">
    Core Gateway settings, tokens, and provider config.
  </Card>
  <Card title="Remote access" href="/gateway/remote" icon="globe">
    SSH and tailnet access patterns.
  </Card>
  <Card title="Channels" href="/channels" icon="message-square">
    Channel-specific setup for Discord, Feishu, Microsoft Teams, Telegram, WhatsApp, and more.
  </Card>
  <Card title="Nodes" href="/nodes" icon="smartphone">
    iOS and Android nodes with pairing, camera, screen, and device actions.
  </Card>
  <Card title="Help" href="/help" icon="life-buoy">
    Common fixes and troubleshooting entry point.
  </Card>
</Columns>

## Learn more

<Columns>
  <Card title="Full feature list" href="/concepts/features" icon="list">
    Complete channel, routing, and media capabilities.
  </Card>
  <Card title="Multi-agent routing" href="/concepts/multi-agent" icon="route">
    Workspace isolation and per-agent sessions.
  </Card>
  <Card title="Security" href="/gateway/security" icon="shield">
    Tokens, allowlists, and safety controls.
  </Card>
  <Card title="Troubleshooting" href="/gateway/troubleshooting" icon="wrench">
    Gateway diagnostics and common errors.
  </Card>
  <Card title="About and credits" href="/reference/credits" icon="info">
    Project origins, contributors, and license.
  </Card>
</Columns>
