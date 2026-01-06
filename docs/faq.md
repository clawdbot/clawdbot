---
summary: "Frequently asked questions about Clawdbot setup, configuration, and usage"
---
# FAQ 🦞

Common questions from the community. For detailed configuration, see [configuration.md](./configuration.md).

## Installation & Setup

### Where does Clawdbot store its data?

Everything lives under `~/.clawdbot/`:

| Path | Purpose |
|------|---------|
| `~/.clawdbot/clawdbot.json` | Main config (JSON5) |
| `~/.clawdbot/credentials/oauth.json` | OAuth credentials (Anthropic/OpenAI, etc.) |
| `~/.clawdbot/agent/auth-profiles.json` | Auth profiles (OAuth + API keys) |
| `~/.clawdbot/agent/auth.json` | Runtime API key cache (managed automatically) |
| `~/.clawdbot/credentials/` | WhatsApp/Telegram auth tokens |
| `~/.clawdbot/sessions/` | Conversation history & state |
| `~/.clawdbot/sessions/sessions.json` | Session metadata |

Your **workspace** (AGENTS.md, memory files, skills) is separate — configured via `agent.workspace` in your config (default: `~/clawd`).

### What platforms does Clawdbot run on?

**macOS and Linux** are the primary targets. Anywhere Node.js 22+ runs should work in theory.

- **macOS** — Fully supported, most tested
- **Linux** — Works great, common for VPS/server deployments
- **Windows** — Should work but largely untested! You're in pioneer territory 🤠

Some features are platform-specific:
- **iMessage** — macOS only (uses `imsg` CLI)
- **Clawdbot.app** — macOS native app (optional, gateway works without it)

### What are the minimum system requirements?

**Basically nothing!** The gateway is very lightweight — all heavy compute happens on Anthropic's servers.

- **RAM:** 512MB-1GB is enough (community member runs on 1GB VPS!)
- **CPU:** 1 core is fine for personal use
- **Disk:** ~500MB for Clawdbot + deps, plus space for logs/media

The gateway is just shuffling messages around. A Raspberry Pi 4 can run it. For the CLI, prefer the Node runtime (most stable):

```bash
pnpm clawdbot gateway
```

### How do I install on Linux without Homebrew?

Build CLIs from source! Example for `gogcli`:

```bash
git clone https://github.com/steipete/gogcli.git
cd gogcli
make
sudo mv bin/gog /usr/local/bin/
```

Most of Peter's tools are Go binaries — clone, build, move to PATH. No brew needed.

### I'm getting "unauthorized" errors on health check

You need a config file. Run the onboarding wizard:

```bash
pnpm clawdbot onboard
```

This creates `~/.clawdbot/clawdbot.json` with your API keys, workspace path, and owner phone number.

### How do I start fresh?

```bash
# Backup first (optional)
cp -r ~/.clawdbot ~/.clawdbot-backup

# Remove config and credentials
trash ~/.clawdbot

# Re-run onboarding
pnpm clawdbot onboard
pnpm clawdbot login
```

### Something's broken — how do I diagnose?

Run the doctor:

```bash
pnpm clawdbot doctor
```

It checks your config, skills status, and gateway health. It can also restart the gateway daemon if needed.

### Terminal onboarding vs macOS app?

**Use terminal onboarding** (`pnpm clawdbot onboard`) — it's more stable right now.

The macOS app onboarding is still being polished and can have quirks (e.g., WhatsApp 515 errors, OAuth issues).

---

## Authentication

### OAuth vs API key — what's the difference?

- **OAuth** — Uses your **subscription** (Anthropic Claude Pro/Max or OpenAI ChatGPT/Codex). No per‑token charges. ✅ Recommended!
- **API key** — Pay‑per‑token via the provider’s API billing. Can get expensive fast.

They're **separate billing**! An API key does NOT use your subscription.

**For OAuth:** During onboarding, pick **Anthropic OAuth** or **OpenAI Codex OAuth**, log in, paste the code/URL when prompted. Or just run:

```bash
pnpm clawdbot login
```

**If OAuth fails** (headless/container): Do OAuth on a normal machine, then copy `~/.clawdbot/credentials/oauth.json` to your server. The auth is just a JSON file.

### How are env vars loaded?

CLAWDBOT reads env vars from the parent process (shell, launchd/systemd, CI, etc.). It also loads `.env` files:
- `.env` in the current working directory
- global fallback: `~/.clawdbot/.env` (aka `$CLAWDBOT_STATE_DIR/.env`)

Neither `.env` file overrides existing env vars.

Optional convenience: import missing expected keys from your login shell env (sources your shell profile):

```json5
{
  env: { shellEnv: { enabled: true, timeoutMs: 15000 } }
}
```

Or set `CLAWDBOT_LOAD_SHELL_ENV=1` (timeout: `CLAWDBOT_SHELL_ENV_TIMEOUT_MS=15000`).

### Does enterprise OAuth work?

**Not currently.** Enterprise accounts use SSO which requires a different auth flow that pi-coding-agent doesn't support yet.

**Workaround:** Ask your enterprise admin to provision an API key via the Anthropic console, then use that with `ANTHROPIC_API_KEY`.

### OAuth callback not working (containers/headless)?

OAuth needs the callback to reach the machine running the CLI. Options:

1. **Copy auth manually** — Run OAuth on your laptop, copy `~/.clawdbot/credentials/oauth.json` to the container.
2. **SSH tunnel** — `ssh -L 18789:localhost:18789 user@server`
3. **Tailscale** — Put both machines on your tailnet.

---

## Migration & Deployment

### How do I migrate Clawdbot to a new machine (or VPS)?

1. **Backup on old machine:**
   ```bash
   # Config + credentials + sessions
   tar -czvf clawdbot-backup.tar.gz ~/.clawdbot
   
   # Your workspace (memories, AGENTS.md, etc.)
   tar -czvf workspace-backup.tar.gz ~/path/to/workspace
   ```

2. **Copy to new machine:**
   ```bash
   scp clawdbot-backup.tar.gz workspace-backup.tar.gz user@new-machine:~/
   ```

3. **Restore on new machine:**
   ```bash
   cd ~
   tar -xzvf clawdbot-backup.tar.gz
   tar -xzvf workspace-backup.tar.gz
   ```

4. **Install Clawdbot** (Node 22+, pnpm, clone repo, `pnpm install && pnpm build`)

5. **Start gateway:**
   ```bash
   pnpm clawdbot gateway
   ```

**Note:** WhatsApp may notice the IP change and require re-authentication. If so, run `pnpm clawdbot login` again. Stop the old instance before starting the new one to avoid conflicts.

### Can I run Clawdbot in Docker?

There's no official Docker setup yet, but it works. Key considerations:

- **WhatsApp login:** QR code works in terminal — no display needed.
- **Persistence:** Mount `~/.clawdbot/` and your workspace as volumes.
- **pnpm doesn't persist:** Global npm installs don't survive container restarts. Install pnpm in your startup script.
- **Browser automation:** Optional. If needed, install headless Chrome + Playwright deps, or connect to a remote browser via `--remote-debugging-port`.

**Volume mappings (e.g., Unraid):**
```
/mnt/user/appdata/clawdbot/config    → /root/.clawdbot
/mnt/user/appdata/clawdbot/workspace → /root/clawd
/mnt/user/appdata/clawdbot/app       → /app
```

**Startup script (`start.sh`):**
```bash
#!/bin/bash
npm install -g pnpm
cd /app
pnpm clawdbot gateway
```

**Container command:**
```
bash /app/start.sh
```

Docker support is on the roadmap — PRs welcome!

### Can I run Clawdbot headless on a VPS?

Yes! The terminal QR code login works fine over SSH. For long-running operation:

- Use `pm2`, `systemd`, or a `launchd` plist to keep the gateway running.
- Consider Tailscale for secure remote access.

### bun binary vs Node runtime?

Clawdbot can run as:
- **bun binary (macOS app)** — Single executable, easy distribution, auto-restarts via launchd
- **Node runtime** (`pnpm clawdbot gateway`) — More stable for WhatsApp

If you see WebSocket errors like `ws.WebSocket 'upgrade' event is not implemented`, use Node instead of the bun binary. Bun's WebSocket implementation has edge cases that can break WhatsApp (Baileys).

**For stability:** Use launchd (macOS) or the Clawdbot.app — they handle process supervision (auto-restart on crash).

**For debugging:** Use `pnpm gateway:watch` for live reload during development.

### WhatsApp keeps disconnecting / crashing (macOS app)

This is often the bun WebSocket issue. Workaround:

1. Run gateway with Node instead:
   ```bash
   pnpm gateway:watch
   ```
2. In **Clawdbot.app → Settings → Debug**, check **"External gateway"**
3. The app now connects to your Node gateway instead of spawning bun

This is the most stable setup until bun's WebSocket handling improves.

---

## Multi-Instance & Contexts

### Can I run multiple Clawds (separate instances)?

The intended design is **one Clawd, one identity**. Rather than running separate instances:

- **Add skills** — Give your Clawd multiple capabilities (business + fitness + personal).
- **Use context switching** — "Hey Clawd, let's talk about fitness" within the same conversation.
- **Use groups for separation** — Create Telegram/Discord groups for different contexts; each group gets its own session.

Why? A unified assistant knows your whole context. Your fitness coach knows when you've had a stressful work week.

If you truly need full separation (different users, privacy boundaries), you'd need:
- Separate config + state directories (`CLAWDBOT_CONFIG_PATH`, `CLAWDBOT_STATE_DIR`)
- Separate agent workspaces (`agent.workspace`)
- Separate gateway ports (`gateway.port` / `--port`)
- Separate phone numbers for WhatsApp (one number = one account)

### Can I have separate "threads" for different topics?

Currently, sessions are per-chat:
- Each WhatsApp/Telegram DM = one session
- Each group = separate session

**Workaround:** Create multiple groups (even just you + the bot) for different contexts. Each group maintains its own session.

Feature request? Open a [GitHub discussion](https://github.com/clawdbot/clawdbot/discussions)!

### How do groups work?

Groups get separate sessions automatically. By default, the bot requires a **mention** to respond in groups.

Per-group activation can be changed by the owner:
- `/activation mention` — respond only when mentioned (default)
- `/activation always` — respond to all messages

See [groups.md](./groups.md) for details.

---

## Context & Memory

### How much context can Clawdbot handle?

Claude Opus has a 200k token context window, and Clawdbot uses **autocompaction** — older conversation gets summarized to stay under the limit.

Practical tips:
- Keep `AGENTS.md` focused, not bloated.
- Use `/compact` to shrink older context or `/new` to reset when it gets stale.
- For large memory/notes collections, use search tools like `qmd` rather than loading everything.

### Where are my memory files?

In your workspace directory (configured in `agent.workspace`, default `~/clawd`). Look for:
- `memory/` — daily memory files
- `AGENTS.md` — agent instructions
- `TOOLS.md` — tool-specific notes

Check your config:
```bash
cat ~/.clawdbot/clawdbot.json | grep workspace
```

---

## Platforms

### Which platforms does Clawdbot support?

- **WhatsApp** — Primary. Uses WhatsApp Web protocol.
- **Telegram** — Via Bot API (grammY).
- **Discord** — Bot integration.
- **iMessage** — Via `imsg` CLI (macOS only).
- **Signal** — Via `signal-cli` (see [signal.md](./signal.md)).
- **WebChat** — Browser-based chat UI.

### Discord: Bot works in channels but not DMs?

Discord has **separate allowlists** for channels vs DMs:

- `discord.guilds.*.users` — controls who can talk in server channels
- `discord.dm.allowFrom` — controls who can DM the bot

If channels work but DMs don't, add `discord.dm.allowFrom` to your config:

```json
{
  "discord": {
    "dm": {
      "enabled": true,
      "allowFrom": ["YOUR_DISCORD_USER_ID"]
    },
    "guilds": {
      "your-server": {
        "users": ["YOUR_DISCORD_USER_ID"]
      }
    }
  }
}
```

Find your user ID: Discord Settings → Advanced → Developer Mode → right-click yourself → Copy User ID.

### Images/media not being understood by the agent?

If you send an image but your Clawd doesn't "see" it, check these:

**1. Is your model vision-capable?**

Not all models support images! Check `agent.model` in your config:

- ✅ Vision: `claude-opus-4-5`, `claude-sonnet-4-5`, `claude-haiku-4-5`, `gpt-5.2`, `gpt-4o`, `gemini-pro`
- ❌ No vision: Most local LLMs (Llama, Mistral), older models, text-only configs

**2. Is media being downloaded?**

```bash
ls -la ~/.clawdbot/media/inbound/
grep -i "media\|download" /tmp/clawdbot/clawdbot-*.log | tail -20
```

**3. Is `agent.mediaMaxMb` too low?**

Default is 5MB. Large images get resized, but if the limit is set very low, media might be skipped.

**4. Does the agent see `[media attached: ...]`?**

If this line isn't in the agent's input, the gateway didn't pass the media. Check logs for errors.

**5. For PDFs, audio, video, and exotic files:**

Use the [summarize](https://summarize.sh) skill to extract and condense content from files that can't be passed directly to vision.

### Can I use multiple platforms at once?

Yes! One Clawdbot gateway can connect to WhatsApp, Telegram, Discord, and more simultaneously. Each platform maintains its own sessions.

### WhatsApp: Can I use two numbers?

One WhatsApp account = one phone number = one gateway connection. For a second number, you'd need a second gateway instance with a separate config directory.

---

## Skills & Tools

### How do I add new skills?

Skills are auto-discovered from your workspace's `skills/` folder. After adding new skills:

1. Send `/reset` (or `/new`) in chat to start a new session
2. The new skills will be available

No gateway restart needed!

### How do I run commands on other machines?

Use **[Tailscale](https://tailscale.com/)** to create a secure network between your machines:

1. Install Tailscale on all machines (it's separate from Clawdbot — set it up yourself)
2. Each gets a stable IP (like `100.x.x.x`)
3. SSH just works: `ssh user@100.x.x.x "command"`

Clawdbot can use Tailscale when you set `bridge.bind: "tailnet"` in your config — it auto-detects your Tailscale IP.

For deeper integration, look into **Clawdbot nodes** — pair remote machines with your gateway for camera/screen/automation access.

---

## Troubleshooting

### Build errors (TypeScript)

If you hit build errors on `main`:

1. Pull latest: `git pull origin main && pnpm install`
2. Try `pnpm clawdbot doctor`
3. Check [GitHub issues](https://github.com/clawdbot/clawdbot/issues) or Discord
4. Temporary workaround: checkout an older commit

### WhatsApp logged me out

WhatsApp sometimes disconnects on IP changes or after updates. Re-authenticate:

```bash
pnpm clawdbot login
```

Scan the QR code and you're back.

### Gateway won't start

Check logs:
```bash
cat /tmp/clawdbot/clawdbot-$(date +%Y-%m-%d).log
```

Common issues:
- Port already in use (change with `--port`)
- Missing API keys in config
- Invalid config syntax (remember it's JSON5, but still check for errors)
- **Tailscale serve + bind conflict:** If using `tailscale.mode: "serve"`, you must set `gateway.bind: "loopback"` (not `"lan"`). Tailscale serve proxies traffic itself.

**Debug mode** — use watch for live reload:
```bash
pnpm gateway:watch
```

**Pro tip:** Use Codex to debug:
```bash
cd ~/path/to/clawdbot
codex --full-auto "debug why clawdbot gateway won't start"
```

### Gateway stops after I log out (Linux)

Linux installs use a systemd **user** service. By default, systemd stops user
services on logout/idle, which kills the Gateway.

Onboarding attempts to enable lingering; if it’s still off, run:
```bash
sudo loginctl enable-linger $USER
```

**macOS/Windows**

Gateway daemons run in the user session by default. Keep the user logged in.
Headless/system services are not configured out of the box.

### Processes keep restarting after I kill them

The gateway runs under a supervisor that auto-restarts it. You need to stop the supervisor, not just kill the process.

**macOS (launchd)**

```bash
# Check if running
launchctl list | grep clawdbot

# Stop (disable does NOT stop a running job)
clawdbot gateway stop

# Stop and disable
launchctl disable gui/$UID/com.clawdbot.gateway
launchctl bootout gui/$UID/com.clawdbot.gateway

# Re-enable later
launchctl enable gui/$UID/com.clawdbot.gateway
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.clawdbot.gateway.plist

# Or just restart
clawdbot gateway restart
```

**Linux (systemd)**

```bash
# Check if running
systemctl list-units | grep -i clawdbot

# Stop and disable
clawdbot gateway stop
systemctl --user disable --now clawdbot-gateway.service

# Or just restart
clawdbot gateway restart
```

**pm2 (if used)**

```bash
pm2 list
pm2 delete clawdbot
```

### Clean uninstall (start fresh)

```bash
# macOS: stop launchd service
launchctl disable gui/$UID/com.clawdbot.gateway
launchctl bootout gui/$UID/com.clawdbot.gateway 2>/dev/null

# Linux: stop systemd service
sudo systemctl disable --now clawdbot

# Kill any remaining processes
pkill -f "clawdbot"

# Remove data
trash ~/.clawdbot

# Remove repo and re-clone
trash ~/clawdbot
git clone https://github.com/clawdbot/clawdbot.git
cd clawdbot && pnpm install && pnpm build
pnpm clawdbot onboard
```

---

## Chat Commands

Quick reference (send these in chat):

| Command | Action |
|---------|--------|
| `/status` | Health + session info |
| `/new` or `/reset` | Reset the session |
| `/compact` | Compact session context |

Slash commands are owner-only (gated by `whatsapp.allowFrom` and command authorization on other surfaces).
| `/think <level>` | Set thinking level (off\|minimal\|low\|medium\|high) |
| `/verbose on\|off` | Toggle verbose mode |
| `/elevated on\|off` | Toggle elevated bash mode (approved senders only) |
| `/activation mention\|always` | Group activation (owner-only) |
| `/model <name>` | Switch AI model (see below) |
| `/queue instant\|batch\|serial` | Message queuing mode |

### How do I switch models on the fly?

Use `/model` to switch without restarting:

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

List available models with `/model`, `/model list`, or `/model status`.

Clawdbot ships a few default model shorthands (you can override them in config):
`opus`, `sonnet`, `gpt`, `gpt-mini`, `gemini`, `gemini-flash`.

**Setup:** Configure models and aliases in `clawdbot.json`:

```json
{
  "agent": {
    "model": { "primary": "anthropic/claude-opus-4-5" },
    "models": {
      "anthropic/claude-opus-4-5": { "alias": "opus" },
      "anthropic/claude-sonnet-4-5": { "alias": "sonnet" },
      "anthropic/claude-haiku-4-5": { "alias": "haiku" }
    }
  }
}
```

**Tip:** `/model` is processed at the gateway level — it works even if you're rate-limited (429) on the current model!

### Alternative providers (OpenRouter, Z.AI)?

If you don't want to use Anthropic directly, you can use alternative providers:

**OpenRouter** (pay-per-token, many models):
```json5
{
  agent: {
    model: { primary: "openrouter/anthropic/claude-sonnet-4" },
    models: { "openrouter/anthropic/claude-sonnet-4": {} },
    env: { OPENROUTER_API_KEY: "sk-or-..." }
  }
}
```

**Z.AI** (flat-rate plans, GLM models):
```json5
{
  agent: {
    model: { primary: "zai/glm-4.7" },
    models: { "zai/glm-4.7": {} },
    env: { ZAI_API_KEY: "..." }
  }
}
```

**Important:** Always use the latest Claude models (4.5 series). Don't use older 3.x models — they're deprecated and less capable. Check [OpenRouter models](https://openrouter.ai/models?q=claude) for exact IDs.

### Model + thinking mode issues?

Some models don't support extended thinking well:

- **Gemini Flash + thinking:** Can cause "Corrupted thought signature" errors. Fix: `/think off`
- **Claude Opus + thinking off:** Opus may "think out loud" anyway. Better to use `/think low` than `off`.
- **Local LLMs:** Most don't support the thinking/reasoning separation. Set `reasoning: false` in your model config.

If you get weird errors after switching models, try `/think off` and `/new` to reset.

### How do I stop/cancel a running task?

Send `/stop` to immediately abort the current agent run. Other stop words also work:
- `/stop`
- `/abort`
- `/esc`
- `/exit`

For background processes (like Codex), use:
```
process action:kill sessionId:XXX
```

You can also configure `routing.queue.mode` to control how new messages interact with running tasks:
- `steer` — New messages redirect the current task
- `interrupt` — Kills current run, starts fresh
- `collect` — Queues messages for after

### Does Codex CLI use my ChatGPT Pro subscription or API credits?

**Both are supported!** Codex CLI can auth via:

1. **Browser/Device OAuth** → Uses your ChatGPT Pro/Plus subscription (no per-token cost)
   ```bash
   codex login --device-auth
   # Opens browser, log in with your ChatGPT account
   ```

2. **API key** → Pay-per-token via OpenAI API billing
   ```bash
   export OPENAI_API_KEY="sk-..."
   ```

If you have a ChatGPT subscription, use browser auth to avoid API charges!

### How do rapid-fire messages work?

Use `/queue` to control how messages sent in quick succession are handled:

- **`/queue instant`** — New messages interrupt/steer the current response
- **`/queue batch`** — Messages queue up, processed after current turn
- **`/queue serial`** — One at a time, in order

If you tend to send multiple short messages, `/queue instant` feels most natural.

---

*Still stuck? Ask in [Discord](https://discord.gg/qkhbAGHRBT) or open a [GitHub discussion](https://github.com/clawdbot/clawdbot/discussions).* 🦞
