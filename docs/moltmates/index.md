---
summary: "Moltmates - Multi-user Moltbot fork with isolated Docker sandboxes"
read_when:
  - Learning about Moltmates vs Moltbot
  - Setting up multi-user AI assistants
  - Understanding sandboxed execution
---

# 🦞 Moltmates

> **Multi-user Moltbot with isolated Docker sandboxes** — Give everyone their own AI assistant, safely.

<p align="center">
  <img src="../whatsapp-clawd.jpg" alt="Moltmates" width="400" />
</p>

<p align="center">
  <strong>One server. Many users. Zero trust issues.</strong>
</p>

---

## What is Moltmates?

**Moltmates** is a fork of [Moltbot](https://github.com/moltbot/moltbot) designed for **multi-user deployments** where you want to give friends, family, or team members their own AI assistant — without worrying about data leakage or security.

| Feature | Moltbot | Moltmates |
|---------|---------|-----------|
| Users | Single user | Multiple users |
| Isolation | Shared context | Per-user workspaces |
| Execution | Host system | Docker sandbox |
| Personas | One persona | Per-user personas |
| Memory | Shared | Isolated per user |
| Security | Trust-based | Zero-trust sandbox |

---

## Key Features

### 🐳 Docker Sandboxing

Every agent runs in an isolated container:

```
User A sends: "cat /etc/passwd"
→ Only sees sandbox /etc/passwd
→ No host access

User B sends: "rm -rf /"  
→ Only affects their sandbox
→ Rebuilt on restart
```

### 👥 Per-User Workspaces

Each user gets their own space:

```
~/.moltmate/users/telegram_{ID}/
├── SOUL.md       # Their bot's personality
├── USER.md       # Their profile
├── IDENTITY.md   # Bot name/avatar
├── MEMORY.md     # Important notes
└── memory/       # Daily conversation logs
```

### 🎭 Persona Selection

Users choose their AI's personality on first message:

```
Hey! 👋 Ich bin dein neuer AI Companion.
Wie soll ich sein?

1. ✨ Custom - Du beschreibst meine Persönlichkeit!
2. 🦎 Cami - Warm, locker, passt sich an
3. 🦀 Molty - Direkt, zuverlässig

Oder erzähl mir einfach wie ich sein soll...
```

### 🔒 Restricted Execution

Commands are allowlisted:

```json
{
  "exec": {
    "security": "allowlist",
    "safeBins": ["cat", "head", "tail", "grep", "wc", "pdftotext"]
  }
}
```

---

## Quick Start

### 1. Clone & Build

```bash
git clone https://github.com/YOUR_FORK/moltmates
cd moltmates
pnpm install
pnpm build
```

### 2. Build Sandbox Image

```bash
docker build -f Dockerfile.sandbox -t moltmate-sandbox:bookworm-slim .
```

### 3. Configure

```bash
cp ~/.moltmate/moltmate.example.json ~/.moltmate/moltmate.json
# Edit with your tokens and settings
```

### 4. Start

```bash
# Development
pnpm dev

# Production (systemd)
systemctl start moltmate
```

---

## Architecture

```
Telegram/WhatsApp/Discord
         │
         ▼
┌─────────────────────────────┐
│        Moltmates Gateway    │
│   (user routing + sessions) │
└──────────────┬──────────────┘
               │
      ┌────────┼────────┐
      ▼        ▼        ▼
┌─────────┐ ┌─────────┐ ┌─────────┐
│ User A  │ │ User B  │ │ User C  │
│ Docker  │ │ Docker  │ │ Docker  │
│ Sandbox │ │ Sandbox │ │ Sandbox │
└─────────┘ └─────────┘ └─────────┘
```

---

## Configuration

### Essential Settings

```json
{
  "sandbox": {
    "mode": "all",
    "scope": "session",
    "workspaceAccess": "rw"
  },
  "channels": {
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN",
      "dmPolicy": "allowlist",
      "allowFrom": ["USER_ID_1", "USER_ID_2"]
    }
  },
  "tools": {
    "allow": ["read", "write", "edit", "exec", "web_search", "web_fetch"],
    "exec": {
      "security": "allowlist",
      "safeBins": ["cat", "head", "tail", "grep", "wc"]
    }
  }
}
```

### Adding Users

1. Add their Telegram ID to `allowFrom`
2. Restart: `systemctl restart moltmate`
3. They message the bot → onboarding starts

---

## Comparison to Alternatives

| Solution | Isolation | Setup | Cost |
|----------|-----------|-------|------|
| ChatGPT Plus | None (OpenAI sees all) | Easy | $20/mo/user |
| Claude Pro | None (Anthropic sees all) | Easy | $20/mo/user |
| Self-hosted LLM | Full | Hard | Hardware |
| **Moltmates** | Full (Docker) | Medium | API costs only |

---

## Use Cases

- **Family** — Give kids/parents their own AI helper
- **Team** — Shared assistant without data leakage
- **Friends** — Let friends try AI without accounts
- **Testing** — Isolated environments for experiments
- **Education** — Each student gets their own assistant

---

## Links

- [FAQ](/moltmates/faq) — Common questions answered
- [Setup Guide](/moltmates/setup) — Detailed installation
- [Security](/moltmates/security) — How isolation works
- [Personas](/moltmates/personas) — Customizing bot personalities

---

## Credits

Built on [Moltbot](https://github.com/moltbot/moltbot) — the best personal AI assistant.

**Made with 🦞 by the community**
