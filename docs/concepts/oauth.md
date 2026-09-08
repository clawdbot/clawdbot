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

Credentials use a shared read-through base, while each agent owns its local
credential overrides and auth-routing state:

- Shared credentials: `~/.openclaw/state/openclaw.sqlite`
- Agent-local credentials and state:
  `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`
- Agent credential rows: `auth_profile_store`
- Agent order, last-good, cooldown, and usage rows: `auth_profile_state`

Personal accounts added from Profile or `models accounts login` use private
identity-scoped records in the selected Gateway's shared state database:
`model-accounts` owns the selected links, and each
credential has its own `model-account:<profile-id>` record containing its secret
and usage state. Only a selected personal profile is loaded for a run; ordinary
shared-account reads never enumerate these records. Personal OAuth refresh
writes back to that person's account record rather than a shared or agent-local
credential.

Older installations may still contain `auth-profiles.json`, `auth-state.json`,
per-agent `auth.json`, or shared `credentials/oauth.json`. Run
`openclaw doctor --fix` once after upgrading. Doctor imports verified values,
records a migration receipt, and renames the original file to a timestamped
archive.

Runtime never reads these retired files. What happens when one is still present
depends on whether the SQLite store can already serve credentials for that
agent:

- The store holds profiles: the retired file is leftover bytes. Runtime logs a
  one-time warning naming the file and keeps working; Doctor archives it on the
  next `--fix`. Doctor never overwrites a usable stored credential with imported
  values, so the file cannot resurrect a stale token.
- The store is empty: the credentials still live only in that file, so runtime
  fails closed for that agent with `AUTH_PROFILE_MIGRATION_REQUIRED` rather than
  falling through to environment auth. Gateway startup degrades this owner to
  configured-unavailable instead of refusing to start.

The database and migration sources respect `$OPENCLAW_STATE_DIR`. Full reference: [/gateway/config-secrets-env#auth-storage](/gateway/config-secrets-env#auth-storage)

For static secret refs and runtime snapshot activation behavior, see [Secrets Management](/gateway/secrets).

When an agent has no local auth profile, OpenClaw reads the shared auth store;
it does not clone shared credentials into the agent database. OAuth refresh
tokens are especially sensitive: normal copy flows skip them by default
because some providers rotate or invalidate refresh tokens after use.
Configure a separate OAuth login for an agent when it needs an independent
account.

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

OpenClaw's OAuth registry and adapters live in `src/llm/utils/oauth/`. Shared provider helpers live in `src/plugin-sdk/provider-oauth-runtime.ts` and `src/plugin-sdk/provider-auth-runtime.ts`. The auth commands in `src/commands/models/auth.ts` run the selected provider method and persist the returned profiles.

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
- if expired, refresh and save the new credentials back to the owning SQLite
  store
- if an agent reads an OAuth profile from the shared store, the refresh writes
  back to that shared owner instead of copying the refresh token into the
  agent store
- externally managed CLI credentials (Claude CLI, narrow Codex CLI bootstrap;
  see [The token sink](#the-token-sink-why-it-exists)) are re-read instead of
  spending a copied refresh token. If a managed refresh fails, OpenClaw
  reports the affected profile for re-authentication instead of returning
  external CLI token material.

The refresh flow is automatic; you generally do not need to manage tokens manually.

## Multiple accounts (profiles) + routing

Three patterns:

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
- per-session via `/model ...@<profileId> -s`

Example (session override):

- `/model Opus@anthropic:work -s`

### 3) Multi-user: personal accounts

On a shared gateway, each verified person can save several accounts per provider
in **Settings → Profile → Connected accounts** and choose one as their new-chat
default. **Add account** and `openclaw models accounts login` use the same
Gateway-owned provider and sign-in method catalog. Anthropic personal setup
accepts an API key, not a Claude subscription token; system/agent auth remains
a separate flow.
Both sign-in surfaces show the Gateway, verified person, and Personal
scope before requesting provider credentials. Gateway identity and provider
sign-in are separate; a shared Gateway token does not identify a person. See
[personal-account CLI setup](/cli/models#personal-model-accounts).

The model picker in New session or an existing chat can select an
account for that chat without changing the default. Ordered shared accounts
remain same-provider failover candidates; the selection is not a billing
guarantee. Personal credentials stay outside the shared profile list. See
[Per-person model accounts](/concepts/multi-user#per-person-model-accounts).

List your saved personal accounts with:

```bash
openclaw models accounts list
```

For shared or agent-local profile IDs, use:

```bash
openclaw models auth list --provider <id>
```

Related docs:

- [Model failover](/concepts/model-failover) (rotation + cooldown rules)
- [Slash commands](/tools/slash-commands) (command surface)

## Related

- [Authentication](/gateway/authentication) - model provider auth overview
- [Secrets](/gateway/secrets) - credential storage and SecretRef
- [Configuration Reference](/gateway/config-secrets-env#auth-storage) - auth config keys
