# @openclaw/imessage

Official iMessage channel plugin for OpenClaw, using `imsg` on a signed-in Mac.

The plugin supports iMessage and SMS DMs and groups, media, replies, tapbacks,
effects, polls, and group management when the `imsg` private API bridge is
available.

## Install

```bash
openclaw plugins install @openclaw/imessage
```

Restart the Gateway after installing or updating the plugin.

## Configure

Follow the iMessage guide for installing `imsg`, granting macOS permissions,
enabling private API actions, and configuring local or remote-Mac operation:

- https://docs.openclaw.ai/channels/imessage

## Package

- Plugin id: `imessage`
- Channel id: `imessage`
- Package: `@openclaw/imessage`
- Minimum OpenClaw host: `2026.7.2`
