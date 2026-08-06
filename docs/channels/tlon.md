---
summary: "Tlon/Urbit support status, capabilities, and configuration"
read_when:
  - Working on Tlon/Urbit channel features
title: "Tlon"
---

Tlon is a decentralized messenger built on Urbit. OpenClaw connects to your Urbit ship and
responds to DMs and group chat messages. Group replies require an @ mention by default, with
authorization rules and an owner-approval flow layered on top.

Status: bundled plugin. DMs, group mentions, threads, rich text, image upload/download, and an
owner approval system are supported. Reactions and polls are not.

## Bundled plugin

Tlon ships bundled in current OpenClaw releases; packaged builds do not need a separate install.

On an older build or custom install that excludes it, install from npm:

```bash
openclaw plugins install @openclaw/tlon
```

Use the bare package name to track the current release tag. Pin a version (`@openclaw/tlon@x.y.z`)
only for reproducible installs.

From a local checkout:

```bash
openclaw plugins install ./path/to/local/tlon-plugin
```

Details: [Plugins](/tools/plugin)

## Setup

```bash
openclaw channels add --channel tlon --ship ~sampel-palnet --url https://your-ship-host --code lidlut-tabwed-pillex-ridrup
```

Or edit config directly:

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
      ownerShip: "~your-main-ship", // recommended: your ship, always authorized
    },
  },
}
```

Restart the gateway after editing config directly. Then DM the bot or @ mention it in a group
channel.

## Inbound durability

OpenClaw persists accepted Tlon DM and group-chat events before agent dispatch. Pending or retryable turns survive a Gateway restart, and work remains serialized per group channel or direct peer. Stable Urbit message IDs also suppress a redelivered event while its queue record or retained completion record exists.

Delivery is at least once across the queue-to-agent boundary: a crash during handoff can replay a turn. Agent actions that produce external side effects should therefore remain idempotent where practical.

## Private/LAN ships

OpenClaw blocks private/internal hostnames and IP ranges for SSRF protection by default. If your
ship runs on a private network (localhost, LAN IP, internal hostname), opt in explicitly:

```json5
{
  channels: {
    tlon: {
      url: "http://localhost:8080",
      network: {
        dangerouslyAllowPrivateNetwork: true,
      },
    },
  },
}
```

Applies to targets like `http://localhost:8080`, `http://192.168.x.x:8080`, and
`http://my-ship.local:8080`. Only enable this for a ship URL you trust; it disables SSRF
protection for that account's HTTP requests.

<Note>
`channels.tlon.allowPrivateNetwork` (flat key) is retired. `openclaw doctor --fix` moves it to
`channels.tlon.network.dangerouslyAllowPrivateNetwork` automatically.
</Note>

## Group channels

Pin channels manually, or turn on auto-discovery:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
      autoDiscoverChannels: true,
    },
  },
}
```

`autoDiscoverChannels` defaults to `false` when unset in config; the setup wizard defaults the
prompt to yes and writes `true` explicitly. With it on, OpenClaw scries joined groups on startup,
watches new channels as group invites are accepted, and rechecks every 2 minutes.

## Access control

DM allowlist (empty = no DMs allowed unless the sender is `ownerShip`):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

Group authorization defaults to `restricted` per channel. Set `defaultAuthorizedShips` for a
baseline, and override per channel nest:

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

Once the bot has replied inside a thread, it keeps responding to later messages in that thread
without requiring another mention.

Set `channels.tlon.implicitMentions.threadParticipation: false` to require a new explicit mention
for those follow-ups. Account overrides use `channels.tlon.accounts.<id>.implicitMentions`. Tlon
does not currently produce `replyToBot` or `quotedBot` facts, so those flags have no effect here.

## Owner and approval system

```json5
{
  channels: {
    tlon: {
      ownerShip: "~your-main-ship",
    },
  },
}
```

The owner ship is authorized everywhere: DM invites are always auto-accepted, group invites are
always auto-accepted, and channel messages always pass authorization. The owner does not need to
be in `dmAllowlist`, `defaultAuthorizedShips`, or `groupInviteAllowlist`.

When `ownerShip` is set, unauthorized requests do not just get dropped — they queue a pending
approval and DM the owner:

- DM requests from ships not on `dmAllowlist`
- Mentions in channels where the sender fails authorization
- Group invites from ships not on `groupInviteAllowlist` (when auto-accept is off, or on but the
  inviter is not allowlisted)

The owner replies in DM to act on a request:

| Owner reply                  | Effect                                               |
| ---------------------------- | ---------------------------------------------------- |
| `approve` / `deny` / `block` | Acts on the most recent pending approval             |
| `approve <id>` / `deny <id>` | Acts on a specific approval by id                    |
| `block`                      | Also blocks the ship natively so it cannot reconnect |
| `unblock ~ship`              | Reverses a native block                              |
| `blocked`                    | Lists currently blocked ships                        |
| `pending`                    | Lists pending approval requests                      |

Without `ownerShip` configured, unauthorized DMs and channel mentions are just dropped and logged;
there is no approval prompt.

## Auto-accept settings

Auto-accept DM invites from ships already on `dmAllowlist` (the owner is always auto-accepted
regardless of this flag):

```json5
{
  channels: {
    tlon: {
      autoAcceptDmInvites: true,
    },
  },
}
```

Auto-accept group invites from an allowlist (fails closed: with `autoAcceptGroupInvites: true` and
an empty `groupInviteAllowlist`, no non-owner invite is accepted):

```json5
{
  channels: {
    tlon: {
      autoAcceptGroupInvites: true,
      groupInviteAllowlist: ["~zod"],
    },
  },
}
```

## Hot-reload via Urbit settings store

Most of the settings above (`dmAllowlist`, `groupInviteAllowlist`, `groupChannels`,
`defaultAuthorizedShips`, `autoDiscoverChannels`, `autoAcceptDmInvites`,
`autoAcceptGroupInvites`, `ownerShip`, `showModelSignature`) are mirrored into the ship's
`%settings` agent (desk `moltbot`, bucket `tlon`) on first run and then read live from there,
so changes made via a Landscape client or the bundled skill's settings commands apply without a
gateway restart. `channelRules` and pending approvals are also persisted there as JSON. File
config stays the source of truth for values never written to the settings store.

## Delivery targets (CLI/cron)

Use with `openclaw message send` or cron delivery:

- DM: `~sampel-palnet` or `dm/~sampel-palnet`
- Group: `chat/~host-ship/channel` or `group:~host-ship/channel`

## Bundled skill

The plugin bundles [`@tloncorp/tlon-skill`](https://github.com/tloncorp/tlon-skill), a CLI for
direct Urbit operations, available automatically once the plugin is installed:

- **Activity**: mentions, replies, unreads
- **Channels**: list, create, rename
- **Contacts**: list/get/update profiles
- **Groups**: create, join, invite/request flows, roles
- **Hooks**: manage channel hooks
- **Messages**: history, search
- **DMs**: send, react, accept/decline
- **Posts**: react, delete
- **Notebook**: post to diary channels
- **Settings**: hot-reload plugin config via the settings store above

## Capabilities

| Feature         | Status                                        |
| --------------- | --------------------------------------------- |
| Direct messages | Supported                                     |
| Groups/channels | Supported (mention-gated by default)          |
| Threads         | Supported (keeps replying once it has joined) |
| Rich text       | Markdown converted to Tlon's native format    |
| Images          | Downloaded inbound, uploaded outbound         |
| Reactions       | Only via the [bundled skill](#bundled-skill)  |
| Polls           | Not supported                                 |
| Native commands | Owner-only by default                         |

## Troubleshooting

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
```

Common failures:

- **DMs ignored**: sender not in `dmAllowlist` and no `ownerShip` configured for the approval flow.
- **Group messages ignored**: channel not discovered/pinned, or sender fails authorization with no
  `ownerShip` to queue an approval.
- **Connection errors**: check the ship URL is reachable; set
  `network.dangerouslyAllowPrivateNetwork` for local ships.
- **Auth errors**: login codes rotate — copy the current code from your ship.

## Configuration reference

Full configuration: [Configuration](/gateway/configuration)

| Key                                                    | Meaning                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `channels.tlon.enabled`                                | Enable/disable channel startup.                                |
| `channels.tlon.ship`                                   | Bot's Urbit ship name (e.g. `~sampel-palnet`).                 |
| `channels.tlon.url`                                    | Ship URL (e.g. `https://sampel-palnet.tlon.network`).          |
| `channels.tlon.code`                                   | Ship login code.                                               |
| `channels.tlon.network.dangerouslyAllowPrivateNetwork` | Allow localhost/LAN ship URLs (SSRF opt-in).                   |
| `channels.tlon.ownerShip`                              | Owner ship: always authorized, receives approval requests.     |
| `channels.tlon.dmAllowlist`                            | Ships allowed to DM (empty = none besides owner).              |
| `channels.tlon.autoAcceptDmInvites`                    | Auto-accept DMs from ships in `dmAllowlist`.                   |
| `channels.tlon.autoAcceptGroupInvites`                 | Auto-accept group invites from `groupInviteAllowlist`.         |
| `channels.tlon.groupInviteAllowlist`                   | Ships whose group invites are auto-accepted.                   |
| `channels.tlon.autoDiscoverChannels`                   | Auto-discover joined group channels (default: `false`).        |
| `channels.tlon.implicitMentions.threadParticipation`   | Let participated-thread follow-ups bypass mention gating.      |
| `channels.tlon.groupChannels`                          | Manually pinned channel nests.                                 |
| `channels.tlon.defaultAuthorizedShips`                 | Ships authorized for all channels (used when no rule matches). |
| `channels.tlon.authorization.channelRules`             | Per-channel-nest auth mode + allowlist.                        |
| `channels.tlon.showModelSignature`                     | Append `_[Generated by <model>]_` to replies.                  |
| `channels.tlon.responsePrefix`                         | Static prefix prepended to outbound replies.                   |
| `channels.tlon.accounts.<id>`                          | Additional named accounts (multi-ship setups).                 |

## Notes

- Group replies need an @ mention (e.g. `~your-bot-ship`) unless the bot already joined that thread.
- Thread replies land in-thread; the bot also gets the last 10 messages of thread context prepended
  for the agent.
- Rich text (bold, italic, code, headers, lists) converts to Tlon's native format.
- Sending an inbound message that asks for a channel summary (for example "summarize this
  channel") triggers a built-in history summarization instead of the normal reply flow.

## Related

- [Channels Overview](/channels) — all supported channels
- [Pairing](/channels/pairing) — DM authentication and pairing flow
- [Groups](/channels/groups) — group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Security](/gateway/security) — access model and hardening
