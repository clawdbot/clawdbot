# Google Gemini CLI Auth (Clawdbot plugin)

OAuth provider plugin for **Gemini CLI** (Google Code Assist).

## Enable

Bundled plugins are disabled by default. Enable this one:

```bash
clawdbot plugins enable google-gemini-cli-auth
```

Restart the Gateway after enabling.

## Authenticate

```bash
clawdbot models auth login --provider google-gemini-cli --set-default
```

## Requirements

Requires the Gemini CLI to be installed (credentials are extracted automatically):

```bash
brew install gemini-cli
# or: npm install -g @google/gemini-cli
```

## Env vars (optional)

Override auto-detected credentials with:

- `CLAWDBOT_GEMINI_OAUTH_CLIENT_ID` / `GEMINI_CLI_OAUTH_CLIENT_ID`
- `CLAWDBOT_GEMINI_OAUTH_CLIENT_SECRET` / `GEMINI_CLI_OAUTH_CLIENT_SECRET`
