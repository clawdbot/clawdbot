---
summary: "How Clawdbot rotates auth profiles and falls back across models"
read_when:
  - Diagnosing auth profile rotation, cooldowns, or model fallback behavior
  - Updating failover rules for auth profiles or models
---

# Model failover

Clawdbot handles failures in two stages:
1) **Auth profile rotation** within the current provider.
2) **Model fallback** to the next model in `agent.model.fallbacks`.

This doc explains the runtime rules and the data that backs them.

## Profile IDs

OAuth logins create distinct profiles so multiple accounts can coexist.
- Default: `provider:default` when no email is available.
- OAuth with email: `provider:<email>` (for example `google-antigravity:user@gmail.com`).

Profiles live in `~/.clawdbot/agent/auth-profiles.json` under `profiles`.

## Rotation order

When a provider has multiple profiles, Clawdbot chooses an order like this:

1) **Explicit config**: `auth.order[provider]` (if set).
2) **Configured profiles**: `auth.profiles` filtered by provider.
3) **Stored profiles**: entries in `auth-profiles.json` for the provider.

If no explicit order is configured, Clawdbot uses a round‑robin order:
- **Primary key:** `usageStats.lastUsed` (oldest first).
- **Secondary key:** profile type (OAuth before API keys).
- **Cooldown profiles** are moved to the end, ordered by soonest cooldown expiry.

## Cooldowns

When a profile fails due to auth/rate‑limit errors (or a timeout that looks
like rate limiting), Clawdbot marks it in cooldown and moves to the next profile.

Cooldowns use exponential backoff:
- 1 minute
- 5 minutes
- 25 minutes
- 1 hour (cap)

State is stored in `auth-profiles.json` under `usageStats`:

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

## Model fallback

If all profiles for a provider fail, Clawdbot moves to the next model in
`agent.model.fallbacks`. This applies to auth failures, rate limits, and
timeouts that exhausted profile rotation.

## Related config

See `docs/configuration.md` for:
- `auth.profiles` / `auth.order`
- `agent.model.primary` / `agent.model.fallbacks`
- `agent.imageModel` routing

See `docs/models.md` for the broader model selection and fallback overview.
