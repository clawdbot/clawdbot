---
summary: "Use Anthropic Claude via API keys or Claude Code CLI auth in Clawdbot"
read_when:
  - You want to use Anthropic models in Clawdbot
  - You want setup-token or Claude Code CLI auth instead of API keys
---
# Anthropic (Claude)

Anthropic builds the **Claude** model family and provides access via an API.
In Clawdbot you can authenticate with an API key or reuse **Claude Code CLI** credentials
(setup-token or OAuth).

## Option A: Anthropic API key

**Best for:** standard API access and usage-based billing.
Create your API key in the Anthropic Console.

### CLI setup

```bash
clawdbot onboard
# choose: Anthropic API key

# or non-interactive
clawdbot onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Config snippet

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } }
}
```

## Prompt caching (Anthropic API)

Clawdbot does **not** override Anthropic’s default cache TTL unless you set it.
This is **API-only**; Claude Code CLI OAuth ignores TTL settings.

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

Clawdbot includes the `extended-cache-ttl-2025-04-11` beta flag for Anthropic API
requests; keep it if you override provider headers (see [/gateway/configuration](/gateway/configuration)).

## Option B: Claude Code CLI (setup-token or OAuth)

**Best for:** using your Claude subscription or existing Claude Code CLI login.

### Where to get a setup-token

Setup-tokens are created by the **Claude Code CLI**, not the Anthropic Console. You can run this on **any machine**:

```bash
claude setup-token
```

Paste the token into Clawdbot (wizard: **Anthropic token (paste setup-token)**), or run it on the gateway host:

```bash
clawdbot models auth setup-token --provider anthropic
```

If you generated the token on a different machine, paste it:

```bash
clawdbot models auth paste-token --provider anthropic
```

### CLI setup

```bash
# Reuse Claude Code CLI OAuth credentials if already logged in
clawdbot onboard --auth-choice claude-cli
```

### Config snippet

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } }
}
```

## Notes

- Generate the setup-token with `claude setup-token` and paste it, or run `clawdbot models auth setup-token` on the gateway host.
- If you see “OAuth token refresh failed …” on a Claude subscription, re-auth with a setup-token or resync Claude Code CLI OAuth on the gateway host. See [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- Clawdbot writes `auth.profiles["anthropic:claude-cli"].mode` as `"oauth"` so the profile
  accepts both OAuth and setup-token credentials. Older configs using `"token"` are
  auto-migrated on load.
- Auth details + reuse rules are in [/concepts/oauth](/concepts/oauth).
