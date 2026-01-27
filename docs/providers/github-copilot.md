---
summary: "Sign in to GitHub Copilot from Moltbot using the device flow"
read_when:
  - You want to use GitHub Copilot as a model provider
  - You need the `moltbot models auth login-github-copilot` flow
---
# Github Copilot

## What is GitHub Copilot?

GitHub Copilot is GitHub's AI coding assistant. It provides access to Copilot
models for your GitHub account and plan. Moltbot can use Copilot as a model
provider in two different ways.

## Two ways to use Copilot in Moltbot

### 1) Built-in GitHub Copilot provider (`github-copilot`)

Use the native device-login flow to obtain a GitHub token, then exchange it for
Copilot API tokens when Moltbot runs. This is the **default** and simplest path
because it does not require VS Code.

### 2) Copilot Proxy plugin (`copilot-proxy`)

Use the **Copilot Proxy** VS Code extension as a local bridge. Moltbot talks to
the proxy’s `/v1` endpoint and uses the model list you configure there. Choose
this when you already run Copilot Proxy in VS Code or need to route through it.
You must enable the plugin and keep the VS Code extension running.

Use GitHub Copilot as a model provider (`github-copilot`). The login command runs
the GitHub device flow, saves an auth profile, and updates your config to use that
profile.

## CLI setup

```bash
moltbot models auth login-github-copilot
```

You'll be prompted to visit a URL and enter a one-time code. Keep the terminal
open until it completes.

### Optional flags

```bash
moltbot models auth login-github-copilot --profile-id github-copilot:work
moltbot models auth login-github-copilot --yes
```

## Set a default model

```bash
moltbot models set github-copilot/gpt-4o
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
  Copilot API token when Moltbot runs.
