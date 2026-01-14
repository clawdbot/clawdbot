---
summary: "OAuth in Clawdbot: token exchange, storage, CLI sync, and multi-account patterns"
read_when:
  - You want to understand Clawdbot OAuth end-to-end
  - You hit token invalidation / logout issues
  - You want to reuse Claude Code / Codex CLI OAuth tokens
  - You want multiple accounts or profile routing
---
# OAuth

Clawdbot supports “subscription auth” via OAuth for providers that offer it (notably **Anthropic (Claude Pro/Max)** and **OpenAI Codex (ChatGPT OAuth)**). This page explains:

- how the OAuth **token exchange** works (PKCE)
- where tokens are **stored** (and why)
- how we **reuse external CLI tokens** (Claude Code / Codex CLI)
- how to handle **multiple accounts** (profiles + per-session overrides)

## The token sink (why it exists)

OAuth providers commonly mint a **new refresh token** during login/refresh flows. Some providers (or OAuth clients) can invalidate older refresh tokens when a new one is issued for the same user/app.

Practical symptom:
- you log in via Clawdbot *and* via Claude Code / Codex CLI → one of them randomly gets “logged out” later

To reduce that, Clawdbot treats `auth-profiles.json` as a **token sink**:
- the runtime reads credentials from **one place**
- we can **sync in** credentials from external CLIs instead of doing a second login
- we can keep multiple profiles and route them deterministically

## Storage (where tokens live)

Secrets are stored **per-agent**:

- Auth profiles (OAuth + API keys): `~/.clawdbot/agents/<agentId>/agent/auth-profiles.json`
- Runtime cache (managed automatically; don’t edit): `~/.clawdbot/agents/<agentId>/agent/auth.json`

Legacy import-only file (still supported, but not the main store):
- `~/.clawdbot/credentials/oauth.json` (imported into `auth-profiles.json` on first use)

All of the above also respect `$CLAWDBOT_STATE_DIR` (state dir override). Full reference: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Reusing Claude Code / Codex CLI OAuth tokens (recommended)

If you already signed in with the external CLIs *on the gateway host*, Clawdbot can reuse those tokens without starting a separate OAuth flow:

- Claude Code: `anthropic:claude-cli`
  - macOS: Keychain item "Claude Code-credentials" (choose "Always Allow" to avoid launchd prompts)
  - Linux/Windows: `~/.claude/.credentials.json`
- Codex CLI: reads `~/.codex/auth.json` → profile `openai-codex:codex-cli`

Sync happens when Clawdbot loads the auth store (so it stays up-to-date when the CLIs refresh tokens).
On macOS, the first read may trigger a Keychain prompt; run `clawdbot models status`
in a terminal once if the Gateway runs headless and can’t access the entry.

How to verify:

```bash
clawdbot models status
clawdbot channels list
```

Or JSON:

```bash
clawdbot channels list --json
```

## OAuth exchange (how login works)

Clawdbot’s interactive login flows are implemented in `@mariozechner/pi-ai` and wired into the wizards/commands.

### Anthropic (Claude Pro/Max)

Flow shape (PKCE):

1) generate PKCE verifier/challenge
2) open `https://claude.ai/oauth/authorize?...`
3) user pastes `code#state`
4) exchange at `https://console.anthropic.com/v1/oauth/token`
5) store `{ access, refresh, expires }` under an auth profile

The wizard path is `clawdbot onboard` → auth choice `oauth` (Anthropic).

### OpenAI Codex (ChatGPT OAuth)

Flow shape (PKCE):

1) generate PKCE verifier/challenge + random `state`
2) open `https://auth.openai.com/oauth/authorize?...`
3) try to capture callback on `http://127.0.0.1:1455/auth/callback`
4) if callback can’t bind (or you’re remote/headless), paste the redirect URL/code
5) exchange at `https://auth.openai.com/oauth/token`
6) extract `accountId` from the access token and store `{ access, refresh, expires, accountId }`

Wizard path is `clawdbot onboard` → auth choice `openai-codex` (or `codex-cli` to reuse an existing Codex CLI login).

## Refresh + expiry

Profiles store an `expires` timestamp.

At runtime:
- if `expires` is in the future → use the stored access token
- if expired → refresh (under a file lock) and overwrite the stored credentials

The refresh flow is automatic; you generally don't need to manage tokens manually.

### Bidirectional sync with Claude Code

When Clawdbot refreshes an Anthropic OAuth token (profile `anthropic:claude-cli`), it **writes the new credentials back** to Claude Code's storage:

- **Linux/Windows**: updates `~/.claude/.credentials.json`
- **macOS**: updates Keychain item "Claude Code-credentials"

This ensures both tools stay in sync and neither gets "logged out" after the other refreshes.

**Why this matters for long-running agents:**

Anthropic OAuth tokens expire after a few hours. Without bidirectional sync:
1. Clawdbot refreshes the token → gets new access token
2. Claude Code still has the old token → gets logged out

With bidirectional sync, both tools always have the latest valid token, enabling autonomous operation for days or weeks without manual intervention.

## Multiple accounts (profiles) + routing

Two patterns:

### 1) Preferred: separate agents

If you want “personal” and “work” to never interact, use isolated agents (separate sessions + credentials + workspace):

```bash
clawdbot agents add work
clawdbot agents add personal
```

Then configure auth per-agent (wizard) and route chats to the right agent.

### 2) Advanced: multiple profiles in one agent

`auth-profiles.json` supports multiple profile IDs for the same provider.

Pick which profile is used:
- globally via config ordering (`auth.order`)
- per-session via `/model ...@<profileId>`

Example (session override):
- `/model Opus@anthropic:work`

How to see what profile IDs exist:
- `clawdbot channels list --json` (shows `auth[]`)

Related docs:
- [/concepts/model-failover](/concepts/model-failover) (rotation + cooldown rules)
- [/tools/slash-commands](/tools/slash-commands) (command surface)
