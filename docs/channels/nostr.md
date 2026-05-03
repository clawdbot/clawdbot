---
summary: "Nostr DM channel via NIP-04 encrypted messages"
read_when:
  - You want OpenClaw to receive DMs via Nostr
  - You're setting up decentralized messaging
title: "Nostr"
---

**Status:** Optional bundled plugin (disabled by default until configured).

Nostr is a decentralized protocol for social networking. This channel enables OpenClaw to receive and respond to encrypted direct messages (DMs) via NIP-04.

## Bundled plugin

Current OpenClaw releases ship Nostr as a bundled plugin, so normal packaged
builds do not need a separate install.

### Older/custom installs

- Onboarding (`openclaw onboard`) and `openclaw channels add` still surface
  Nostr from the shared channel catalog.
- If your build excludes bundled Nostr, install the npm package directly.

```bash
openclaw plugins install @openclaw/nostr
```

Use the bare package to follow the current official release tag. Pin an exact
version only when you need a reproducible install.

Use a local checkout (dev workflows):

```bash
openclaw plugins install --link <path-to-local-nostr-plugin>
```

Restart the Gateway after installing or enabling plugins.

### Non-interactive setup

```bash
openclaw channels add --channel nostr --private-key "$NOSTR_PRIVATE_KEY"
openclaw channels add --channel nostr --private-key "$NOSTR_PRIVATE_KEY" --relay-urls "wss://relay.damus.io,wss://relay.primal.net"
```

Use `--use-env` to keep `NOSTR_PRIVATE_KEY` in the environment instead of storing the key in config.

## Quick setup

1. Generate a Nostr keypair (if needed):

```bash
# Using nak
nak key generate
```

2. Add to config:

```json5
{
  channels: {
    nostr: {
      privateKey: "${NOSTR_PRIVATE_KEY}",
    },
  },
}
```

3. Export the key:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Restart the Gateway.

## Configuration reference

| Key          | Type     | Default                                     | Description                         |
| ------------ | -------- | ------------------------------------------- | ----------------------------------- |
| `privateKey` | string   | required                                    | Private key in `nsec` or hex format |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | Relay URLs (WebSocket)              |
| `dmPolicy`   | string   | `pairing`                                   | DM access policy                    |
| `allowFrom`  | string[] | `[]`                                        | Allowed sender pubkeys              |
| `enabled`    | boolean  | `true`                                      | Enable/disable channel              |
| `name`       | string   | -                                           | Display name                        |
| `profile`    | object   | -                                           | NIP-01 profile metadata             |

## Profile metadata

Profile data is published as a NIP-01 `kind:0` event. You can manage it from the Control UI (Channels -> Nostr -> Profile) or set it directly in config.

Example:

```json5
{
  channels: {
    nostr: {
      privateKey: "${NOSTR_PRIVATE_KEY}",
      profile: {
        name: "openclaw",
        displayName: "OpenClaw",
        about: "Personal assistant DM bot",
        picture: "https://example.com/avatar.png",
        banner: "https://example.com/banner.png",
        website: "https://example.com",
        nip05: "openclaw@example.com",
        lud16: "openclaw@example.com",
      },
    },
  },
}
```

Notes:

- Profile URLs must use `https://`.
- Importing from relays merges fields and preserves local overrides.

## Access control

### DM policies

- **pairing** (default): unknown senders get a pairing code.
- **allowlist**: only pubkeys in `allowFrom` can DM.
- **open**: public inbound DMs (requires `allowFrom: ["*"]`).
- **disabled**: ignore inbound DMs.

Enforcement notes:

- Inbound event signatures are verified before sender policy and NIP-04 decryption, so forged events are rejected early.
- Pairing replies are sent without processing the original DM body.
- Inbound DMs are rate-limited and oversized payloads are dropped before decrypt.

### Allowlist example

```json5
{
  channels: {
    nostr: {
      privateKey: "${NOSTR_PRIVATE_KEY}",
      dmPolicy: "allowlist",
      allowFrom: ["npub1abc...", "npub1xyz..."],
    },
  },
}
```

## Key formats

Accepted formats:

- **Private key:** `nsec...` or 64-char hex
- **Pubkeys (`allowFrom`):** `npub...` or hex

## Relays

Defaults: `relay.damus.io` and `nos.lol`.

```json5
{
  channels: {
    nostr: {
      privateKey: "${NOSTR_PRIVATE_KEY}",
      relays: ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"],
    },
  },
}
```

Tips:

- Use 2-3 relays for redundancy.
- Avoid too many relays (latency, duplication).
- Paid relays can improve reliability.
- Local relays are fine for testing (`ws://localhost:7777`).

## Protocol support

| NIP    | Status    | Description                           |
| ------ | --------- | ------------------------------------- |
| NIP-01 | Supported | Basic event format + profile metadata |
| NIP-04 | Supported | Encrypted DMs (`kind:4`)              |
| NIP-17 | Planned   | Gift-wrapped DMs                      |
| NIP-44 | Planned   | Versioned encryption                  |

## Testing

### Local relay

```bash
# Start strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json5
{
  channels: {
    nostr: {
      privateKey: "${NOSTR_PRIVATE_KEY}",
      relays: ["ws://localhost:7777"],
    },
  },
}
```

### Manual test

1. Note the bot pubkey (npub) from logs.
2. Open a Nostr client (Damus, Amethyst, etc.).
3. DM the bot pubkey.
4. Verify the response.

## Troubleshooting

### Not receiving messages

- Verify the private key is valid.
- Ensure relay URLs are reachable and use `wss://` (or `ws://` for local).
- Confirm `enabled` is not `false`.
- Check Gateway logs for relay connection errors.

### Not sending responses

- Check relay accepts writes.
- Verify outbound connectivity.
- Watch for relay rate limits.

### Duplicate responses

- Expected when using multiple relays.
- Messages are deduplicated by event ID; only the first delivery triggers a response.

## Security

- Never commit private keys.
- Use environment variables for keys.
- Consider `allowlist` for production bots.
- Signatures are verified before sender policy, and sender policy is enforced before decrypt, so forged events are rejected early and unknown senders cannot force full crypto work.

## Limitations (MVP)

- Direct messages only (no group chats).
- No media attachments.
- NIP-04 only (NIP-17 gift-wrap planned).

## Related

- [Channels Overview](/channels) — all supported channels
- [Pairing](/channels/pairing) — DM authentication and pairing flow
- [Groups](/channels/groups) — group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Security](/gateway/security) — access model and hardening
