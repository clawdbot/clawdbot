---
summary: "Get OpenClaw installed and run your first chat in minutes."
read_when:
  - First time setup from zero
  - You want the fastest path to a working chat
title: "Getting started"
---

Install OpenClaw, run onboarding, and chat with your AI assistant in about 5
minutes. By the end you will have a running Gateway, configured auth, and a
working chat session.

## What you need

- **Node.js 22.22.3+, 24.15+, or 25.9+** (Node 26 is the recommended runtime)
- **An existing Claude Code or Codex CLI login, or a provider API key** — onboarding can reuse it

<Tip>
Check your Node version with `node --version`.
**Windows users:** the native Windows Hub app is the easiest desktop path. The
PowerShell installer and WSL2 Gateway paths are also supported. See [Windows](/platforms/windows).
Need to install Node? See [Node setup](/install/node).
</Tip>

## Try it in one command

```bash
npx openclaw@latest
```

On a fresh install, choose **Quick start** after a one-line pointer to the
[security guide](/gateway/security). That is the only onboarding prompt when
usable AI access is already available: OpenClaw
finds an existing Claude Code or Codex CLI login or API key, verifies it with a
real completion, saves the config, and opens the web dashboard.

The Gateway runs in this terminal until you press **Ctrl+C**; your config stays
saved. If no detected route works, onboarding opens manual provider setup.
Choose **Custom setup** to walk through all guided options instead.

To keep the Gateway running in the background later, install the CLI below and
run `openclaw gateway install`. Run `openclaw` for the TUI or
`openclaw dashboard` to reopen the web UI.

## Quick setup

<Steps>
  <Step title="Install OpenClaw">
    <Tabs>
      <Tab title="macOS / Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
        <img
  src="/assets/install-script.svg"
  alt="Install Script Process"
  className="rounded-lg"
/>
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    Other install methods (Docker, Nix, npm): [Install](/install).
    </Note>

  </Step>
  <Step title="Complete onboarding">
    The installer starts the onboarding wizard automatically. Choose **Quick
    start** to reuse detected AI access and open the dashboard, or **Custom
    setup** for the full guided flow. Provider sign-in and optional setup can
    take longer; return later with `openclaw configure` for additional settings.
    Quick start keeps the Gateway in the foreground. For background operation,
    stop it with **Ctrl+C**, then run `openclaw gateway install`.

    See [Onboarding (CLI)](/start/wizard) for the full reference.

  </Step>
  <Step title="Verify the Gateway is running">
    ```bash
    openclaw gateway status
    ```

    You should see the Gateway listening on port 18789.

  </Step>
  <Step title="Open the dashboard">
    ```bash
    openclaw dashboard
    ```

    This opens the Control UI in your browser. If it loads, everything is working.

  </Step>
  <Step title="Send your first message">
    Type a message in the Control UI chat and you should get an AI reply.

    Want to chat from your phone instead? The fastest channel to set up is
    [Telegram](/channels/telegram) (just a bot token). See [Channels](/channels)
    for all options.

  </Step>
</Steps>

<Accordion title="Advanced: mount a custom Control UI build">
  If you maintain a localized or customized dashboard build, point
  `gateway.controlUi.root` to a directory that contains your built static
  assets and `index.html`.

```bash
mkdir -p "$HOME/.openclaw/control-ui-custom"
# Copy your built static files into that directory.
```

Then set:

```json
{
  "gateway": {
    "controlUi": {
      "enabled": true,
      "root": "${HOME}/.openclaw/control-ui-custom"
    }
  }
}
```

Restart the gateway and reopen the dashboard:

```bash
openclaw gateway restart
openclaw dashboard
```

</Accordion>

## If setup does not work

One command turns the current state of your install into a diagnosis you can act on:

```bash
openclaw triage
```

It runs read-only health checks, writes a sanitized prompt describing what it found, and then offers to hand that prompt to a coding agent it detects on your machine — Claude Code, Codex CLI, or the built-in OpenClaw agent — so the agent starts with the diagnosis already loaded. Pick "just print the commands" if you would rather run the handoff yourself.

Nothing leaves your machine until you choose an agent, and secrets, tokens, raw chat payloads, and raw logs are excluded from the prompt.

To read the findings yourself instead, run [`openclaw doctor`](/cli/doctor). For symptom-first routes, see [Troubleshooting](/help/troubleshooting).

## What to do next

<Columns>
  <Card title="Connect a channel" href="/channels" icon="message-square">
    Discord, Feishu, iMessage, Matrix, Microsoft Teams, Signal, Slack, Telegram, WhatsApp, Zalo, and more.
  </Card>
  <Card title="Pairing and safety" href="/channels/pairing" icon="shield">
    Control who can message your agent.
  </Card>
  <Card title="Configure the Gateway" href="/gateway/configuration" icon="settings">
    Models, tools, sandbox, and advanced settings.
  </Card>
  <Card title="Browse tools" href="/tools" icon="wrench">
    Browser, exec, web search, skills, and plugins.
  </Card>
</Columns>

<Accordion title="Advanced: environment variables">
  If you run OpenClaw as a service account or want custom paths:

- `OPENCLAW_HOME` — home directory for internal path resolution
- `OPENCLAW_STATE_DIR` — override the state directory
- `OPENCLAW_CONFIG_PATH` — override the config file path

Full reference: [Environment variables](/help/environment).
</Accordion>

## Related

- [Install overview](/install)
- [Channels overview](/channels)
- [Setup](/start/setup)
- [Triage](/cli/triage)
- [Troubleshooting](/help/troubleshooting)
