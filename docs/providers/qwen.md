---
summary: "Use Qwen OAuth (free tier) in Clawdbot"
read_when:
  - You want to use Qwen with Clawdbot
  - You want free-tier OAuth access to Qwen Coder
---
# Qwen

Qwen provides a free-tier OAuth flow for Qwen Coder and Qwen Vision models
(2,000 requests/day, subject to Qwen rate limits).

## Enable the plugin

```bash
clawdbot plugins enable qwen-portal-auth
```

Restart the Gateway after enabling.

## Authenticate

```bash
clawdbot models auth login --provider qwen-portal --set-default
```

This runs the Qwen device-code OAuth flow and writes a provider entry to your
`models.json` (plus a `qwen` alias for quick switching).

## Model IDs

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Switch models with:

```bash
clawdbot models set qwen-portal/coder-model
```

## Reuse Qwen Code CLI login

If you already logged in with the Qwen Code CLI, Clawdbot will sync credentials
from `~/.qwen/oauth_creds.json` when it loads the auth store. You still need a
`models.providers.qwen-portal` entry (use the login command above to create one).

## Notes

- Tokens auto-refresh; re-run the login command if refresh fails or access is revoked.
- Default base URL: `https://portal.qwen.ai/v1` (override with
  `models.providers.qwen-portal.baseUrl` if Qwen provides a different endpoint).
- See [Model providers](/concepts/model-providers) for provider-wide rules.
