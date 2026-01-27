---
summary: "Uninstall Moltbot completely (CLI, service, state, workspace)"
read_when:
  - You want to remove Moltbot from a machine
  - The gateway service is still running after uninstall
---

# Uninstall

Two paths:
- **Easy path** if `moltbot` is still installed.
- **Manual service removal** if the CLI is gone but the service is still running.

## Easy path (CLI still installed)

Recommended: use the built-in uninstaller:

```bash
moltbot uninstall
```

Non-interactive (automation / npx):

```bash
moltbot uninstall --all --yes --non-interactive
npx -y moltbot uninstall --all --yes --non-interactive
```

Manual steps (same result):

1) Stop the gateway service:

```bash
moltbot gateway stop
```

2) Uninstall the gateway service (launchd/systemd/schtasks):

```bash
moltbot gateway uninstall
```

3) Delete state + config:

```bash
rm -rf "${CLAWDBOT_STATE_DIR:-$HOME/.clawdbot}"
```

If you set `CLAWDBOT_CONFIG_PATH` to a custom location outside the state dir, delete that file too.

4) Delete your workspace (optional, removes agent files):

```bash
rm -rf ~/clawd
```

5) Remove the CLI install (pick the one you used):

```bash
npm rm -g moltbot
pnpm remove -g moltbot
bun remove -g moltbot
```

6) If you installed the macOS app:

```bash
rm -rf /Applications/Moltbot.app
```

Notes:
- If you used profiles (`--profile` / `CLAWDBOT_PROFILE`), repeat step 3 for each state dir (defaults are `~/.clawdbot-<profile>`).
- In remote mode, the state dir lives on the **gateway host**, so run steps 1-4 there too.

## Manual service removal (CLI not installed)

Use this if the gateway service keeps running but `moltbot` is missing.

### macOS (launchd)

Default label is `com.clawdbot.gateway` (or `com.clawdbot.<profile>`):

```bash
launchctl bootout gui/$UID/com.clawdbot.gateway
rm -f ~/Library/LaunchAgents/com.clawdbot.gateway.plist
```

If you used a profile, replace the label and plist name with `com.clawdbot.<profile>`.

### Linux (systemd user unit)

Default unit name is `moltbot-gateway.service` (or `moltbot-gateway-<profile>.service`):

```bash
systemctl --user disable --now moltbot-gateway.service
rm -f ~/.config/systemd/user/moltbot-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

Default task name is `Moltbot Gateway` (or `Moltbot Gateway (<profile>)`).
The task script lives under your state dir.

```powershell
schtasks /Delete /F /TN "Moltbot Gateway"
Remove-Item -Force "$env:USERPROFILE\.clawdbot\gateway.cmd"
```

If you used a profile, delete the matching task name and `~\.clawdbot-<profile>\gateway.cmd`.

## Normal install vs source checkout

### Normal install (install.sh / npm / pnpm / bun)

If you used `https://molt.bot/install.sh` or `install.ps1`, the CLI was installed with `npm install -g moltbot@latest`.
Remove it with `npm rm -g moltbot` (or `pnpm remove -g` / `bun remove -g` if you installed that way).

### Source checkout (git clone)

If you run from a repo checkout (`git clone` + `moltbot ...` / `bun run moltbot ...`):

1) Uninstall the gateway service **before** deleting the repo (use the easy path above or manual service removal).
2) Delete the repo directory.
3) Remove state + workspace as shown above.
