---
summary: "Quick troubleshooting guide for common Clawdbot failures"
read_when:
  - Investigating runtime issues or failures
---
# Troubleshooting 🔧

When your CLAWDBOT misbehaves, here's how to fix it.

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
- macOS: `~/.clawdbot/logs/gateway.log` and `gateway.err.log`
- Linux: `journalctl --user -u clawdbot-gateway.service -n 200 --no-pager`
- Windows: `schtasks /Query /TN "Clawdbot Gateway" /V /FO LIST`

### Address Already in Use (Port 18789)

This means something is already listening on the gateway port.

**Check:**
```bash
clawdbot daemon status
```

It will show the listener(s) and likely causes (gateway already running, SSH tunnel).
If needed, stop the service or pick a different port.

### "Agent was aborted"

The agent was interrupted mid-response.

**Causes:**
- User sent `stop`, `abort`, `esc`, `wait`, or `exit`
- Timeout exceeded
- Process crashed

**Fix:** Just send another message. The session continues.

### Messages Not Triggering

**Check 1:** Is the sender in `whatsapp.allowFrom`?
```bash
cat ~/.clawdbot/clawdbot.json | jq '.whatsapp.allowFrom'
```

**Check 2:** For group chats, is mention required?
```bash
# The message must match mentionPatterns or explicit mentions; defaults live in provider groups/guilds.
cat ~/.clawdbot/clawdbot.json | jq '.routing.groupChat, .whatsapp.groups, .telegram.groups, .imessage.groups, .discord.guilds'
```

**Check 3:** Check the logs
```bash
tail -f "$(ls -t /tmp/clawdbot/clawdbot-*.log | head -1)" | grep "blocked\\|skip\\|unauthorized"
```

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
# Probe the running gateway + providers (WA connect + Telegram + Discord APIs)
clawdbot status --deep

# View recent connection events
tail -100 /tmp/clawdbot/clawdbot-*.log | grep "connection\\|disconnect\\|logout"
```

**Fix:** Usually reconnects automatically once the Gateway is running. If you’re stuck, restart the Gateway process (however you supervise it), or run it manually with verbose output:

```bash
clawdbot gateway --verbose
```

If you’re logged out / unlinked:

```bash
clawdbot logout
trash ~/.clawdbot/credentials # if logout can't cleanly remove everything
clawdbot login --verbose       # re-scan QR
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

CLAWDBOT keeps conversation history in memory.

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

**Fix 1: Kill Zombie Processes**
Another process might be holding the port.
```bash
lsof -nP -i :18789
# Kill any matching PIDs
kill -9 <PID>
```

If the gateway is supervised by launchd, killing the PID will just respawn it.
Stop the supervisor instead:
```bash
clawdbot gateway stop
# Or: launchctl bootout gui/$UID/com.clawdbot.gateway
```

**Fix 2: Check embedded gateway**
Ensure the gateway relay was properly bundled. Run [`./scripts/package-mac-app.sh`](https://github.com/clawdbot/clawdbot/blob/main/scripts/package-mac-app.sh) and ensure `bun` is installed.

## Debug Mode

Get verbose logging:

```bash
# Turn on trace logging in config:
#   ~/.clawdbot/clawdbot.json -> { logging: { level: "trace" } }
#
# Then run verbose commands to mirror debug output to stdout:
clawdbot gateway --verbose
clawdbot login --verbose
```

## Log Locations

| Log | Location |
|-----|----------|
| Main logs (default) | `/tmp/clawdbot/clawdbot-YYYY-MM-DD.log` |
| Session files | `~/.clawdbot/agents/<agentId>/sessions/` |
| Media cache | `~/.clawdbot/media/` |
| Credentials | `~/.clawdbot/credentials/` |

## Health Check

```bash
# Is the gateway reachable?
clawdbot health --json

# Is something listening on the default port?
lsof -nP -iTCP:18789 -sTCP:LISTEN

# Recent activity
tail -20 /tmp/clawdbot/clawdbot-*.log
```

## Reset Everything

Nuclear option:

```bash
trash ~/.clawdbot
clawdbot login         # re-pair WhatsApp
clawdbot gateway        # start the Gateway again
```

⚠️ This loses all sessions and requires re-pairing WhatsApp.

## Getting Help

1. Check logs first: `/tmp/clawdbot/` (default: `clawdbot-YYYY-MM-DD.log`, or your configured `logging.file`)
2. Search existing issues on GitHub
3. Open a new issue with:
   - CLAWDBOT version
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
