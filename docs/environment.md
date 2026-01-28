---
summary: "Where Moltbot loads environment variables and the precedence order"
read_when:
  - You need to know which env vars are loaded, and in what order
  - You are debugging missing API keys in the Gateway
  - You are documenting provider auth or deployment environments
---
# Environment variables

Moltbot pulls environment variables from multiple sources. The rule is **never override existing values**.

## Precedence (highest → lowest)

1) **Process environment** (what the Gateway process already has from the parent shell/daemon).
2) **`.env` in the current working directory** (dotenv default; does not override).
3) **Global `.env`** at `~/.clawdbot/.env` (aka `$CLAWDBOT_STATE_DIR/.env`; does not override).
4) **Config `env` block** in `~/.clawdbot/moltbot.json` (applied only if missing).
5) **Optional login-shell import** (`env.shellEnv.enabled` or `CLAWDBOT_LOAD_SHELL_ENV=1`), applied only for missing expected keys.

If the config file is missing entirely, step 4 is skipped; shell import still runs if enabled.

## Config `env` block

Two equivalent ways to set inline env vars (both are non-overriding):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-..."
    }
  }
}
```

## Shell env import

`env.shellEnv` runs your login shell and imports only **missing** expected keys:

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000
    }
  }
}
```

Env var equivalents:
- `CLAWDBOT_LOAD_SHELL_ENV=1`
- `CLAWDBOT_SHELL_ENV_TIMEOUT_MS=15000`

## Env var substitution in config

You can reference env vars directly in config string values using `${VAR_NAME}` syntax:

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}"
      }
    }
  }
}
```

See [Configuration: Env var substitution](/gateway/configuration#env-var-substitution-in-config) for full details.

## Related

- [Gateway configuration](/gateway/configuration)
- [FAQ: env vars and .env loading](/help/faq#env-vars-and-env-loading)
- [Models overview](/concepts/models)
