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

## Option B: Claude Code CLI (setup-token or OAuth)

**Best for:** using your Claude subscription or existing Claude Code CLI login.

### CLI setup

```bash
# Run setup-token on the gateway host (wizard can run it for you)
clawdbot onboard --auth-choice setup-token

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

- The wizard can run `claude setup-token` on the gateway host and store the token.
- Clawdbot writes `auth.profiles["anthropic:claude-cli"].mode` as `"oauth"` so the profile
  accepts both OAuth and setup-token credentials. Older configs using `"token"` are
  auto-migrated on load.
- Auth details + reuse rules are in [/concepts/oauth](/concepts/oauth).
