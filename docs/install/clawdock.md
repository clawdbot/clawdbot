---
summary: "ClawDock shell helpers for Docker-based OpenClaw installs"
read_when:
  - You run OpenClaw with Docker often and want shorter day-to-day commands
  - You want a helper layer for dashboard, logs, token setup, and pairing flows
title: "ClawDock"
---

ClawDock is a small shell-helper layer for Docker-based OpenClaw installs.

It gives you short commands like `clawdock-start`, `clawdock-dashboard`, and `clawdock-fix-token` instead of longer `docker compose ...` invocations.

If you have not set up Docker yet, start with [Docker](/install/docker).

## Install

```bash
mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/clawdock/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh
echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

If you previously installed ClawDock from `scripts/shell-helpers/clawdock-helpers.sh`, reinstall from the current `scripts/clawdock/clawdock-helpers.sh` path; the old raw GitHub path was removed.

The helpers auto-detect your OpenClaw checkout on first use (checking common paths like `~/openclaw`, `~/projects/openclaw`) and cache the result in `~/.clawdock/config`. Set `CLAWDOCK_DIR` yourself if your checkout lives elsewhere.

## What you get

### Basic operations

| Command            | Description            |
| ------------------ | ---------------------- |
| `clawdock-start`   | Start the gateway      |
| `clawdock-stop`    | Stop the gateway       |
| `clawdock-restart` | Restart the gateway    |
| `clawdock-status`  | Check container status |
| `clawdock-logs`    | Follow gateway logs    |

### Container access

| Command                   | Description                                   |
| ------------------------- | --------------------------------------------- |
| `clawdock-shell`          | Open a shell inside the gateway container     |
| `clawdock-cli <command>`  | Run OpenClaw CLI commands in Docker           |
| `clawdock-exec <command>` | Execute an arbitrary command in the container |

### Web UI and pairing

| Command                 | Description                  |
| ----------------------- | ---------------------------- |
| `clawdock-dashboard`    | Open the Control UI URL      |
| `clawdock-devices`      | List pending device pairings |
| `clawdock-approve <id>` | Approve a pairing request    |

### Setup and maintenance

| Command              | Description                                       |
| -------------------- | ------------------------------------------------- |
| `clawdock-fix-token` | Write the gateway token into the container config |
| `clawdock-update`    | Pull, rebuild, and restart                        |
| `clawdock-rebuild`   | Rebuild the Docker image only                     |
| `clawdock-clean`     | Remove containers and volumes                     |

### Utilities

| Command                | Description                             |
| ---------------------- | --------------------------------------- |
| `clawdock-health`      | Run a gateway health check              |
| `clawdock-token`       | Print the gateway token                 |
| `clawdock-cd`          | Jump to the OpenClaw project directory  |
| `clawdock-config`      | Open `~/.openclaw`                      |
| `clawdock-show-config` | Print config files with redacted values |
| `clawdock-workspace`   | Open the workspace directory            |
| `clawdock-help`        | List all ClawDock commands              |

## First-time flow

```bash
clawdock-start
clawdock-fix-token
clawdock-dashboard
```

If the browser says pairing is required:

```bash
clawdock-devices
clawdock-approve <request-id>
```

## Config and secrets

ClawDock reads two separate `.env` files, matching the split described in [Docker](/install/docker):

- The project `.env` next to `docker-compose.yml`: Docker-specific values like image name, ports, and `OPENCLAW_GATEWAY_TOKEN`. `clawdock-token` reads the token from here.
- `~/.openclaw/.env` (mounted into the container): env-backed secrets OpenClaw itself manages, alongside `openclaw.json` and `agents/<agentId>/agent/auth-profiles.json`.

`clawdock-fix-token` copies the token from the project `.env` into the container's `gateway.remote.token` and `gateway.auth.token` config values and restarts the gateway.

Use `clawdock-show-config` to inspect `openclaw.json` and both `.env` files quickly; it redacts `.env` values in its printed output.

## Related

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="docker">
    Canonical Docker install for OpenClaw.
  </Card>
  <Card title="Docker VM runtime" href="/install/docker-vm-runtime" icon="cube">
    Docker-managed VM runtime for hardened isolation.
  </Card>
  <Card title="Updating" href="/install/updating" icon="arrow-up-right-from-square">
    Updating the OpenClaw package and managed services.
  </Card>
</CardGroup>
