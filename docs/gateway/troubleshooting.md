---
summary: "Quick troubleshooting guide for common Clawdbot failures"
read_when:
  - Investigating runtime issues or failures
---
# Troubleshooting 🔧

When Clawdbot misbehaves, here's how to fix it.

Start with the FAQ’s [First 60 seconds](/start/faq#first-60-seconds-if-somethings-broken) if you just want a quick triage recipe. This page goes deeper on runtime failures and diagnostics.

Provider-specific shortcuts: [/channels/troubleshooting](/channels/troubleshooting)

## Status & Diagnostics

Quick triage commands (in order):

| Command | What it tells you | When to use it |
|---|---|---|
| `clawdbot status` | Local summary: OS + update, gateway reachability/mode, daemon, agents/sessions, provider config state | First check, quick overview |
| `clawdbot status --all` | Full local diagnosis (read-only, pasteable, safe-ish) incl. log tail | When you need to share a debug report |
| `clawdbot status --deep` | Runs gateway health checks (incl. provider probes; requires reachable gateway) | When “configured” doesn’t mean “working” |
| `clawdbot gateway status` | Gateway discovery + reachability (local + remote targets) | When you suspect you’re probing the wrong gateway |
| `clawdbot channels status --probe` | Asks the running gateway for channel status (and optionally probes) | When gateway is reachable but channels misbehave |
| `clawdbot daemon status` | Supervisor state (launchd/systemd/schtasks), runtime PID/exit, last gateway error | When the daemon “looks loaded” but nothing runs |
| `clawdbot logs --follow` | Live logs (best signal for runtime issues) | When you need the actual failure reason |

**Sharing output:** prefer `clawdbot status --all` (it redacts tokens). If you paste `clawdbot status`, consider setting `CLAWDBOT_SHOW_SECRETS=0` first (token previews).

See also: [Health checks](/gateway/health) and [Logging](/logging).

## Common Issues

### Service Installed but Nothing is Running

If the gateway service is installed but the process exits immediately, the daemon
can appear “loaded” while nothing is running.

**Check:**
```bash
clawdbot daemon status
clawdbot doctor
```

Doctor/daemon will show runtime state (PID/last exit) and log hints.

**Logs:**
- Preferred: `clawdbot logs --follow`
- File logs (always): `/tmp/clawdbot/clawdbot-YYYY-MM-DD.log` (or your configured `logging.file`)
- macOS LaunchAgent (if installed): `$CLAWDBOT_STATE_DIR/logs/gateway.log` and `gateway.err.log`
- Linux systemd (if installed): `journalctl --user -u clawdbot-gateway[-<profile>].service -n 200 --no-pager`
- Windows: `schtasks /Query /TN "Clawdbot Gateway (<profile>)" /V /FO LIST`

**Enable more logging:**
- Bump file log detail (persisted JSONL):
  ```json
  { "logging": { "level": "debug" } }
  ```
- Bump console verbosity (TTY output only):
  ```json
  { "logging": { "consoleLevel": "debug", "consoleStyle": "pretty" } }
  ```
- Quick tip: `--verbose` affects **console** output only. File logs remain controlled by `logging.level`.

See [/logging](/logging) for a full overview of formats, config, and access.

### Service Environment (PATH + runtime)

The gateway daemon runs with a **minimal PATH** to avoid shell/manager cruft:
- macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
- Linux: `/usr/local/bin`, `/usr/bin`, `/bin`

This intentionally excludes version managers (nvm/fnm/volta/asdf) and package
managers (pnpm/npm) because the daemon does not load your shell init. Runtime
variables like `DISPLAY` should live in `~/.clawdbot/.env` (loaded early by the
gateway).

WhatsApp + Telegram channels require **Node**; Bun is unsupported. If your
service was installed with Bun or a version-managed Node path, run `clawdbot doctor`
to migrate to a system Node install.

### Service Running but Port Not Listening

If the service reports **running** but nothing is listening on the gateway port,
the Gateway likely refused to bind.

**What "running" means here**
- `Runtime: running` means your supervisor (launchd/systemd/schtasks) thinks the process is alive.
- `RPC probe` means the CLI could actually connect to the gateway WebSocket and call `status`.
- Always trust `Probe target:` + `Config (daemon):` as the “what did we actually try?” lines.

**Check:**
- `gateway.mode` must be `local` for `clawdbot gateway` and the daemon.
- If you set `gateway.mode=remote`, the **CLI defaults** to a remote URL. The daemon can still be running locally, but your CLI may be probing the wrong place. Use `clawdbot daemon status` to see the daemon’s resolved port + probe target (or pass `--url`).
- `clawdbot daemon status` and `clawdbot doctor` surface the **last gateway error** from logs when the service looks running but the port is closed.
- Non-loopback binds (`lan`/`tailnet`/`auto`) require auth:
  `gateway.auth.token` (or `CLAWDBOT_GATEWAY_TOKEN`).
- `gateway.remote.token` is for remote CLI calls only; it does **not** enable local auth.
- `gateway.token` is ignored; use `gateway.auth.token`.

**If `clawdbot daemon status` shows a config mismatch**
- `Config (cli): ...` and `Config (daemon): ...` should normally match.
- If they don’t, you’re almost certainly editing one config while the daemon is running another.
- Fix: rerun `clawdbot daemon install --force` from the same `--profile` / `CLAWDBOT_STATE_DIR` you want the daemon to use.

**If `clawdbot daemon status` reports service config issues**
- The supervisor config (launchd/systemd/schtasks) is missing current defaults.
- Fix: run `clawdbot doctor` to update it (or `clawdbot daemon install --force` for a full rewrite).

**If `Last gateway error:` mentions “refusing to bind … without auth”**
- You set `gateway.bind` to a non-loopback mode (`lan`/`tailnet`/`auto`) but left auth off.
- Fix: set `gateway.auth.mode` + `gateway.auth.token` (or export `CLAWDBOT_GATEWAY_TOKEN`) and restart the daemon.

**If `clawdbot daemon status` says `bind=tailnet` but no tailnet interface was found**
- The gateway tried to bind to a Tailscale IP (100.64.0.0/10) but none were detected on the host.
- Fix: bring up Tailscale on that machine (or change `gateway.bind` to `loopback`/`lan`).

**If `Probe note:` says the probe uses loopback**
- That’s expected for `bind=lan`: the gateway listens on `0.0.0.0` (all interfaces), and loopback should still connect locally.
- For remote clients, use a real LAN IP (not `0.0.0.0`) plus the port, and ensure auth is configured.

### Address Already in Use (Port 18789)

This means something is already listening on the gateway port.

**Check:**
```bash
clawdbot daemon status
```

It will show the listener(s) and likely causes (gateway already running, SSH tunnel).
If needed, stop the service or pick a different port.

### Legacy Workspace Folders Detected

If you upgraded from older installs, you might still have `~/clawdis` or
`~/clawdbot` on disk. Multiple workspace directories can cause confusing auth
or state drift because only one workspace is active.

**Fix:** keep a single active workspace and archive/remove the rest. See
[Agent workspace](/concepts/agent-workspace#legacy-workspace-folders).

### Main chat running in a sandbox workspace

Symptoms: `pwd` or file tools show `~/.clawdbot/sandboxes/...` even though you
expected the host workspace.

**Why:** `agents.defaults.sandbox.mode: "non-main"` keys off `session.mainKey` (default `"main"`).
Group/channel sessions use their own keys, so they are treated as non-main and
get sandbox workspaces.

**Fix options:**
- If you want host workspaces for an agent: set `agents.list[].sandbox.mode: "off"`.
- If you want host workspace access inside sandbox: set `workspaceAccess: "rw"` for that agent.

### "Agent was aborted"

The agent was interrupted mid-response.

**Causes:**
- User sent `stop`, `abort`, `esc`, `wait`, or `exit`
- Timeout exceeded
- Process crashed

**Fix:** Just send another message. The session continues.

### Messages Not Triggering

**Check 1:** Is the sender allowlisted?
```bash
clawdbot status
```
Look for `AllowFrom: ...` in the output.

**Check 2:** For group chats, is mention required?
```bash
# The message must match mentionPatterns or explicit mentions; defaults live in channel groups/guilds.
# Multi-agent: `agents.list[].groupChat.mentionPatterns` overrides global patterns.
grep -n "agents\\|groupChat\\|mentionPatterns\\|channels\\.whatsapp\\.groups\\|channels\\.telegram\\.groups\\|channels\\.imessage\\.groups\\|channels\\.discord\\.guilds" \
  "${CLAWDBOT_CONFIG_PATH:-$HOME/.clawdbot/clawdbot.json}"
```

**Check 3:** Check the logs
```bash
clawdbot logs --follow
# or if you want quick filters:
tail -f "$(ls -t /tmp/clawdbot/clawdbot-*.log | head -1)" | grep "blocked\\|skip\\|unauthorized"
```

### Pairing Code Not Arriving

If `dmPolicy` is `pairing`, unknown senders should receive a code and their message is ignored until approved.

**Check 1:** Is a pending request already waiting?
```bash
clawdbot pairing list <channel>
```

Pending DM pairing requests are capped at **3 per channel** by default. If the list is full, new requests won’t generate a code until one is approved or expires.

**Check 2:** Did the request get created but no reply was sent?
```bash
clawdbot logs --follow | grep "pairing request"
```

**Check 3:** Confirm `dmPolicy` isn’t `open`/`allowlist` for that channel.

### Image + Mention Not Working

Known issue: When you send an image with ONLY a mention (no other text), WhatsApp sometimes doesn't include the mention metadata.

**Workaround:** Add some text with the mention:
- ❌ `@clawd` + image
- ✅ `@clawd check this` + image

### Session Not Resuming

**Check 1:** Is the session file there?
```bash
ls -la ~/.clawdbot/agents/<agentId>/sessions/
```

**Check 2:** Is `idleMinutes` too short?
```json
{
  "session": {
    "idleMinutes": 10080  // 7 days
  }
}
```

**Check 3:** Did someone send `/new`, `/reset`, or a reset trigger?

### Agent Timing Out

Default timeout is 30 minutes. For long tasks:

```json
{
  "reply": {
    "timeoutSeconds": 3600  // 1 hour
  }
}
```

Or use the `process` tool to background long commands.

### WhatsApp Disconnected

```bash
# Check local status (creds, sessions, queued events)
clawdbot status
# Probe the running gateway + channels (WA connect + Telegram + Discord APIs)
clawdbot status --deep

# View recent connection events
clawdbot logs --limit 200 | grep "connection\\|disconnect\\|logout"
```

**Fix:** Usually reconnects automatically once the Gateway is running. If you’re stuck, restart the Gateway process (however you supervise it), or run it manually with verbose output:

```bash
clawdbot gateway --verbose
```

If you’re logged out / unlinked:

```bash
clawdbot channels logout
trash "${CLAWDBOT_STATE_DIR:-$HOME/.clawdbot}/credentials" # if logout can't cleanly remove everything
clawdbot channels login --verbose       # re-scan QR
```

### Media Send Failing

**Check 1:** Is the file path valid?
```bash
ls -la /path/to/your/image.jpg
```

**Check 2:** Is it too large?
- Images: max 6MB
- Audio/Video: max 16MB  
- Documents: max 100MB

**Check 3:** Check media logs
```bash
grep "media\\|fetch\\|download" "$(ls -t /tmp/clawdbot/clawdbot-*.log | head -1)" | tail -20
```

### High Memory Usage

Clawdbot keeps conversation history in memory.

**Fix:** Restart periodically or set session limits:
```json
{
  "session": {
    "historyLimit": 100  // Max messages to keep
  }
}
```

## macOS Specific Issues

### App Crashes when Granting Permissions (Speech/Mic)

If the app disappears or shows "Abort trap 6" when you click "Allow" on a privacy prompt:

**Fix 1: Reset TCC Cache**
```bash
tccutil reset All com.clawdbot.mac.debug
```

**Fix 2: Force New Bundle ID**
If resetting doesn't work, change the `BUNDLE_ID` in [`scripts/package-mac-app.sh`](https://github.com/clawdbot/clawdbot/blob/main/scripts/package-mac-app.sh) (e.g., add a `.test` suffix) and rebuild. This forces macOS to treat it as a new app.

### Gateway stuck on "Starting..."

The app connects to a local gateway on port `18789`. If it stays stuck:

**Fix 1: Stop the supervisor (preferred)**
If the gateway is supervised by launchd, killing the PID will just respawn it. Stop the supervisor first:
```bash
clawdbot daemon status
clawdbot daemon stop
# Or: launchctl bootout gui/$UID/com.clawdbot.gateway (replace with com.clawdbot.<profile> if needed)
```

**Fix 2: Port is busy (find the listener)**
```bash
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

If it’s an unsupervised process, try a graceful stop first, then escalate:
```bash
kill -TERM <PID>
sleep 1
kill -9 <PID> # last resort
```

**Fix 3: Check the CLI install**
Ensure the global `clawdbot` CLI is installed and matches the app version:
```bash
clawdbot --version
npm install -g clawdbot@<version>
```

## Debug Mode

Get verbose logging:

```bash
# Turn on trace logging in config:
#   ${CLAWDBOT_CONFIG_PATH:-$HOME/.clawdbot/clawdbot.json} -> { logging: { level: "trace" } }
#
# Then run verbose commands to mirror debug output to stdout:
clawdbot gateway --verbose
clawdbot channels login --verbose
```

## Log Locations

| Log | Location |
|-----|----------|
| Gateway file logs (structured) | `/tmp/clawdbot/clawdbot-YYYY-MM-DD.log` (or `logging.file`) |
| Gateway service logs (supervisor) | macOS: `$CLAWDBOT_STATE_DIR/logs/gateway.log` + `gateway.err.log` (default: `~/.clawdbot/logs/...`; profiles use `~/.clawdbot-<profile>/logs/...`)<br />Linux: `journalctl --user -u clawdbot-gateway[-<profile>].service -n 200 --no-pager`<br />Windows: `schtasks /Query /TN "Clawdbot Gateway (<profile>)" /V /FO LIST` |
| Session files | `$CLAWDBOT_STATE_DIR/agents/<agentId>/sessions/` |
| Media cache | `$CLAWDBOT_STATE_DIR/media/` |
| Credentials | `$CLAWDBOT_STATE_DIR/credentials/` |

## Health Check

```bash
# Supervisor + probe target + config paths
clawdbot daemon status
# Include system-level scans (legacy/extra services, port listeners)
clawdbot daemon status --deep

# Is the gateway reachable?
clawdbot health --json
# If it fails, rerun with connection details:
clawdbot health --verbose

# Is something listening on the default port?
lsof -nP -iTCP:18789 -sTCP:LISTEN

# Recent activity (RPC log tail)
clawdbot logs --follow
# Fallback if RPC is down
tail -20 /tmp/clawdbot/clawdbot-*.log
```

## Reset Everything

Nuclear option:

```bash
clawdbot daemon stop
# If you installed a service and want a clean install:
# clawdbot daemon uninstall

trash "${CLAWDBOT_STATE_DIR:-$HOME/.clawdbot}"
clawdbot channels login         # re-pair WhatsApp
clawdbot daemon restart           # or: clawdbot gateway
```

⚠️ This loses all sessions and requires re-pairing WhatsApp.

## Getting Help

1. Check logs first: `/tmp/clawdbot/` (default: `clawdbot-YYYY-MM-DD.log`, or your configured `logging.file`)
2. Search existing issues on GitHub
3. Open a new issue with:
   - Clawdbot version
   - Relevant log snippets
   - Steps to reproduce
   - Your config (redact secrets!)

---

*"Have you tried turning it off and on again?"* — Every IT person ever

🦞🔧

### Browser Not Starting (Linux)

If you see `"Failed to start Chrome CDP on port 18800"`:

**Most likely cause:** Snap-packaged Chromium on Ubuntu.

**Quick fix:** Install Google Chrome instead:
```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
```

Then set in config:
```json
{
  "browser": {
    "executablePath": "/usr/bin/google-chrome-stable"
  }
}
```

**Full guide:** See [browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
