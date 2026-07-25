---
summary: "IRC plugin setup, access controls, and troubleshooting"
title: IRC
read_when:
  - You want to connect OpenClaw to IRC channels or DMs
  - You are configuring IRC allowlists, group policy, or mention gating
---

Use IRC when you want OpenClaw in classic channels (`#room`) and direct messages.
Install the official IRC plugin, then configure it under `channels.irc`.

## Quick start

1. Install the plugin:

```bash
openclaw plugins install @openclaw/irc
```

2. Set at least host, nick, and the channels to join in `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    irc: {
      enabled: true,
      host: "irc.example.com",
      port: 6697,
      tls: true,
      nick: "openclaw-bot",
      channels: ["#openclaw"],
    },
  },
}
```

3. Start/restart the Gateway:

```bash
openclaw gateway run
```

Prefer a private IRC server for bot coordination. If you intentionally use a public IRC network, common choices include Libera.Chat, OFTC, and Snoonet. Avoid predictable public channels for bot or swarm backchannel traffic.

## Inbound durability

OpenClaw writes each accepted IRC `PRIVMSG` to its durable ingress queue before normal policy checks and agent dispatch. Pending or retryable messages survive a Gateway restart and remain serialized per channel or direct-message peer.

IRC does not provide a replayable delivery ID or resend messages missed by a disconnected client. OpenClaw therefore assigns a local ID that is stable only within the current TCP connection. The queue protects the local accept-to-dispatch window; it cannot recover a message that never reached OpenClaw or deduplicate a server resend across connections.

## Connection settings

| Key                           | Default                       | Notes                                                       |
| ----------------------------- | ----------------------------- | ----------------------------------------------------------- |
| `host`                        | none (required)               | IRC server hostname                                         |
| `port`                        | `6697` with TLS, `6667` plain | 1-65535                                                     |
| `tls`                         | `true`                        | Set `false` only for intentional plaintext                  |
| `nick`                        | none (required)               | Bot nick                                                    |
| `username`                    | nick, else `openclaw`         | IRC username                                                |
| `realname`                    | `OpenClaw`                    | Realname/GECOS field                                        |
| `password` / `passwordFile`   | none                          | Server password; file must be a regular file                |
| `channels`                    | none                          | Channels to join (`["#openclaw"]`)                          |
| `accounts` / `defaultAccount` | none                          | Multi-account setup; env vars fill only the default account |

## Security defaults

- IRC uses raw TCP/TLS sockets outside OpenClaw operator-managed forward proxy routing. In deployments that require all egress through that forward proxy, set `channels.irc.enabled=false` unless direct IRC egress is explicitly approved.
- `channels.irc.dmPolicy` defaults to `"pairing"`: unknown DM senders get a pairing code you approve with `openclaw pairing approve irc <code>`.
- `channels.irc.groupPolicy` defaults to `"allowlist"`.
- With `groupPolicy="allowlist"`, set `channels.irc.groups` to define allowed channels.
- Use TLS (`channels.irc.tls=true`) unless you intentionally accept plaintext transport.

## Access control

There are two separate "gates" for IRC channels:

1. **Channel access** (`groupPolicy` + `groups`): whether the bot accepts messages from a channel at all.
2. **Sender access** (`groupAllowFrom` / per-channel `groups["#channel"].allowFrom`): who is allowed to trigger the bot inside that channel.

Config keys:

- DM allowlist (DM sender access): `channels.irc.allowFrom`
- Group sender allowlist (channel sender access): `channels.irc.groupAllowFrom`
- Per-channel controls (channel + sender + mention rules): `channels.irc.groups["#channel"]` with `requireMention`, `allowFrom`, `enabled`, `tools`, `toolsBySender`, `skills`, and `systemPrompt`
- `channels.irc.groupPolicy="open"` allows unconfigured channels (**still mention-gated by default**)

Allowlist entries should use stable sender identities (`nick!user@host`).
Bare nick matching is mutable and only enabled when `channels.irc.dangerouslyAllowNameMatching: true`.

### Common gotcha: `allowFrom` is for DMs, not channels

If you see logs like:

- `irc: drop group sender alice!ident@host (policy=allowlist)`

...it means the sender wasn't allowed for **group/channel** messages. Fix it by either:

- setting `channels.irc.groupAllowFrom` (global for all channels), or
- setting per-channel sender allowlists: `channels.irc.groups["#channel"].allowFrom`

Example (allow anyone in `#openclaw` to talk to the bot):

```json5
{
  channels: {
    irc: {
      groupPolicy: "allowlist",
      groups: {
        "#openclaw": { allowFrom: ["*"] },
      },
    },
  },
}
```

## Reply triggering (mentions)

Even if a channel is allowed (via `groupPolicy` + `groups`) and the sender is allowed, OpenClaw defaults to **mention-gating** in group contexts. The bot counts as mentioned when the message contains the connected bot nick or matches your configured mention patterns.

That means you may see logs like `drop channel … (missing-mention)` unless the message includes a mention pattern that matches the bot.

To make the bot reply in an IRC channel **without needing a mention**, disable mention gating for that channel:

```json5
{
  channels: {
    irc: {
      groupPolicy: "allowlist",
      groups: {
        "#openclaw": {
          requireMention: false,
          allowFrom: ["*"],
        },
      },
    },
  },
}
```

Or to allow **all** IRC channels (no per-channel allowlist) and still reply without mentions:

```json5
{
  channels: {
    irc: {
      groupPolicy: "open",
      groups: {
        "*": { requireMention: false, allowFrom: ["*"] },
      },
    },
  },
}
```

## Security note (recommended for public channels)

If you allow `allowFrom: ["*"]` in a public channel, anyone can prompt the bot.
To reduce risk, restrict tools for that channel.

### Same tools for everyone in the channel

```json5
{
  channels: {
    irc: {
      groups: {
        "#openclaw": {
          allowFrom: ["*"],
          tools: {
            deny: ["group:runtime", "group:fs", "gateway", "nodes", "cron", "browser"],
          },
        },
      },
    },
  },
}
```

### Different tools per sender (owner gets more power)

Use `toolsBySender` to apply a stricter policy to `"*"` and a looser one to your nick:

```json5
{
  channels: {
    irc: {
      groups: {
        "#openclaw": {
          allowFrom: ["*"],
          toolsBySender: {
            "*": {
              deny: ["group:runtime", "group:fs", "gateway", "nodes", "cron", "browser"],
            },
            "id:alice": {
              deny: ["gateway", "nodes", "cron"],
            },
          },
        },
      },
    },
  },
}
```

Notes:

- `toolsBySender` keys should use explicit prefixes (`channel:`, `id:`, `e164:`, `username:`, `name:`). For IRC use `id:` with the sender identity value: `id:alice` or `id:alice!~alice@203.0.113.7` for stronger matching.
- Legacy unprefixed keys are still accepted, matched as `id:` only, and emit a deprecation warning.
- The first matching sender policy wins; `"*"` is the wildcard fallback.

For more on group access vs mention-gating (and how they interact), see: [/channels/groups](/channels/groups).

## NickServ

To identify with NickServ after connect:

```json5
{
  channels: {
    irc: {
      nickserv: {
        enabled: true,
        service: "NickServ",
        password: "your-nickserv-password",
      },
    },
  },
}
```

NickServ identify runs by default whenever a password is set (`enabled` only needs to be `false` to opt out). `service` defaults to `NickServ`; `passwordFile` is an alternative to inline `password`.

Optional one-time registration on connect (`register: true` requires `registerEmail`):

```json5
{
  channels: {
    irc: {
      nickserv: {
        register: true,
        registerEmail: "bot@example.com",
      },
    },
  },
}
```

Disable `register` after the nick is registered to avoid repeated REGISTER attempts.

## Environment variables

Default account supports:

- `IRC_HOST`
- `IRC_PORT`
- `IRC_TLS`
- `IRC_NICK`
- `IRC_USERNAME`
- `IRC_REALNAME`
- `IRC_PASSWORD`
- `IRC_CHANNELS` (comma-separated)
- `IRC_NICKSERV_PASSWORD`
- `IRC_NICKSERV_REGISTER_EMAIL`

`IRC_HOST` cannot be set from a workspace `.env`; see [Workspace `.env` files](/gateway/security).

## Troubleshooting

- If the bot connects but never replies in channels, verify `channels.irc.groups` **and** whether mention-gating is dropping messages (`missing-mention`). If you want it to reply without pings, set `requireMention:false` for the channel.
- If login fails, verify nick availability and server password.
- If TLS fails on a custom network, verify host/port and certificate setup.

## Related

- [Channels Overview](/channels) — all supported channels
- [Pairing](/channels/pairing) — DM authentication and pairing flow
- [Groups](/channels/groups) — group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Security](/gateway/security) — access model and hardening
