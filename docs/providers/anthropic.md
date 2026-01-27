---
summary: "Use Anthropic Claude via API keys or setup-token in Moltbot"
read_when:
  - You want to use Anthropic models in Moltbot
  - You want setup-token instead of API keys
---
# Anthropic (Claude)

Anthropic builds the **Claude** model family and provides access via an API.
In Moltbot you can authenticate with an API key or a **setup-token**.

## Option A: Anthropic API key

**Best for:** standard API access and usage-based billing.
Create your API key in the Anthropic Console.

### CLI setup

```bash
moltbot onboard
# choose: Anthropic API key

# or non-interactive
moltbot onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Config snippet

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } }
}
```

## Prompt caching (Anthropic API)

Moltbot does **not** override Anthropic’s default cache TTL unless you set it.
This is **API-only**; subscription auth does not honor TTL settings.

To set the TTL per model, use `cacheControlTtl` in the model `params`:

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-5": {
          params: { cacheControlTtl: "5m" } // or "1h"
        }
      }
    }
  }
}
```

Moltbot includes the `extended-cache-ttl-2025-04-11` beta flag for Anthropic API
requests; keep it if you override provider headers (see [/gateway/configuration](/gateway/configuration)).

## Option B: Claude setup-token

**Best for:** using your Claude subscription.

### Where to get a setup-token

Setup-tokens are created by the **Claude Code CLI**, not the Anthropic Console. You can run this on **any machine**:

```bash
claude setup-token
```

Paste the token into Moltbot (wizard: **Anthropic token (paste setup-token)**), or run it on the gateway host:

```bash
moltbot models auth setup-token --provider anthropic
```

If you generated the token on a different machine, paste it:

```bash
moltbot models auth paste-token --provider anthropic
```

### CLI setup

```bash
# Paste a setup-token during onboarding
moltbot onboard --auth-choice setup-token
```

### Config snippet

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } }
}
```

## Notes

- Generate the setup-token with `claude setup-token` and paste it, or run `moltbot models auth setup-token` on the gateway host.
- If you see “OAuth token refresh failed …” on a Claude subscription, re-auth with a setup-token. See [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- Auth details + reuse rules are in [/concepts/oauth](/concepts/oauth).

## Troubleshooting

**401 errors / token suddenly invalid**
- Claude subscription auth can expire or be revoked. Re-run `claude setup-token`
  and paste it into the **gateway host**.
- If the Claude CLI login lives on a different machine, use
  `moltbot models auth paste-token --provider anthropic` on the gateway host.

**No API key found for provider "anthropic"**
- Auth is **per agent**. New agents don’t inherit the main agent’s keys.
- Re-run onboarding for that agent, or paste a setup-token / API key on the
  gateway host, then verify with `moltbot models status`.

**No credentials found for profile `anthropic:default`**
- Run `moltbot models status` to see which auth profile is active.
- Re-run onboarding, or paste a setup-token / API key for that profile.

**No available auth profile (all in cooldown/unavailable)**
- Check `moltbot models status --json` for `auth.unusableProfiles`.
- Add another Anthropic profile or wait for cooldown.

More: [/gateway/troubleshooting](/gateway/troubleshooting) and [/help/faq](/help/faq).
