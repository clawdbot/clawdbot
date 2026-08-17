---
summary: "Install OpenClaw - installer script, npm/pnpm/bun, from source, Docker, and more"
read_when:
  - You need an install method other than the Getting Started quickstart
  - You want to deploy to a cloud platform
  - You need to update, migrate, or uninstall
title: "Install"
---

## System requirements

- **Node 22.22.3+, 24.15+, or 25.9+** - Node 26 is the recommended default; the installer script provisions it automatically when Node is missing.
- **macOS, Linux, or Windows** - Windows users can start with the native Windows Hub app, the PowerShell CLI installer, or a WSL2 Gateway. See [Windows](/platforms/windows).
- `pnpm` is only needed if you build from source.

## Recommended: installer script

The fastest way to install. It detects your OS, installs Node if needed, installs OpenClaw, and launches onboarding.

<Note>
Windows desktop users can also install the native [Windows Hub](/platforms/windows#recommended-windows-hub) companion app, which includes setup, tray status, chat, node mode, and local MCP mode.
</Note>

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

To install without running onboarding:

<Tabs>
  <Tab title="macOS / Linux / WSL2">
    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Windows (PowerShell)">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

For all flags and CI/automation options, see [Installer internals](/install/installer).

## Alternative install methods

### Local prefix installer (`install-cli.sh`)

Use this when you want OpenClaw and Node kept under a local prefix such as
`~/.openclaw`, without depending on a system-wide Node install:

```bash
curl -fsSL https://openclaw.ai/install-cli.sh | bash
```

It supports npm installs by default, plus git-checkout installs under the same
prefix flow. Full reference: [Installer internals](/install/installer#install-clish).

Already installed? Switch between package and git installs with
`openclaw update --channel dev` and `openclaw update --channel stable`. See
[Updating](/install/updating#switch-between-npm-and-git-installs).

### npm, pnpm, or bun

If you already manage Node yourself:

<Tabs>
  <Tab title="npm">
    On npm 12 or npm 11.16+:

    ```bash
    npm install -g openclaw@latest --allow-scripts=openclaw
    openclaw onboard --install-daemon
    ```

    On npm 11.12 and earlier, use the same command without
    `--allow-scripts=openclaw`. Do not use npm 11.13–11.15 for this install;
    upgrade to npm 11.16+ first.

    <Note>
    npm 12 blocks unapproved package lifecycle scripts by default. The
    `--allow-scripts=openclaw` option explicitly allows OpenClaw's `preinstall`
    and `postinstall` steps; without it, npm reports them as `blocked because
    they are not covered by allowScripts`.

    npm 11.16 accepts the option but otherwise only warns that the scripts are
    `not yet covered by allowScripts` and still runs them. npm 11.12 and earlier
    have neither the policy nor the option, so their command must be unflagged.
    npm 11.13–11.15 also lack the option, but they are transitional upstream
    releases outside this documented install contract; upgrade rather than
    relying on their unflagged behavior. The `npm approve-scripts openclaw`
    command suggested by npm 11.16 does not work for a global install — it fails
    with `ENOMATCH  No installed packages match: openclaw`.
    </Note>

    <Note>
    The hosted installer clears npm freshness filters such as `min-release-age`
    for the OpenClaw package install. If you install manually with npm, your own
    npm policy still applies.
    </Note>

  </Tab>
  <Tab title="pnpm">
    ```bash
    pnpm add -g --allow-build=openclaw openclaw@latest
    openclaw onboard --install-daemon
    ```

    <Note>
    pnpm requires explicit approval for packages with build scripts. `approve-builds -g` is not supported for global installs, so pass `--allow-build=openclaw` on the `pnpm add -g` command instead.
    </Note>

  </Tab>
  <Tab title="bun">
    ```bash
    bun add -g --trust openclaw@latest
    openclaw onboard --install-daemon
    ```

    <Note>
    `--trust` allows OpenClaw's package lifecycle scripts for this install. Bun
    can install the global package, but the resulting `openclaw` executable
    requires a supported Node runtime because OpenClaw state uses `node:sqlite`.
    </Note>

  </Tab>
</Tabs>

### From source

For contributors or anyone who wants to run from a local checkout:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install && pnpm build && pnpm ui:build
pnpm link --global
openclaw onboard --install-daemon
```

Or skip the link and use `pnpm openclaw ...` from inside the repo. See [Setup](/start/setup) for full development workflows.

### Install from the GitHub main checkout

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git --version main
```

### Containers and package managers

<CardGroup cols={2}>
  <Card title="Ansible" href="/install/ansible" icon="server">
    Automated fleet provisioning.
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Optional dependency installer and package-script runner.
  </Card>
  <Card title="ClawDock" href="/install/clawdock" icon="container">
    Community Docker Compose setup and shell helpers.
  </Card>
  <Card title="Docker" href="/install/docker" icon="container">
    Containerized or headless deployments.
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Declarative install via Nix flake.
  </Card>
  <Card title="Podman" href="/install/podman" icon="container">
    Rootless container alternative to Docker.
  </Card>
</CardGroup>

## Verify the install

```bash
openclaw --version      # confirm the CLI is available
openclaw doctor         # check for config issues
openclaw gateway status # verify the Gateway is running
```

If you want managed startup after install:

- macOS: LaunchAgent via `openclaw onboard --install-daemon` or `openclaw gateway install`
- Linux/WSL2: systemd user service via the same commands
- Native Windows: Scheduled Task first, with a per-user Startup-folder login item fallback if task creation is denied

## Hosting and deployment

Deploy OpenClaw on a cloud server or VPS. See [Linux server](/vps) for the full
provider picker (DigitalOcean, Hetzner, Hostinger, Fly.io, GCP, Azure, Railway,
Northflank, Oracle Cloud, Raspberry Pi, and more), deploy declaratively on
[Render](/install/render), or try the experimental [Cloudflare Containers](/install/cloudflare)
template.

<CardGroup cols={3}>
  <Card title="Cloudflare" href="/install/cloudflare">
    Experimental Worker + Container deployment.
  </Card>
  <Card title="Docker VM" href="/install/docker-vm-runtime">
    Shared Docker steps.
  </Card>
  <Card title="Kubernetes" href="/install/kubernetes">
    K8s deployment.
  </Card>
  <Card title="macOS VM" href="/install/macos-vm">
    Isolated local or hosted macOS deployment.
  </Card>
  <Card title="Upstash Box" href="/install/upstash">
    Managed Linux host with SSH-tunneled access.
  </Card>
  <Card title="VPS" href="/vps">
    Pick a provider.
  </Card>
</CardGroup>

## Back up, update, migrate, or uninstall

<CardGroup cols={3}>
  <Card title="Backups" href="/install/backups" icon="archive">
    Create, verify, and restore state archives.
  </Card>
  <Card title="Updating" href="/install/updating" icon="refresh-cw">
    Keep OpenClaw up to date.
  </Card>
  <Card title="Migrating" href="/install/migrating" icon="arrow-right">
    Move to a new machine.
  </Card>
  <Card title="Uninstall" href="/install/uninstall" icon="trash-2">
    Remove OpenClaw completely.
  </Card>
</CardGroup>

## Troubleshooting: `openclaw` not found

Almost always a PATH issue: npm's global bin directory isn't on your shell's `PATH`. See [Node.js troubleshooting](/install/node#troubleshooting) for the full fix, including the Windows path.

```bash
node -v           # Node installed?
npm prefix -g     # Where are global packages?
echo "$PATH"      # Is the global bin dir in PATH?
```
