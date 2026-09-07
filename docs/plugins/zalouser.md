---
summary: "Zalo Personal plugin: QR login + messaging via native zca-js (plugin install + channel config + tool)"
read_when:
  - You want Zalo Personal (unofficial) support in OpenClaw
  - You are configuring or developing the zalouser plugin
title: "Zalo personal plugin"
---

Zalo Personal support for OpenClaw via a plugin that uses native `zca-js` to
automate a normal Zalo user account. No external `zca`/`openzca` CLI binary is
required.

<Warning>
Unofficial automation may lead to account suspension or ban. Use at your own risk.
</Warning>

## Naming

Channel id is `zalouser` to make it explicit this automates a **personal Zalo
user account** (unofficial). The separate `zalo` channel id is the official,
bundled Zalo Bot/webhook integration - see [Zalo](/channels/zalo).

## Where it runs

This plugin runs **inside the Gateway process**. For a remote Gateway,
install/configure it on that host, then restart the Gateway.

## Install

### From npm

```bash
openclaw plugins install @openclaw/zalouser
```

Use the bare package to follow the current official release tag; pin an exact
version only when you need a reproducible install. Restart the Gateway
afterwards.

### From a local folder (dev)

```bash
PLUGIN_SRC=./path/to/local/zalouser-plugin
openclaw plugins install "$PLUGIN_SRC"
cd "$PLUGIN_SRC" && pnpm install
```

Restart the Gateway afterwards.

## Config

Channel config lives under `channels.zalouser` (not `plugins.entries.*`):

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

See [Zalo personal channel config](/channels/zalouser) for DM/group access
control, multi-account setup, environment variables, and troubleshooting.

## CLI

```bash
openclaw channels login --channel zalouser
openclaw channels login --channel zalouser --account <name>
openclaw channels logout --channel zalouser
openclaw channels status --probe
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "name"
openclaw directory groups members --channel zalouser --group-id <id>
```

## Agent tool

Tool name: `zalouser`

Actions: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`

Channel message actions (not the agent tool) also support `react` for message
reactions.

## Related

- [Zalo personal channel config](/channels/zalouser)
- [Zalo (official Bot/webhook channel)](/channels/zalo)
- [Building plugins](/plugins/building-plugins)
- [ClawHub](/clawhub)
