---
summary: "Uninstall OpenClaw completely (CLI, service, state, workspace, container)"
read_when:
  - You want to remove OpenClaw from a machine
  - The gateway service is still running after uninstall
  - You installed via Docker or Podman
title: "Uninstall"
---

Three paths:

- **Easy path** if `openclaw` is still installed.
- **Manual service removal** if the CLI is gone but the service is still running.
- **Container installations** (Docker / Podman) if you installed with the container setup scripts.

## Easy path (CLI still installed)

Recommended: use the built-in uninstaller:

```bash
openclaw uninstall
```

State removal preserves configured workspace directories unless you also select `--workspace`.

Preview what will be removed (safe):

```bash
openclaw uninstall --dry-run --all
```

Non-interactive (automation / npx). Use with caution and only after confirming scopes:

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

Flags: `--service`, `--state`, `--workspace`, `--app` select individual scopes; `--all` selects all four.

Manual steps (same result):

1. Stop the gateway service:

```bash
openclaw gateway stop
```

2. Uninstall the gateway service (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. Delete state + config:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

If you set `OPENCLAW_CONFIG_PATH` to a custom location outside the state dir, delete that file too.
If you want to keep a workspace inside the state dir, such as `~/.openclaw/workspace`, move it aside before running `rm -rf` or delete state contents selectively.

4. Delete your workspace (optional, removes agent files):

```bash
rm -rf ~/.openclaw/workspace
```

5. Remove the CLI install (pick the one you used):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. If you installed the macOS app:

```bash
rm -rf /Applications/OpenClaw.app
```

Notes:

- If you used profiles (`--profile` / `OPENCLAW_PROFILE`), repeat step 3 for each state dir (defaults are `~/.openclaw-<profile>`).
- In remote mode, the state dir lives on the **gateway host**, so run steps 1-4 there too.

## Manual service removal (CLI not installed)

Use this if the gateway service keeps running but `openclaw` is missing.

### macOS (launchd)

Default label is `ai.openclaw.gateway` (or `ai.openclaw.<profile>` with a profile):

```bash
launchctl bootout gui/$UID/ai.openclaw.gateway
rm -f ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

If you used a profile, replace the label and plist name with `ai.openclaw.<profile>`.

### Linux (systemd user unit)

Default unit name is `openclaw-gateway.service` (or `openclaw-gateway-<profile>.service`). A pre-rename `clawdbot-gateway.service` unit may still exist on machines upgraded from very old installs; `openclaw uninstall` / `openclaw gateway uninstall` detects and removes it automatically.

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

Default task name is `OpenClaw Gateway` (or `OpenClaw Gateway (<profile>)`).
The task launches a windowless `gateway.vbs` script under your state dir, which in turn
runs `gateway.cmd`; remove both.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd" -ErrorAction SilentlyContinue
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.vbs" -ErrorAction SilentlyContinue
```

If you used a profile, delete the matching task name and the `gateway.cmd` /
`gateway.vbs` files under `~\.openclaw-<profile>`.

## Normal install vs source checkout

### Normal install (install.sh / npm / pnpm / bun)

If you used `https://openclaw.ai/install.sh` or `install.ps1`, the CLI was installed with `npm install -g openclaw@latest`.
Remove it with `npm rm -g openclaw` (or `pnpm remove -g` / `bun remove -g` if you installed that way).

### Source checkout (git clone)

If you run from a repo checkout (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. Uninstall the gateway service **before** deleting the repo (use the easy path above or manual service removal).
2. Delete the repo directory.
3. Remove state + workspace as shown above.

## Container installations (Docker / Podman)

The CLI uninstaller above targets npm, service-manager, and state installs. It does **not** remove a container deployment. If you ran OpenClaw with the container setup scripts (`scripts/docker/setup.sh`, `scripts/podman/setup.sh`), remove the container footprint separately.

The two secret-bearing artifacts are the gateway token `.env` and the bind-mounted state directory; remove them last so you can still inspect them if anything reports an unexpected container identity.

### Docker Compose

1. Stop and remove the gateway container and its volumes, from the directory that holds your `docker-compose.yml`:

```bash
docker compose down -v --remove-orphans
```

`-v` also removes named volumes (gateway state and caches). Omit `-v` if you want to keep that state on disk.

2. Remove the image (use the `OPENCLAW_IMAGE` you set, or the default `openclaw:local`):

```bash
docker image rm openclaw:local
```

3. Remove the gateway token and any other secrets you passed to the install. The installer writes them to `${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}/.env`, which holds `OPENCLAW_GATEWAY_TOKEN`:

```bash
rm -f "${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}/.env"
```

4. Remove the bind-mounted state directory the install used (default `$HOME/.openclaw`):

```bash
rm -rf "${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
```

5. Optional: prune dangling images and build cache left by the install.

```bash
docker image prune -a
```

### Podman

Podman installs run as a systemd service through a Quadlet unit generated by `scripts/podman/setup.sh` (a `openclaw.container` unit). A rootless install runs under your user unit; a rootful install runs system-wide.

1. Stop and disable the Quadlet unit, remove the unit file, and reload systemd. Rootless:

```bash
systemctl --user disable --now openclaw.service
rm -f ~/.config/containers/systemd/openclaw.container
systemctl --user daemon-reload
```

For a rootful install, drop `--user` and remove the unit from `/etc/containers/systemd/`.

2. Remove the container, its volumes, and the image:

```bash
podman rm -f openclaw
podman volume prune
podman image rm openclaw:local
```

3. Remove the dedicated user you created for the install (if any) and its home directory:

```bash
sudo userdel -r openclaw
```

4. Remove the token `.env` and the state directory as in the Docker steps above.

## Related

- [Install overview](/install)
- [Migration guide](/install/migrating)
