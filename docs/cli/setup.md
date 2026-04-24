---
summary: "CLI reference for `openclaw setup` (initialize config + workspace)"
read_when:
  - You’re doing first-run setup without full CLI onboarding
  - You want to set the default workspace path
title: "Setup"
---

# `openclaw setup`

Initialize `~/.openclaw/openclaw.json` and the agent workspace.

Related:

- Getting started: [Getting started](/start/getting-started)
- CLI onboarding: [Onboarding (CLI)](/start/wizard)

## Examples

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
openclaw setup --wizard
openclaw setup --non-interactive --mode remote --remote-url wss://gateway-host:18789 --remote-token <token>
```

## Options

- `--workspace <dir>`: agent workspace directory (stored as `agents.defaults.workspace`)
- `--wizard`: run onboarding
- `--non-interactive`: run onboarding without prompts
- `--mode <local|remote>`: onboarding mode
- `--remote-url <url>`: remote Gateway WebSocket URL
- `--remote-token <token>`: remote Gateway token

To run onboarding via setup:

```bash
openclaw setup --wizard
```

Notes:

- Plain `openclaw setup` initializes config + workspace without the full onboarding flow.
- Onboarding auto-runs when any onboarding flags are present (`--wizard`, `--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).

## Related

- [CLI reference](/cli)
- [Install overview](/install)
