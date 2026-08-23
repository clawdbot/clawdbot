---
summary: "Fix Chrome/Brave/Edge/Chromium CDP startup issues for OpenClaw browser control on Linux"
read_when: "Browser control fails on Linux, especially with snap Chromium"
title: "Browser troubleshooting"
---

## Problem: Failed to start Chrome CDP on port 18800

```json
{ "error": "Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"." }
```

### Root cause

On Ubuntu and most Linux distros, `apt install chromium` installs a snap
wrapper, not a real browser:

```text
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

Snap's AppArmor confinement interferes with how OpenClaw spawns and monitors
the browser process.

Other common Linux launch failures:

- `The profile appears to be in use by another Chromium process`: stale
  `Singleton*` lock files in the managed profile directory. OpenClaw removes
  these locks and retries once when the lock points at a dead or
  different-host process.
- `Missing X server or $DISPLAY`: a visible browser was explicitly requested
  on a host without a desktop session. Local managed profiles fall back to
  headless mode on Linux when both `DISPLAY` and `WAYLAND_DISPLAY` are unset.
  If you set `OPENCLAW_BROWSER_HEADLESS=0`, `browser.headless: false`, or
  `browser.profiles.<name>.headless: false`, remove that headed override, set
  `OPENCLAW_BROWSER_HEADLESS=1`, start `Xvfb`, run
  `openclaw browser start --headless` for a one-shot managed launch, or run
  OpenClaw in a real desktop session.

### Solution 1: install Google Chrome (recommended)

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

Update `~/.openclaw/openclaw.json`:

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true
  }
}
```

### Solution 2: use snap Chromium in attach-only mode

If you must keep snap Chromium, configure OpenClaw to attach to a
manually-started browser instead of launching it:

```json
{
  "browser": {
    "enabled": true,
    "attachOnly": true,
    "headless": true,
    "noSandbox": true
  }
}
```

Start Chromium manually:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

Optionally auto-start it with a systemd user service:

```ini
# ~/.config/systemd/user/openclaw-browser.service
[Unit]
Description=OpenClaw Browser (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now openclaw-browser.service
```

### Verify the browser works

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### Config reference

| Option                      | Description                                                          | Default                                                            |
| --------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `browser.enabled`           | Enable browser control                                               | `true`                                                             |
| `browser.executablePath`    | Path to a Chromium-based browser binary (Chrome/Brave/Edge/Chromium) | auto-detected (prefers the OS default browser when Chromium-based) |
| `browser.headless`          | Run without GUI                                                      | `false`                                                            |
| `OPENCLAW_BROWSER_HEADLESS` | Per-process override for local managed browser headless mode         | unset                                                              |
| `browser.noSandbox`         | Add `--no-sandbox` flag (needed for some Linux setups)               | `false`                                                            |
| `browser.attachOnly`        | Do not launch a browser; only attach to an existing one              | `false`                                                            |

On Raspberry Pi, older VPS hosts, or slow storage, use a manually launched
browser with `attachOnly` when Chrome needs more time to expose its CDP HTTP
endpoint or become ready than the managed-browser deadline permits.

### Problem: No Chrome tabs found for profile="user"

You are using the `user` (`existing-session` / Chrome MCP) profile and no
tabs are open to attach to.

Fix options:

1. Use the managed browser instead:
   `openclaw browser --browser-profile openclaw start` (or set
   `browser.defaultProfile: "openclaw"`).
2. Keep local Chrome running with at least one open tab, then retry with
   `--browser-profile user`.

Notes:

- `user` is host-only. On Linux servers, containers, or remote hosts, prefer
  CDP profiles instead.
- `user` and other `existing-session` profiles share the current Chrome MCP
  limits: ref-driven actions only, one file per upload, no dialog `timeoutMs`
  overrides, no `wait --load networkidle`, and no `responsebody`, PDF export,
  download interception, or batch actions.
- Local `openclaw`-driver profiles auto-assign `cdpPort`/`cdpUrl`; only set
  those manually for remote CDP.
- Remote CDP profiles accept `http://`, `https://`, `ws://`, and `wss://`.
  Use HTTP(S) for `/json/version` discovery, or WS(S) when your browser
  service gives you a direct DevTools socket URL.

## Related

- [Browser](/tools/browser)
- [Browser login](/tools/browser-login)
- [Browser WSL2 troubleshooting](/tools/browser-wsl2-windows-remote-cdp-troubleshooting)
