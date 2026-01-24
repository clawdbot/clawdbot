---
summary: "Troubleshooting hub: symptoms → checks → fixes"
read_when:
  - You see an error and want the fix path
  - The installer says “success” but the CLI doesn’t work
---

# Troubleshooting

## First 60 seconds

Run these in order:

```bash
clawdbot status
clawdbot status --all
clawdbot gateway probe
clawdbot logs --follow
clawdbot doctor
```

If the gateway is reachable, deep probes:

```bash
clawdbot status --deep
```

## Common “it broke” cases

### `clawdbot: command not found`

Almost always a Node/npm PATH issue. Start here:

- [Install (Node/npm PATH sanity)](/install#nodejs--npm-path-sanity)

### Gateway “unauthorized”, can’t connect, or keeps reconnecting

- [Gateway troubleshooting](/gateway/troubleshooting)
- [Gateway authentication](/gateway/authentication)

### Control UI fails on HTTP (device identity required)

- [Gateway troubleshooting](/gateway/troubleshooting)
- [Control UI](/web/control-ui#insecure-http)

### `docs.clawd.bot` shows an SSL error (Comcast/Xfinity)

Some Comcast/Xfinity connections block `docs.clawd.bot` via Xfinity Advanced Security.
Disable Advanced Security or add `docs.clawd.bot` to the allowlist, then retry.

- Xfinity Advanced Security help: https://www.xfinity.com/support/articles/using-xfinity-xfi-advanced-security
- Quick sanity checks: try a mobile hotspot or VPN to confirm it’s ISP-level filtering

### Service says running, but RPC probe fails

- [Gateway troubleshooting](/gateway/troubleshooting)
- [Background process / service](/gateway/background-process)

### Model/auth failures (rate limit, billing, “all models failed”)

- [Models](/cli/models)
- [OAuth / auth concepts](/concepts/oauth)

### `/model` says `model not allowed`

This usually means `agents.defaults.models` is configured as an allowlist. When it’s non-empty,
only those provider/model keys can be selected.

- Check the allowlist: `clawdbot config get agents.defaults.models`
- Add the model you want (or clear the allowlist) and retry `/model`
- Use `/models` to browse the allowed providers/models

### When filing an issue

Paste a safe report:

```bash
clawdbot status --all
```

If you can, include the relevant log tail from `clawdbot logs --follow`.
