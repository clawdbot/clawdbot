---
summary: "OAuth in OpenClaw: token exchange, storage, and multi-account patterns"
read_when:
  - You want to understand OpenClaw OAuth end-to-end
  - You hit token invalidation / logout issues
  - You want Claude CLI or OAuth auth flows
  - You want multiple accounts or profile routing
title: "OAuth"
---

OpenClaw supports OAuth ("subscription auth") for providers that offer it,
notably **OpenAI Codex (ChatGPT OAuth)** and **Anthropic Claude CLI reuse**.
For Anthropic, the practical split is:

- **Anthropic API key**: normal Anthropic API billing.
- **Anthropic Claude CLI / subscription auth inside OpenClaw**: Anthropic staff
  told us this usage is allowed again, so OpenClaw treats Claude CLI reuse and
  `claude -p` usage as sanctioned for this integration unless Anthropic
  publishes a new policy. For Anthropic in production, API key auth is still
  the safer recommended path.

OpenClaw stores both OpenAI API-key auth and ChatGPT/Codex OAuth under the
canonical provider id `openai`. Older `openai-codex:*` profile ids and
`auth.order.openai-codex` entries are legacy state repaired by
`openclaw doctor --fix`; use `openai:*` profile ids and `auth.order.openai` for
new config.

This page covers:

- how the OAuth **token exchange** works (PKCE)
- where tokens are **stored** (and why)
- how to handle **multiple accounts** (profiles + per-session overrides)

Provider plugins that ship their own OAuth or API-key flow run through the
same entry point:

```bash
openclaw models auth login --provider <id>
```

## The token sink (why it exists)

OAuth providers commonly mint a new refresh token on every login/refresh.
Some providers invalidate the previous refresh token when a new one is
issued for the same user/app. Practical symptom: log in via OpenClaw _and_
via Claude Code / Codex CLI, and one of them randomly gets logged out later.

To reduce that, OpenClaw treats the auth profile store as a **token sink**:

- the runtime reads credentials from one place per agent
- multiple profiles can coexist and route deterministically
- external CLI reuse is provider-specific: once OpenClaw owns a local OAuth
  profile for a provider, the local refresh token is canonical. If that local
  refresh token is rejected, OpenClaw reports the profile for
  re-authentication instead of falling back to external CLI token material.
  Codex CLI bootstrap is narrower still: it can only seed an empty
  `openai:default`-style profile before OpenClaw owns OAuth for that
  provider; after that, OpenClaw-owned refreshes stay canonical
- status/startup paths scope external CLI discovery to the provider set
  already configured, so an unrelated CLI login store is not probed for a
  single-provider setup

## Storage (where tokens live)

Secrets live per agent, keyed by the logical name `auth-profiles.json` (the
underlying store is the agent's SQLite database; the JSON name is kept for
compatibility and tooling display):

- Auth profiles (OAuth + API keys + optional value-level refs):
  `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Legacy compatibility file: `~/.openclaw/agents/<agentId>/agent/auth.json`
  (static `api_key` entries are scrubbed when discovered)

Legacy import-only file (still supported, but not the main store):

- `~/.openclaw/credentials/oauth.json` (imported into the auth profile store on first use)

All of the above also respect `$OPENCLAW_STATE_DIR` (state dir override). Full reference: [/gateway/configuration-reference#auth-storage](/gateway/configuration-reference#auth-storage)

For static secret refs and runtime snapshot activation behavior, see [Secrets Management](/gateway/secrets).

When a secondary agent has no local auth profile, OpenClaw uses read-through
inheritance from the default/main agent store; it does not clone the main
agent's store on read. OAuth refresh tokens are especially sensitive: normal
copy flows skip them by default because some providers rotate or invalidate
refresh tokens after use. Configure a separate OAuth login for an agent when
it needs an independent account.

## Anthropic Claude CLI reuse

OpenClaw supports Anthropic Claude CLI reuse and `claude -p` as a sanctioned
auth path. If you already have a local Claude login on the host,
onboarding/configure can reuse it directly. Anthropic setup-token remains
available as a supported token-auth path, but OpenClaw prefers Claude CLI
reuse when it is available.

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
and [Z.AI / GLM Coding Plan](/providers/zai).
</Warning>

## OAuth exchange (how login works)

OpenClaw's interactive login flows are implemented in `openclaw/plugin-sdk/llm.ts` and wired into the wizards/commands.

### Anthropic setup-token

Flow shape:

1. create the token by running `claude setup-token` on any machine with Claude Code, then start Anthropic setup-token or paste-token from OpenClaw
2. OpenClaw stores the resulting Anthropic credential in an auth profile
3. model selection stays on `anthropic/...`
4. existing Anthropic auth profiles remain available for rollback/order control

### OpenAI Codex (ChatGPT OAuth)

OpenAI Codex OAuth is explicitly supported for use outside the Codex CLI, including OpenClaw workflows.

The login command uses the canonical OpenAI provider id:

```bash
openclaw models auth login --provider openai
```

Use `--profile-id openai:<name>` for multiple ChatGPT/Codex OAuth accounts in
one agent. Do not use `openai-codex:<name>` for new profiles. Doctor migrates
that older prefix to a collision-free `openai:*` profile id; run
`openclaw models auth list --provider openai` after repair before copying
profile ids into `auth.order` or `/model ...@<profileId>`.

Flow shape (PKCE):

1. generate a PKCE verifier/challenge and a random `state`
2. open `https://auth.openai.com/oauth/authorize?...` (scope
   `openid profile email offline_access`)
3. try to capture the callback on `http://localhost:1455/auth/callback` (the
   callback host defaults to `localhost` and only accepts loopback hosts;
   override with `OPENCLAW_OAUTH_CALLBACK_HOST`)
4. if you can paste a code before the callback lands (or you are
   remote/headless and the callback can't bind), paste the redirect URL/code
   instead - manual paste races the browser callback and whichever completes
   first wins
5. exchange the code at `https://auth.openai.com/oauth/token`
6. extract `accountId` from the access token and store `{ access, refresh, expires, accountId }`

Wizard path is `openclaw onboard` → auth choice `openai`.

## Refresh + expiry

Profiles store an `expires` timestamp. At runtime:

- if `expires` is in the future, use the stored access token
- if expired, refresh (under a file lock) and overwrite the stored credentials
- if a secondary agent reads an inherited main-agent OAuth profile, the
  refresh writes back to the main agent store instead of copying the refresh
  token into the secondary agent store
- externally managed CLI credentials (Claude CLI, narrow Codex CLI bootstrap;
  see [The token sink](#the-token-sink-why-it-exists)) are re-read instead of
  spending a copied refresh token. If a managed refresh fails, OpenClaw
  reports the affected profile for re-authentication instead of returning
  external CLI token material.

The refresh flow is automatic; you generally do not need to manage tokens manually.

## Multiple accounts (profiles) + routing

Two patterns:

### 1) Preferred: separate agents

If you want "personal" and "work" to never interact, use isolated agents (separate sessions + credentials + workspace):

```bash
openclaw agents add work
openclaw agents add personal
```

Then configure auth per-agent (wizard) and route chats to the right agent.

### 2) Advanced: multiple profiles in one agent

The auth profile store supports multiple profile IDs for the same provider.
Pick which one is used:

- globally via config ordering (`auth.order`)
- per-session via `/model ...@<profileId>`

Example (session override):

- `/model Opus@anthropic:work`

List existing profile IDs with:

```bash
openclaw models auth list --provider <id>
```

Related docs:

- [Model failover](/concepts/model-failover) (rotation + cooldown rules)
- [Slash commands](/tools/slash-commands) (command surface)

## Related

- [Authentication](/gateway/authentication) - model provider auth overview
- [Secrets](/gateway/secrets) - credential storage and SecretRef
- [Configuration Reference](/gateway/configuration-reference#auth-storage) - auth config keys
