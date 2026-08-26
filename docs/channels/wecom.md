---
summary: "Install the official WeCom plugin and find its versioned setup documentation"
read_when:
  - You want to connect OpenClaw to WeCom
  - You need the supported WeCom plugin and its setup documentation
title: "WeCom"
---

OpenClaw exposes WeCom through the external
`@wecom/wecom-openclaw-plugin` package maintained by the Tencent WeCom team.
The plugin is listed in OpenClaw's official channel catalog but is not bundled
with the core install.

## Install

```bash
openclaw channels add --channel wecom
openclaw gateway restart
openclaw channels status --channel wecom
```

The OpenClaw catalog installs an exact version of
`@wecom/wecom-openclaw-plugin`.

## Configure

WeCom credentials, connection modes, callback routes, and access-control
behavior belong to the external plugin and can change independently of
OpenClaw. Follow the
[package documentation](https://www.npmjs.com/package/@wecom/wecom-openclaw-plugin)
for the installed release before configuring the channel.

When upgrading the plugin independently, keep using the documentation for the
installed version.
