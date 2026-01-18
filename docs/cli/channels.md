---
summary: "CLI reference for `clawdbot channels` (accounts, status, login/logout, logs)"
read_when:
  - You want to add/remove channel accounts (WhatsApp/Telegram/Discord/Slack/Signal/iMessage)
  - You want to check channel status or tail channel logs
---

# `clawdbot channels`

Manage chat channel accounts and their runtime status on the Gateway.

Related docs:
- Channel guides: [Channels](/channels/index)
- Gateway configuration: [Configuration](/gateway/configuration)

## Common commands

```bash
clawdbot channels list
clawdbot channels status
clawdbot channels capabilities
clawdbot channels capabilities --channel discord --target channel:123
clawdbot channels resolve --channel slack "#general" "@jane"
clawdbot channels logs --channel all
```

## Add / remove accounts

```bash
clawdbot channels add --channel telegram --token <bot-token>
clawdbot channels remove --channel telegram --delete
```

Tip: `clawdbot channels add --help` shows per-channel flags (token, app token, signal-cli paths, etc).

## Login / logout (interactive)

```bash
clawdbot channels login --channel whatsapp
clawdbot channels logout --channel whatsapp
```

## Troubleshooting

- Run `clawdbot status --deep` for a broad probe.
- Use `clawdbot doctor` for guided fixes.

## Capabilities probe

Fetch provider capability hints (intents/scopes where available) plus static feature support:

```bash
clawdbot channels capabilities
clawdbot channels capabilities --channel discord --target channel:123
```

Notes:
- `--channel` is optional; omit it to list every channel (including extensions).
- `--target` accepts `channel:<id>` or a raw numeric channel id and only applies to Discord.
- Probes are provider-specific: Discord intents + optional channel permissions; Slack bot + user scopes; Telegram bot flags + webhook; Signal daemon version; MS Teams app token + Graph roles/scopes (annotated where known). Channels without probes report `Probe: unavailable`.

## Resolve names to IDs

Resolve channel/user names to IDs using the provider directory:

```bash
clawdbot channels resolve --channel slack "#general" "@jane"
clawdbot channels resolve --channel discord "My Server/#support" "@someone"
clawdbot channels resolve --channel matrix "Project Room"
```

Notes:
- Use `--kind user|group|auto` to force the target type.
- Resolution prefers active matches when multiple entries share the same name.
