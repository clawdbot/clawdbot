---
summary: "Updating Clawdbot safely (global install or source), plus rollback strategy"
read_when:
  - Updating Clawdbot
  - Something breaks after an update
---

# Updating

Clawdbot is moving fast (pre “1.0”). Treat updates like shipping infra: update → run checks → restart → verify.

## Recommended: re-run the website installer (upgrade in place)

The **preferred** update path is to re-run the installer from the website. It
detects existing installs, upgrades in place, and runs `clawdbot doctor` when
needed.

```bash
curl -fsSL https://clawd.bot/install.sh | bash
```

Notes:
- Add `--no-onboard` if you don’t want the onboarding wizard to run again.
- For **source installs**, use:
  ```bash
  curl -fsSL https://clawd.bot/install.sh | bash -s -- --install-method git --no-onboard
  ```
  The installer will `git pull --rebase` **only** if the repo is clean.
- For **global installs**, the script uses `npm install -g clawdbot@latest` under the hood.

## Before you update

- Know how you installed: **global** (npm/pnpm) vs **from source** (git clone).
- Know how your Gateway is running: **foreground terminal** vs **supervised service** (launchd/systemd).
- Snapshot your tailoring:
  - Config: `~/.clawdbot/clawdbot.json`
  - Credentials: `~/.clawdbot/credentials/`
  - Workspace: `~/clawd`

## Update (global install)

Global install (pick one):

```bash
npm i -g clawdbot@latest
```

```bash
pnpm add -g clawdbot@latest
```
We do **not** recommend Bun for the Gateway runtime (WhatsApp/Telegram bugs).

Then:

```bash
clawdbot doctor
clawdbot daemon restart
clawdbot health
```

Notes:
- If your Gateway runs as a service, `clawdbot daemon restart` is preferred over killing PIDs.
- If you’re pinned to a specific version, see “Rollback / pinning” below.

## Update (`clawdbot update`)

For **source installs** (git checkout), prefer:

```bash
clawdbot update --restart
```

It runs a safe-ish update flow:
- Requires a clean worktree.
- Fetches + rebases against the configured upstream.
- Installs deps, builds, builds the Control UI, and runs `clawdbot doctor`.

If you installed via **npm/pnpm** (no git metadata), `clawdbot update` will skip. Use “Update (global install)” instead.

## Update (Control UI / RPC)

The Control UI has **Update & Restart** (RPC: `update.run`). It:
1) Runs the same source-update flow as `clawdbot update` (git checkout only).
2) Writes a restart sentinel with a structured report (stdout/stderr tail).
3) Restarts the gateway and pings the last active session with the report.

If the rebase fails, the gateway aborts and restarts without applying the update.

## Update (from source)

From the repo checkout:

Preferred:

```bash
clawdbot update
```

Manual (equivalent-ish):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
pnpm clawdbot doctor
pnpm clawdbot health
```

Notes:
- `pnpm build` matters when you run the packaged `clawdbot` binary ([`dist/entry.js`](https://github.com/clawdbot/clawdbot/blob/main/dist/entry.js)) or use Node to run `dist/`.
- If you run directly from TypeScript (`pnpm clawdbot ...`), a rebuild is usually unnecessary, but **config migrations still apply** → run doctor.
- Switching between global and git installs is easy: install the other flavor, then run `clawdbot doctor` so the gateway service entrypoint is rewritten to the current install.

## Always run: `clawdbot doctor`

Doctor is the “safe update” command. It’s intentionally boring: repair + migrate + warn.

Note: if you’re on a **source install** (git checkout), `clawdbot doctor` will offer to run `clawdbot update` first.

Typical things it does:
- Migrate deprecated config keys / legacy config file locations.
- Audit DM policies and warn on risky “open” settings.
- Check Gateway health and can offer to restart.
- Detect and migrate older gateway services (launchd/systemd; legacy schtasks) to current Clawdbot services.
- On Linux, ensure systemd user lingering (so the Gateway survives logout).

Details: [Doctor](/gateway/doctor)

## Start / stop / restart the Gateway

CLI (works regardless of OS):

```bash
clawdbot daemon status
clawdbot daemon stop
clawdbot daemon restart
clawdbot gateway --port 18789
clawdbot logs --follow
```

If you’re supervised:
- macOS launchd (app-bundled LaunchAgent): `launchctl kickstart -k gui/$UID/com.clawdbot.gateway` (use `com.clawdbot.<profile>` if set)
- Linux systemd user service: `systemctl --user restart clawdbot-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart clawdbot-gateway[-<profile>].service`
  - `launchctl`/`systemctl` only work if the service is installed; otherwise run `clawdbot daemon install`.

Runbook + exact service labels: [Gateway runbook](/gateway)

## Rollback / pinning (when something breaks)

### Pin (global install)

Install a known-good version (replace `<version>` with the last working one):

```bash
npm i -g clawdbot@<version>
```

```bash
pnpm add -g clawdbot@<version>
```

Tip: to see the current published version, run `npm view clawdbot version`.

Then restart + re-run doctor:

```bash
clawdbot doctor
clawdbot daemon restart
```

### Pin (source) by date

Pick a commit from a date (example: “state of main as of 2026-01-01”):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

Then reinstall deps + restart:

```bash
pnpm install
pnpm build
clawdbot daemon restart
```

If you want to go back to latest later:

```bash
git checkout main
git pull
```

## If you’re stuck

- Run `clawdbot doctor` again and read the output carefully (it often tells you the fix).
- Check: [Troubleshooting](/gateway/troubleshooting)
- Ask in Discord: https://channels.discord.gg/clawd
