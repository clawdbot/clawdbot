---
summary: "Run multiple OpenClaw Gateways on one host (isolation, ports, and profiles)"
read_when:
  - Running more than one Gateway on the same machine
  - You need isolated config/state/ports per Gateway
title: "Multiple gateways"
---

Most setups need one Gateway - a single Gateway handles multiple messaging connections and agents. Run separate Gateways with isolated profiles/ports only when you need stronger isolation or redundancy (e.g., a rescue bot).

## Rescue-bot quickstart

The simplest rescue-bot setup:

- Keep the main bot on the default profile.
- Run the rescue bot on `--profile rescue`, with its own Telegram bot token.
- Put the rescue bot on a different base port, e.g. `19789`.

This keeps the rescue bot able to debug or apply config changes if the primary bot is down. Leave at least 20 ports between base ports so derived browser/CDP ports never collide.

```bash
# Rescue bot (separate Telegram bot, separate profile, port 19789)
openclaw --profile rescue onboard
openclaw --profile rescue gateway install --port 19789
```

If your main bot is already running, that's usually all you need. If onboarding already installed the rescue service, skip the final `gateway install`.

During `openclaw --profile rescue onboard`:

- Use a separate Telegram bot token, dedicated to the rescue account (easy to keep operator-only, independent from the main bot's channel/app install, and a simple DM-based recovery path).
- Keep the `rescue` profile name.
- Use a base port at least 20 higher than the main bot.
- Accept the default rescue workspace unless you already manage one yourself.

### What `--profile rescue onboard` changes

`--profile rescue onboard` runs the normal onboarding flow but writes everything into a separate profile, so the rescue bot gets its own:

- Profile/config file
- State directory
- Workspace (default: `~/.openclaw/workspace-rescue`)
- Managed service name
- Base port (plus derived ports)
- Telegram bot token

Prompts are otherwise identical to normal onboarding.

## General multi-gateway setup

The same isolation pattern works for any pair or group of Gateways on one host - give each extra Gateway its own named profile and base port:

```bash
# main (default profile)
openclaw setup
openclaw gateway --port 18789

# extra gateway
openclaw --profile ops setup
openclaw --profile ops gateway --port 19789
```

Named profiles on both sides also work:

```bash
openclaw --profile main setup
openclaw --profile main gateway --port 18789

openclaw --profile ops setup
openclaw --profile ops gateway --port 19789
```

Services follow the same pattern:

```bash
openclaw gateway install
openclaw --profile ops gateway install --port 19789
```

Use the rescue-bot quickstart for a fallback operator lane; use the general profile pattern for multiple long-lived Gateways across different channels, tenants, workspaces, or operational roles.

## Isolation checklist

Keep these unique per Gateway instance:

| Setting                      | Purpose                              |
| ---------------------------- | ------------------------------------ |
| `OPENCLAW_CONFIG_PATH`       | Per-instance config file             |
| `OPENCLAW_STATE_DIR`         | Per-instance sessions, creds, caches |
| `agents.defaults.workspace`  | Per-instance workspace root          |
| `gateway.port` (or `--port`) | Unique per instance                  |
| Derived browser/CDP ports    | See below                            |

Sharing any of these causes config, state, or port conflicts. Gateway startup
enforces unique state-directory ownership even when
`OPENCLAW_ALLOW_MULTI_GATEWAY=1` skips the per-config singleton.

## Port mapping (derived)

Base port = `gateway.port` (or `OPENCLAW_GATEWAY_PORT` / `--port`).

- Browser control service port = base + 2 (loopback only).
- Canvas host is served on the Gateway HTTP server itself (same port as `gateway.port`).
- Browser profile CDP ports auto-allocate from `browser control port + 9` through `+ 108`.

Override any of these in config or env and you must keep them unique per instance.

## Browser/CDP notes (common footgun)

- Do **not** pin `browser.cdpUrl` to the same value on multiple instances.
- Each instance needs its own browser control port and CDP range (derived from its gateway port).
- For explicit CDP ports, set `browser.profiles.<name>.cdpPort` per instance.
- For remote Chrome, use `browser.profiles.<name>.cdpUrl` (per profile, per instance).

## Manual env example

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19789
```

## Quick checks

```bash
openclaw gateway status --deep
openclaw --profile rescue gateway status --deep
openclaw --profile rescue gateway probe
openclaw status
openclaw --profile rescue status
openclaw --profile rescue browser status
```

- `gateway status --deep` catches stale launchd/systemd/schtasks services from older installs.
- `gateway probe` warning text such as `multiple reachable gateway identities detected` is expected only when you intentionally run more than one isolated gateway, or when OpenClaw cannot prove reachable probe targets are the same gateway. An SSH tunnel, proxy URL, or configured remote URL to the same gateway is one gateway with multiple transports, even when transport ports differ.

## Related

- [Gateway runbook](/gateway)
- [Gateway lock](/gateway/gateway-lock)
- [Configuration](/gateway/configuration)
