---
summary: "OAuth in OpenClaw: token exchange, storage, and multi-account patterns"
read_when:
  - You want to understand OpenClaw OAuth end-to-end
  - You hit token invalidation / logout issues
  - You want Claude CLI or OAuth auth flows
  - You want multiple accounts or profile routing
title: "OAuth"
---

OpenClaw supports “subscription auth” via OAuth for providers that offer it
(notably **OpenAI Codex (ChatGPT OAuth)**). For Anthropic, the practical split
is now:

- **Anthropic API key**: normal Anthropic API billing
- **Anthropic Claude CLI / subscription auth inside OpenClaw**: Anthropic staff
  told us this usage is allowed again

OpenAI Codex OAuth is explicitly supported for use in external tools like
OpenClaw. This page explains:

For Anthropic in production, API key auth is the safer recommended path.

- how the OAuth **token exchange** works (PKCE)
- where tokens are **stored** (and why)
- how to handle **multiple accounts** (profiles + per-session overrides)

OpenClaw also supports **provider plugins** that ship their own OAuth or API‑key
flows. Run them via:

```bash
openclaw models auth login --provider <id>
```

## The token sink (why it exists)

OAuth providers commonly mint a **new refresh token** during login/refresh flows. Some providers (or OAuth clients) can invalidate older refresh tokens when a new one is issued for the same user/app.

Practical symptom:

- you log in via OpenClaw _and_ via Claude Code / Codex CLI → one of them randomly gets “logged out” later

To reduce that, OpenClaw treats `auth-profiles.json` as a **token sink**:

- the runtime reads credentials from **one place**
- we can keep multiple profiles and route them deterministically
- external CLI reuse is provider-specific: Codex CLI can bootstrap an empty
  `openai-codex:default` profile, but once OpenClaw has a local OAuth profile,
  the local refresh token is canonical; other integrations can remain
  externally managed and re-read their CLI auth store
- status and startup paths that already know the configured provider set scope
  external CLI discovery to that set, so an unrelated CLI login store is not
  probed for a single-provider setup

## Storage (where tokens live)

Secrets are stored in agent auth stores:

- Auth profiles (OAuth + API keys + optional value-level refs): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Legacy compatibility file: `~/.openclaw/agents/<agentId>/agent/auth.json`
  (static `api_key` entries are scrubbed when discovered)

Legacy import-only file (still supported, but not the main store):

- `~/.openclaw/credentials/oauth.json` (imported into `auth-profiles.json` on first use)

All of the above also respect `$OPENCLAW_STATE_DIR` (state dir override). Full reference: [/gateway/configuration](/gateway/configuration-reference#auth-storage)

For static secret refs and runtime snapshot activation behavior, see [Secrets Management](/gateway/secrets).

When a secondary agent has no local auth profile, OpenClaw uses read-through
inheritance from the default/main agent store. It does not clone the main
agent's `auth-profiles.json` on read. OAuth refresh tokens are especially
sensitive: normal copy flows skip them by default because some providers rotate
or invalidate refresh tokens after use. Configure a separate OAuth login for an
agent when it needs an independent account.

## Anthropic legacy token compatibility

<Warning>
Anthropic's public Claude Code docs say direct Claude Code use stays within
Claude subscription limits, and Anthropic staff told us OpenClaw-style Claude
CLI usage is allowed again. OpenClaw therefore treats Claude CLI reuse and
`claude -p` usage as sanctioned for this integration unless Anthropic
publishes a new policy.

For Anthropic's current direct-Claude-Code plan docs, see [Using Claude Code
with your Pro or Max
plan](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan)
and [Using Claude Code with your Team or Enterprise
plan](https://support.anthropic.com/en/articles/11845131-using-claude-code-with-your-team-or-enterprise-plan/).

If you want other subscription-style options in OpenClaw, see [OpenAI
Codex](/providers/openai), [Qwen Cloud Coding
Plan](/providers/qwen), [MiniMax Coding Plan](/providers/minimax),
and [Z.AI / GLM Coding Plan](/providers/glm).
</Warning>

OpenClaw also exposes Anthropic setup-token as a supported token-auth path, but it now prefers Claude CLI reuse and `claude -p` when available.

## Anthropic Claude CLI migration

OpenClaw supports Anthropic Claude CLI reuse again. If you already have a local
Claude login on the host, onboarding/configure can reuse it directly.

## OAuth exchange (how login works)

OpenClaw’s interactive login flows are implemented in `@mariozechner/pi-ai` and wired into the wizards/commands.

### Anthropic setup-token

Flow shape:

1. start Anthropic setup-token or paste-token from OpenClaw
2. OpenClaw stores the resulting Anthropic credential in an auth profile
3. model selection stays on `anthropic/...`
4. existing Anthropic auth profiles remain available for rollback/order control

### OpenAI Codex (ChatGPT OAuth)

OpenAI Codex OAuth is explicitly supported for use outside the Codex CLI, including OpenClaw workflows.

Flow shape (PKCE):

1. generate PKCE verifier/challenge + random `state`
2. open `https://auth.openai.com/oauth/authorize?...`
3. try to capture callback on `http://127.0.0.1:1455/auth/callback`
4. if callback can’t bind (or you’re remote/headless), paste the redirect URL/code
5. exchange at `https://auth.openai.com/oauth/token`
6. extract `accountId` from the access token and store `{ access, refresh, expires, accountId }`

Wizard path is `openclaw onboard` → auth choice `openai-codex`.

## Refresh + expiry

Profiles store an `expires` timestamp.

At runtime:

- if `expires` is in the future → use the stored access token
- if expired → refresh (under a file lock) and overwrite the stored credentials
- if a secondary agent reads an inherited main-agent OAuth profile, refresh
  writes back to the main agent store instead of copying the refresh token into
  the secondary agent store
- exception: some external CLI credentials stay externally managed; OpenClaw
  re-reads those CLI auth stores instead of spending copied refresh tokens.
  Codex CLI bootstrap is intentionally narrower: it seeds an empty
  `openai-codex:default` profile, then OpenClaw-owned refreshes keep the local
  profile canonical.

The refresh flow is automatic; you generally don't need to manage tokens manually.

## Multiple accounts (profiles) + routing

Two patterns:

### 1) Preferred: separate agents

If you want “personal” and “work” to never interact, use isolated agents (separate sessions + credentials + workspace):

```bash
openclaw agents add work
openclaw agents add personal
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

- `openclaw channels list --json` (shows `auth[]`)

Related docs:

- [Model failover](/concepts/model-failover) (rotation + cooldown rules)
- [Slash commands](/tools/slash-commands) (command surface)

## Related

- [Authentication](/gateway/authentication) — model provider auth overview
- [Secrets](/gateway/secrets) — credential storage and SecretRef
- [Configuration Reference](/gateway/configuration-reference#auth-storage) — auth config keys
