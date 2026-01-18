---
summary: "Sign in to GitHub Copilot from Clawdbot using the device flow"
read_when:
  - You want to use GitHub Copilot as a model provider
  - You need the `clawdbot models auth login-github-copilot` flow
---
# Github Copilot

Use GitHub Copilot as a model provider (`github-copilot`). The login command runs
the GitHub device flow, saves an auth profile, and updates your config to use that
profile.

## CLI setup

```bash
clawdbot models auth login-github-copilot
```

You'll be prompted to visit a URL and enter a one-time code. Keep the terminal
open until it completes.

### Optional flags

```bash
clawdbot models auth login-github-copilot --profile-id github-copilot:work
clawdbot models auth login-github-copilot --yes
```

## Set a default model

```bash
clawdbot models set github-copilot/gpt-4o
```

### Config snippet

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } }
}
```

## Notes

- Requires an interactive TTY; run it directly in a terminal.
- Copilot model availability depends on your plan; if a model is rejected, try
  another ID (for example `github-copilot/gpt-4.1`).
- The login stores a GitHub token in the auth profile store and exchanges it for a
  Copilot API token when Clawdbot runs.
