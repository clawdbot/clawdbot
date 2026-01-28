---
summary: "Use GitHub Copilot CLI as a text-only fallback backend"
read_when:
  - You want to use GitHub Copilot CLI as a model provider
  - You need a fallback when API providers fail
  - You already have GitHub Copilot CLI installed
---
# GitHub Copilot CLI

GitHub Copilot CLI (`copilot`) is GitHub's terminal-based AI assistant. Moltbot can use it as a
**CLI backend** for text-only fallback when API providers are unavailable.

## Prerequisites

- **GitHub Copilot subscription** (Individual, Business, or Enterprise)
- **Node.js 22+**
- **GitHub CLI** (`gh`) authenticated with your GitHub account

## Installation

Install the Copilot CLI via npm:

```bash
npm install -g @github/copilot
```

Or via Homebrew:

```bash
brew install github/copilot/copilot
```

Or use the `gh copilot` extension:

```bash
gh extension install github/gh-copilot
```

Verify installation:

```bash
copilot --help
# or
gh copilot --help
```

## Quick start

Use Copilot CLI directly with Moltbot:

```bash
moltbot agent --message "hi" --model copilot-cli/gpt-4o
```

## Configuration

### Minimal config (custom command path)

If your gateway runs under launchd/systemd with a minimal PATH, specify the full path:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "copilot-cli": {
          command: "/opt/homebrew/bin/copilot"
        }
      }
    }
  }
}
```

### Using as a fallback

Add `copilot-cli` to your fallback list so it only runs when primary models fail:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "github-copilot/gpt-4o",
        fallbacks: [
          "copilot-cli/gpt-4o"
        ]
      },
      models: {
        "github-copilot/gpt-4o": { alias: "Copilot" },
        "copilot-cli/gpt-4o": {}
      }
    }
  }
}
```

## Supported models

Copilot CLI supports these models (availability depends on your plan):

- `gpt-4o`
- `gpt-4.1`
- `gpt-4.1-mini`
- `gpt-4-turbo`
- `claude-sonnet-4-5`
- `claude-opus-4-5`

Example model refs:

```
copilot-cli/gpt-4o
copilot-cli/gpt-4.1
copilot-cli/claude-sonnet-4-5
```

## Authentication

Copilot CLI uses GitHub CLI authentication. Ensure you're logged in:

```bash
gh auth status
```

If not logged in:

```bash
gh auth login
```

## Limitations

- **Text output only**: Copilot CLI does not support JSON output, so responses are plain text.
- **Tools disabled**: CLI backends never receive tool calls. The CLI may still run its own agent tooling internally.
- **No streaming**: CLI output is collected then returned.
- **Session resume**: Uses `--resume` flag with session ID when available.

## Differences from the API provider

| Aspect | `github-copilot` (API) | `copilot-cli` (CLI backend) |
|--------|------------------------|----------------------------|
| Output format | JSON (structured) | Text only |
| Tools | Moltbot tools work | Tools disabled |
| Streaming | Supported | Not supported |
| Auth | Device flow / token exchange | GitHub CLI (`gh auth`) |

Choose the API provider (`github-copilot`) for full functionality. Use `copilot-cli` as a
fallback when you want "always works" text responses.

## Troubleshooting

### CLI not found

Set the full command path in your config:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "copilot-cli": {
          command: "/usr/local/bin/copilot"
        }
      }
    }
  }
}
```

### Authentication errors

Re-authenticate with GitHub CLI:

```bash
gh auth login
gh auth status
```

### Model not available

Model availability depends on your GitHub Copilot plan. Try a different model:

```bash
moltbot agent --message "hi" --model copilot-cli/gpt-4.1
```

## See also

- [GitHub Copilot (API provider)](/providers/github-copilot)
- [CLI backends](/gateway/cli-backends)
- [Configuration](/gateway/configuration)
