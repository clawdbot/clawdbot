---
summary: "Planned first-run onboarding flow for Clawdbot (local vs remote, OAuth auth, workspace bootstrap ritual)"
read_when:
  - Designing the macOS onboarding assistant
  - Implementing Anthropic/OpenAI auth or identity setup
---
# Onboarding (macOS app)

This doc describes the intended **first-run onboarding** for Clawdbot. The goal is a good “day 0” experience: pick where the Gateway runs, bind subscription auth (Anthropic or OpenAI) for the embedded agent runtime, and then let the **agent bootstrap itself** via a first-run ritual in the workspace.

## Page order (high level)

1) **Local vs Remote**
2) **(Local only)** Connect subscription auth (Anthropic / OpenAI OAuth) — optional, but recommended
3) **Connect Gmail (optional)** — run `clawdbot hooks gmail setup` to configure Pub/Sub hooks
4) **Onboarding chat** — dedicated session where the agent introduces itself and guides setup

## 1) Local vs Remote

First question: where does the **Gateway** run?

- **Local (this Mac):** onboarding can run OAuth flows and write OAuth credentials locally.
- **Remote (over SSH/tailnet):** onboarding must not run OAuth locally, because credentials must exist on the **gateway host**.

Gateway auth tip:
- If you only use Clawdbot on this Mac (loopback gateway), keep auth **Off**.
- Use **Token** for multi-machine access or non-loopback binds.

Implementation note (2025-12-19): in local mode, the macOS app bundles the Gateway and enables it via a per-user launchd LaunchAgent (no global npm install/Node requirement for the user).

## 2) Local-only: Connect subscription auth (Anthropic / OpenAI OAuth)

This is the “bind Clawdbot to subscription auth” step. It is explicitly the **Anthropic (Claude Pro/Max)** or **OpenAI (ChatGPT/Codex)** OAuth flow, not a generic “login”.

### Recommended: OAuth (Anthropic)

The macOS app should:
- Start the Anthropic OAuth (PKCE) flow in the user’s browser.
- Ask the user to paste the `code#state` value.
- Exchange it for tokens and write credentials to:
  - `~/.clawdbot/credentials/oauth.json` (file mode `0600`, directory mode `0700`)

Why this location matters: it’s the Clawdbot-owned OAuth store.
Clawdbot also imports `oauth.json` into the agent auth profile store (`~/.clawdbot/agent/auth-profiles.json`) on first use.

### Recommended: OAuth (OpenAI Codex)

The macOS app should:
- Start the OpenAI Codex OAuth (PKCE) flow in the user’s browser.
- Auto-capture the callback on `http://127.0.0.1:1455/auth/callback` when possible.
- If the callback fails, prompt the user to paste the redirect URL or code.
- Store credentials in `~/.clawdbot/credentials/oauth.json` (same OAuth store as Anthropic).
- Set `agent.model` to `openai-codex/gpt-5.2` when the model is unset or `openai/*`.

### Alternative: API key (instructions only)

Offer an “API key” option, but for now it is **instructions only**:
- Get an Anthropic API key.
- Provide it to Clawdbot via your preferred mechanism (env/config).

Note: environment variables are often confusing when the Gateway is launched by a GUI app (launchd environment != your shell).

### Model safety rule

Clawdbot should **always pass** `--model` when invoking the embedded agent (don’t rely on defaults).

Example (CLI):

```bash
clawdbot agent --mode rpc --model anthropic/claude-opus-4-5 "<message>"
```

If the user skips auth, onboarding should be clear: the agent likely won’t respond until auth is configured.

## 4) Onboarding chat (dedicated session)

The onboarding flow now embeds the SwiftUI chat view directly. It uses a **special session key**
(`onboarding`) so the “newborn agent” ritual stays separate from the main chat.

This onboarding chat is where the agent:
- does the BOOTSTRAP.md identity ritual (one question at a time)
- visits **soul.md** with the user and writes `SOUL.md` (values, tone, boundaries)
- asks how the user wants to talk (web-only / WhatsApp / Telegram)
- guides linking steps (including showing a QR inline for WhatsApp via the `whatsapp_login` tool)

If the workspace bootstrap is already complete (BOOTSTRAP.md removed), the onboarding chat step is skipped.

## 2.5) Optional: Connect Gmail

The macOS onboarding includes an optional Gmail step. It runs:

```bash
clawdbot hooks gmail setup --account you@gmail.com
```

This writes the full `hooks.gmail` config, installs `gcloud` / `gog` / `tailscale`
via Homebrew if needed, and configures the Pub/Sub push endpoint. After setup,
restart the gateway so the internal Gmail watcher starts.

Once setup is complete, the user can switch to the normal chat (`main`) via the menu bar panel.

## 5) Agent bootstrap ritual (outside onboarding)

We no longer collect identity in the onboarding wizard. Instead, the **first agent run** performs a playful bootstrap ritual using files in the workspace:

- Workspace is created implicitly (default `~/clawd`, configurable via `agent.workspace`) when local is selected,
  but only if the folder is empty or already contains `AGENTS.md`.
- Files are seeded: `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- `BOOTSTRAP.md` tells the agent to keep it conversational:
  - open with a cute hello
  - ask **one question at a time** (no multi-question bombardment)
  - offer a small set of suggestions where helpful (name, creature, emoji)
  - wait for the user’s reply before asking the next question
- The agent writes results to:
  - `IDENTITY.md` (agent name, vibe/creature, emoji)
  - `USER.md` (who the user is + how they want to be addressed)
  - `SOUL.md` (identity, tone, boundaries — crafted from the soul.md prompt)
  - `~/.clawdbot/clawdbot.json` (structured identity defaults)
- After the ritual, the agent **deletes `BOOTSTRAP.md`** so it only runs once.

Identity data still feeds the same defaults as before:

- outbound prefix emoji (`messages.responsePrefix`)
- group mention patterns / wake words
- default session intro (“You are Samantha…”)
- macOS UI labels

## 6) Workspace notes (no explicit onboarding step)

The workspace is created automatically as part of agent bootstrap (no dedicated onboarding screen).

Recommendation: treat the workspace as the agent’s “memory” and make it a git repo (ideally private) so identity + memories are backed up:

```bash
cd ~/clawd
git init
git add AGENTS.md
git commit -m "Add agent workspace"
```

Daily memory lives under `memory/` in the workspace:
- one file per day: `memory/YYYY-MM-DD.md`
- read today + yesterday on session start
- keep it short (durable facts, preferences, decisions; avoid secrets)

## Remote mode note (why OAuth is hidden)

If the Gateway runs on another machine, OAuth credentials must be created/stored on that host (where the agent runtime runs).

For now, remote onboarding should:
- explain why OAuth isn't shown
- point the user at the credential location (`~/.clawdbot/credentials/oauth.json`) and the auth profile store (`~/.clawdbot/agent/auth-profiles.json`) on the gateway host
- mention that the **bootstrap ritual happens on the gateway host** (same BOOTSTRAP/IDENTITY/USER files)

### Manual credential setup

On the gateway host, create `~/.clawdbot/credentials/oauth.json` with this exact format:

```json
{
  "anthropic": { "type": "oauth", "access": "sk-ant-oat01-...", "refresh": "sk-ant-ort01-...", "expires": 1767304352803 },
  "openai-codex": { "type": "oauth", "access": "eyJhbGciOi...", "refresh": "oai-refresh-...", "expires": 1767304352803, "accountId": "acct_..." }
}
```

Set permissions: `chmod 600 ~/.clawdbot/credentials/oauth.json`

**Note:** Clawdbot auto-imports from legacy pi-coding-agent paths (`~/.pi/agent/oauth.json`, etc.) but this does NOT work with Claude Code credentials — different file and format.

### Using Claude Code credentials

If Claude Code is installed on the gateway host, convert its credentials:

```bash
cat ~/.claude/.credentials.json | jq '{
  anthropic: {
    access: .claudeAiOauth.accessToken,
    refresh: .claudeAiOauth.refreshToken,
    expires: .claudeAiOauth.expiresAt
  }
}' > ~/.clawdbot/credentials/oauth.json
chmod 600 ~/.clawdbot/credentials/oauth.json
```

| Claude Code field | Clawdbot field |
|-------------------|---------------|
| `accessToken` | `access` |
| `refreshToken` | `refresh` |
| `expiresAt` | `expires` |
