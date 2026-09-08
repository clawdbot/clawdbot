---
summary: "Run the OpenClaw Gateway on ChromeOS inside a Crostini Linux container"
read_when:
  - Installing OpenClaw on a Chromebook or ChromeOS device
  - Debugging missing provider keys or a Gateway that is gone after a reboot
title: "ChromeOS"
---

ChromeOS runs Linux software through **Crostini**, a managed Debian container
that Google exposes as the "Linux development environment". The Gateway runs
inside that container exactly like any other Linux install, so the [Linux
guide](/platforms/linux) applies in full. This page covers the ChromeOS
specific setup and the gotchas that differ from a plain Linux host.

Node is the primary, default, and recommended runtime. Bun 1.4+ builds with
WAL-reset-safe `node:sqlite` can run the CLI and Gateway as an explicit opt-in,
and Bun can also run package scripts. The installation path below uses Node.

## Enable the Linux container

Turn on Crostini before installing anything:

1. Open ChromeOS **Settings**.
2. Go to **About ChromeOS** then **Developers**.
3. Next to **Linux development environment**, select **Set up** and follow the
   prompts. ChromeOS downloads the Debian container and opens a **Terminal**.

Run every command below inside that Terminal.

## Quick path

1. Install via the installer script (it installs a supported Node for you):

   ```bash
   curl -fsSL https://openclaw.ai/install.sh | bash
   ```

2. Onboard and install the service:

   ```bash
   openclaw onboard --install-daemon
   ```

3. Confirm the Gateway is running:

   ```bash
   openclaw gateway status
   ```

Full server guidance lives in the [Linux guide](/platforms/linux) and the
[Gateway runbook](/gateway).

## Prefer the native install over Docker

On a single user Chromebook, use the native npm install (the installer script,
or `npm i -g openclaw@latest --allow-scripts=openclaw` on npm 12 or npm
11.16+) rather than [Docker](/install/docker). On npm 11.15 and earlier, omit
`--allow-scripts=openclaw`.

Docker works inside Crostini, but Docker in Crostini adds friction: if you use
the Claude Code CLI as your model runtime, it has to be installed and logged in
**inside a persisted container home**, which is easy to lose on a container
rebuild. The native install keeps the CLI and its login on the Crostini
filesystem directly, so a Docker image rebuild cannot wipe it.

## Node version

The Node version available in a Crostini container may be below OpenClaw's
minimum. OpenClaw requires Node 24.16+ or Node 26.1+; Node 26
is the recommended default. The installer script detects a missing or
unsupported Node version and provisions a supported release automatically.

If you installed Node yourself before OpenClaw, upgrade it **before** installing
OpenClaw:

```bash
node -v
```

See [Node install guidance](/install/node) for the supported versions.

## Provider keys and environment variables

The Gateway runs as a **systemd user service**, so an `export VAR=...` in an
interactive Terminal is not inherited by the already-installed service.

Put provider keys in `~/.openclaw/.env` instead, one per line:

```bash
DEEPSEEK_API_KEY=your-key-here
```

Then restart so the service picks them up:

```bash
openclaw gateway restart
```

See [Environment variables](/help/environment) for the full precedence and
source rules.

## Crostini is not always on

Do not treat Crostini as an always-on host. After a ChromeOS reboot, open the
**Terminal** once to start the Linux environment before relying on the Gateway.

Then verify the service:

```bash
openclaw gateway status
```

## Related

- [Linux guide](/platforms/linux)
- [Install overview](/install)
- [Node install guidance](/install/node)
- [Gateway runbook](/gateway)
- [Gateway configuration](/gateway/configuration)
- [Google: Set up Linux on your Chromebook](https://support.google.com/chromebook/answer/9145439)
