---
summary: "Moltmates FAQ - Comprehensive answers to common questions"
read_when:
  - Troubleshooting Moltmates issues
  - Understanding how Moltmates works
  - Comparing Moltmates to alternatives
---

# 🦞 Moltmates FAQ

> Comprehensive answers to frequently asked questions about Moltmates.

---

## General Questions

### What is Moltmates?

**Moltmates** is a multi-user fork of [Moltbot](https://github.com/moltbot/moltbot) that lets you run AI assistants for multiple people from a single server. Each user gets their own isolated workspace and Docker sandbox.

### How is Moltmates different from Moltbot?

| Aspect | Moltbot | Moltmates |
|--------|---------|-----------|
| Target use | Single user (you) | Multiple users (family/team) |
| Workspace | One shared | Per-user isolation |
| Security | Trusts the user | Zero-trust sandboxing |
| Personas | One bot personality | User-selectable personas |
| Execution | Direct on host | Docker containers |

### Is Moltmates free?

Yes! Moltmates is open source (MIT license). You only pay for:
- **API costs** — Anthropic/OpenAI usage
- **Server** — VPS or home server
- **Optional:** Domain, SSL, etc.

### What AI models can I use?

Moltmates supports all models Moltbot supports:
- **Anthropic:** Claude 3.5 Sonnet, Claude 3 Opus, Claude 4 (when available)
- **OpenAI:** GPT-4o, GPT-4 Turbo, o1, o1-mini
- **Local:** Ollama, llama.cpp, vLLM
- **Other:** Groq, Together, Perplexity, etc.

### Do users share context?

**No.** Each user has completely isolated:
- Conversation history
- Memory files (MEMORY.md)
- Workspace files
- Session state
- Docker container

User A cannot see User B's conversations or files.

---

## Setup & Installation

### What are the system requirements?

**Minimum:**
- 2 CPU cores
- 4 GB RAM
- 20 GB disk
- Docker installed
- Node.js ≥22

**Recommended:**
- 4+ CPU cores
- 8+ GB RAM
- 50+ GB SSD
- Docker with BuildKit

### How do I install Moltmates?

```bash
# Clone
git clone https://github.com/YOUR_FORK/moltmates
cd moltmates

# Install dependencies
pnpm install

# Build
pnpm build

# Build sandbox image
docker build -f Dockerfile.sandbox -t moltmate-sandbox:bookworm-slim .

# Configure
cp ~/.moltmate/moltmate.example.json ~/.moltmate/moltmate.json
nano ~/.moltmate/moltmate.json

# Start
pnpm dev  # or systemctl start moltmate
```

### How do I add a new user?

1. Get their Telegram/Discord/WhatsApp ID
2. Add to config:
   ```json
   "channels": {
     "telegram": {
       "allowFrom": ["existing_id", "NEW_USER_ID"]
     }
   }
   ```
3. Restart: `systemctl restart moltmate`
4. User messages bot → onboarding starts

### How do I remove a user?

1. Remove their ID from `allowFrom`
2. Delete their workspace:
   ```bash
   rm -rf ~/.moltmate/users/telegram_THEIR_ID/
   ```
3. Restart: `systemctl restart moltmate`

### How do I reset a user's workspace?

```bash
# Remove their workspace (they keep their allowlist entry)
rm -rf ~/.moltmate/users/telegram_THEIR_ID/

# Next message triggers fresh onboarding
```

---

## Security & Isolation

### How does sandbox isolation work?

Each user's agent runs in a Docker container with:
- **No network access** (optional)
- **Read-only root filesystem**
- **Isolated /tmp and workspace**
- **Allowlisted binaries only**
- **No access to host filesystem**

### What can users execute?

Only explicitly allowed commands:

```json
"exec": {
  "security": "allowlist",
  "safeBins": ["cat", "head", "tail", "grep", "wc", "pdftotext"]
}
```

Anything not in `safeBins` is blocked.

### Can users see each other's data?

**No.** Isolation is enforced at multiple levels:
1. **Session routing** — Messages go to correct user's session
2. **Workspace isolation** — Each user has own directory
3. **Docker containers** — Separate container per session
4. **Memory files** — Stored in user-specific paths

### What if a user tries to "jailbreak" the AI?

Several protections:
1. **Sandbox limits damage** — Even if jailbroken, can't access host
2. **Allowlisted tools** — Can't run arbitrary commands
3. **No network** (optional) — Can't exfiltrate data
4. **Session isolation** — Can't affect other users

### Is my API key safe?

API keys are:
- Stored in config on host (not in sandbox)
- Injected at runtime via environment
- Never visible to user agents
- Not logged or exposed

---

## Personas & Customization

### How do personas work?

On first message, users choose a persona:

```
1. ✨ Custom - Describe your own
2. 🦎 Cami - Warm and adaptive
3. 🦀 Molty - Direct and reliable
```

The selected persona template is copied to their `SOUL.md`.

### How do I add a new persona?

1. Create template in `templates/souls/`:
   ```bash
   nano /root/moltmates/templates/souls/my-persona.md
   ```

2. Update `src/users/persona-setup.ts`:
   ```typescript
   const PERSONAS = {
     custom: { emoji: "✨", file: "custom.md" },
     cami: { emoji: "🦎", file: "cami.md" },
     molty: { emoji: "🦀", file: "molty.md" },
     my_persona: { emoji: "🎭", file: "my-persona.md" }  // Add
   };
   ```

3. Rebuild: `pnpm build`
4. Restart: `systemctl restart moltmate`

### Can users change their persona later?

Yes, they can:
1. Edit their `SOUL.md` directly (if they have workspace access)
2. Ask the bot to update its personality
3. Have you reset their workspace for re-onboarding

### How do I edit a user's persona?

```bash
nano ~/.moltmate/users/telegram_THEIR_ID/SOUL.md
# Edit personality
systemctl restart moltmate
```

---

## Docker & Containers

### How do I check if sandbox is working?

```bash
# See running containers
docker ps | grep moltmate

# Should show: moltmate-sbx-SESSION_ID
```

### How do I add tools to the sandbox?

1. Edit `Dockerfile.sandbox`:
   ```dockerfile
   RUN apt-get update && apt-get install -y \
       poppler-utils \    # for pdftotext
       NEW_PACKAGE \      # add here
       && rm -rf /var/lib/apt/lists/*
   ```

2. Rebuild image:
   ```bash
   docker build -f Dockerfile.sandbox -t moltmate-sandbox:bookworm-slim .
   ```

3. Add to safeBins in config:
   ```json
   "safeBins": ["cat", "head", "pdftotext", "NEW_BINARY"]
   ```

4. Restart: `systemctl restart moltmate`

### Container won't start — what do I do?

```bash
# Stop orphaned containers
docker stop $(docker ps -q --filter name=moltmate-sbx)

# Remove them
docker rm $(docker ps -aq --filter name=moltmate-sbx)

# Restart gateway
systemctl restart moltmate

# Check logs
journalctl -u moltmate -f
```

### How much disk space do containers use?

- **Base image:** ~150 MB
- **Per container:** ~50-100 MB (ephemeral)
- **Workspaces:** Varies by user (typically <100 MB each)

Containers are ephemeral — they don't persist state between restarts.

---

## Channels & Messaging

### Which channels are supported?

All Moltbot channels work:
- ✈️ **Telegram** (recommended)
- 💬 **WhatsApp** (via Baileys)
- 🎮 **Discord**
- 💼 **Slack**
- 📧 **Google Chat**
- 📱 **iMessage** (macOS only)
- 🔒 **Signal**
- 🏢 **Microsoft Teams**
- 🔌 **Mattermost** (plugin)

### Can different users use different channels?

Yes! User A can use Telegram while User B uses Discord. Isolation is per-user, not per-channel.

### How do I set up Telegram?

1. Create bot via [@BotFather](https://t.me/BotFather)
2. Get token
3. Add to config:
   ```json
   "channels": {
     "telegram": {
       "botToken": "123456:ABC-DEF...",
       "dmPolicy": "allowlist",
       "allowFrom": ["YOUR_TELEGRAM_ID"]
     }
   }
   ```
4. Get your ID from [@userinfobot](https://t.me/userinfobot)

### How do I enable group chats?

```json
"channels": {
  "telegram": {
    "groupPolicy": "allowlist",
    "groups": {
      "allowFrom": ["GROUP_CHAT_ID"]
    }
  }
}
```

---

## Memory & Storage

### Where is user data stored?

```
~/.moltmate/
├── moltmate.json              # Main config
├── users/
│   ├── telegram_123456/       # User A
│   │   ├── SOUL.md           # Personality
│   │   ├── USER.md           # Profile
│   │   ├── MEMORY.md         # Notes
│   │   └── memory/           # Daily logs
│   └── telegram_789012/       # User B
│       └── ...
└── skills/                    # Shared skills
```

### How do I backup user data?

```bash
# Backup all users
tar -czf moltmates-backup-$(date +%Y%m%d).tar.gz ~/.moltmate/users/

# Backup specific user
tar -czf user-123-backup.tar.gz ~/.moltmate/users/telegram_123456/
```

### How do I restore from backup?

```bash
# Extract backup
tar -xzf moltmates-backup-20260128.tar.gz -C ~/

# Restart
systemctl restart moltmate
```

### Does the AI remember conversations?

Yes, via:
1. **Session history** — Recent messages in context
2. **MEMORY.md** — Important notes the AI saves
3. **memory/*.md** — Daily logs (if configured)

Memory is per-user and isolated.

---

## Troubleshooting

### Bot doesn't respond to messages

1. Check gateway is running: `systemctl status moltmate`
2. Check logs: `journalctl -u moltmate -f`
3. Verify user is in `allowFrom`
4. Check channel connection (Telegram token valid, etc.)

### "exec not working" error

1. Verify `exec` is in `tools.allow`:
   ```json
   "tools": { "allow": ["read", "write", "edit", "exec", ...] }
   ```
2. Check `safeBins` includes the command
3. Verify binary exists in sandbox:
   ```bash
   docker run --rm moltmate-sandbox:bookworm-slim which COMMAND
   ```

### User stuck in onboarding loop

```bash
# Reset their workspace
rm -rf ~/.moltmate/users/telegram_THEIR_ID/

# They'll get fresh onboarding on next message
```

### API rate limits / errors

1. Check your API quota (Anthropic/OpenAI dashboard)
2. Consider adding rate limits in config
3. Use cheaper model for non-critical users
4. Set up model fallbacks

### High memory usage

```bash
# Check container memory
docker stats

# Limit container memory in Dockerfile or compose
# Or reduce concurrent sessions
```

---

## Advanced Topics

### How do I run multiple instances?

Use different ports and state directories:

```bash
# Instance 1 (port 18789)
MOLTMATE_STATE_DIR=~/.moltmate-1 moltmate gateway --port 18789

# Instance 2 (port 18790)
MOLTMATE_STATE_DIR=~/.moltmate-2 moltmate gateway --port 18790
```

### Can I use different models per user?

Yes, via config overrides:
```json
"agents": {
  "main": {
    "model": "claude-sonnet-4-5"
  }
}
```

Or let users set via `/model` command if enabled.

### How do I monitor usage?

```bash
# Check logs
journalctl -u moltmate --since "1 hour ago"

# Monitor sessions
moltmate sessions list

# API usage: check provider dashboards
```

### Can users upload files?

Yes, depending on channel:
- **Telegram:** Images, documents, voice
- **Discord:** Attachments
- **WhatsApp:** Media messages

Files are processed in the user's sandbox.

---

## Migration & Updates

### How do I update Moltmates?

```bash
cd /root/moltmates
git pull origin main
pnpm install
pnpm build
systemctl restart moltmate
```

### How do I migrate from Moltbot?

1. Export your Moltbot config
2. Install Moltmates
3. Copy config, adjusting for multi-user settings
4. Copy MEMORY.md and workspace files if desired
5. Test with one user before enabling more

### Breaking changes between versions?

Check CHANGELOG.md before updating. Major changes are documented.

---

## Getting Help

### Where can I get support?

- **GitHub Issues:** File bugs and feature requests
- **Discord:** [discord.gg/clawd](https://discord.gg/clawd)
- **Docs:** [docs.molt.bot](https://docs.molt.bot)

### How do I report a bug?

1. Check existing issues first
2. Include:
   - Moltmates version
   - Node.js version
   - Docker version
   - Relevant logs (`journalctl -u moltmate`)
   - Steps to reproduce
3. File at GitHub Issues

### How do I contribute?

1. Fork the repo
2. Create feature branch
3. Make changes
4. Test thoroughly
5. Submit PR with clear description

---

**Made with 🦞 by the Moltmates community**
