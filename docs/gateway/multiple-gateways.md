---
summary: "Run multiple Clawdbot Gateways on one host (isolation, ports, and profiles)"
read_when:
  - Running more than one Gateway on the same machine
  - You need isolated config/state/ports per Gateway
---
# Multiple Gateways (same host)

Most setups should use one Gateway because a single Gateway can handle multiple messaging connections and agents. If you need stronger isolation or redundancy, run separate Gateways. Both are supported.

## Isolation checklist (required)
- `CLAWDBOT_CONFIG_PATH` — per-instance config file
- `CLAWDBOT_STATE_DIR` — per-instance sessions, creds, caches
- `agents.defaults.workspace` — per-instance workspace root
- `gateway.port` (or `--port`) — unique per instance
- Derived ports (bridge/browser/canvas) must not overlap

If these are shared, you will hit config races and port conflicts.

## Recommended: profiles (`--profile`)

Profiles auto-scope `CLAWDBOT_STATE_DIR` + `CLAWDBOT_CONFIG_PATH` and suffix service names.

```bash
# main
clawdbot --profile main setup
clawdbot --profile main gateway --port 18789

# rescue
clawdbot --profile rescue setup
clawdbot --profile rescue gateway --port 19001
```

Per-profile daemons:
```bash
clawdbot --profile main daemon install
clawdbot --profile rescue daemon install
```

## Port mapping (derived)

Base port = `gateway.port` (or `CLAWDBOT_GATEWAY_PORT` / `--port`).

- `bridge.port = base + 1`
- `browser.controlUrl port = base + 2`
- `canvasHost.port = base + 4`
- Browser profile CDP ports auto-allocate from `browser.controlPort + 9 .. + 108`

If you override any of these in config or env, you must keep them unique per instance.

## Browser/CDP notes (common footgun)

- Do **not** pin `browser.controlUrl` or `browser.cdpUrl` to the same values on multiple instances.
- Each instance needs its own browser control port and CDP range.
- If you need explicit CDP ports, set `browser.profiles.<name>.cdpPort` per instance.
- Remote Chrome: use `browser.profiles.<name>.cdpUrl` (per profile, per instance).

## Manual env example

```bash
CLAWDBOT_CONFIG_PATH=~/.clawdbot/main.json \
CLAWDBOT_STATE_DIR=~/.clawdbot-main \
clawdbot gateway --port 18789

CLAWDBOT_CONFIG_PATH=~/.clawdbot/rescue.json \
CLAWDBOT_STATE_DIR=~/.clawdbot-rescue \
clawdbot gateway --port 19001
```

## Quick checks

```bash
clawdbot --profile main status
clawdbot --profile rescue status
clawdbot --profile rescue browser status
```
