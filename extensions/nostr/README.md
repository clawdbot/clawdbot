# @openclaw/nostr

Nostr DM channel plugin for OpenClaw using NIP-04 encrypted direct messages.

## Overview

This extension adds Nostr as a messaging channel to OpenClaw. It enables your bot to:

- Receive encrypted DMs from Nostr users
- Send encrypted responses back
- Work with any NIP-04 compatible Nostr client (Damus, Amethyst, etc.)

## Installation

```bash
openclaw plugins install @openclaw/nostr
```

## Quick Setup

1. Generate a Nostr keypair (if you don't have one):

   ```bash
   # Using nak CLI
   nak key generate

   # Or use any Nostr key generator
   ```

2. Add to your config:

   ```json
   {
     "channels": {
       "nostr": {
         "privateKey": "${NOSTR_PRIVATE_KEY}",
         "relays": ["wss://relay.damus.io", "wss://nos.lol"]
       }
     }
   }
   ```

3. Set the environment variable:

   ```bash
   export NOSTR_PRIVATE_KEY="nsec1..."  # or hex format
   ```

4. Restart the gateway

## Configuration

| Key          | Type     | Default                                     | Description                                                |
| ------------ | -------- | ------------------------------------------- | ---------------------------------------------------------- |
| `privateKey` | string   | required                                    | Bot's private key (nsec or hex format)                     |
| `relays`     | string[] | `["wss://relay.damus.io", "wss://nos.lol"]` | WebSocket relay URLs                                       |
| `dmPolicy`   | string   | `"pairing"`                                 | Access control: `pairing`, `allowlist`, `open`, `disabled` |
| `allowFrom`  | string[] | `[]`                                        | Allowed sender pubkeys (npub or hex)                       |
| `enabled`    | boolean  | `true`                                      | Enable/disable the channel                                 |
| `name`       | string   | -                                           | Display name for the account                               |

## Access Control

### DM Policies

- **pairing** (default): Unknown senders receive a pairing code to request access
- **allowlist**: Only pubkeys in `allowFrom` can message the bot
- **open**: Anyone can message the bot (use with caution)
- **disabled**: DMs are disabled

Inbound event signatures are verified before policy enforcement and NIP-04 decryption.
Unknown senders in `pairing` mode can receive a pairing reply, but their original DM body is not
processed unless approved.

### Example: Allowlist Mode

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1abc...", "0123456789abcdef..."]
    }
  }
}
```

## Testing

### Local Relay (Recommended)

```bash
# Using strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry

# Configure openclaw to use local relay
"relays": ["ws://localhost:7777"]
```

### Manual Test

1. Start the gateway with Nostr configured
2. Open Damus, Amethyst, or another Nostr client
3. Send a DM to your bot's npub
4. Verify the bot responds

## Protocol Support

| NIP    | Status    | Notes                  |
| ------ | --------- | ---------------------- |
| NIP-01 | Supported | Basic event structure  |
| NIP-04 | Supported | Encrypted DMs (kind:4) |
| NIP-17 | Planned   | Gift-wrapped DMs (v2)  |

## Security Notes

- Private keys are never logged
- Event signatures are verified before processing
- Sender policy is checked before expensive crypto work
- Inbound DMs are rate-limited and oversized payloads are dropped before decrypt
- Use environment variables for keys, never commit to config files
- Consider using `allowlist` mode in production

## Troubleshooting

### Bot not receiving messages

1. Verify private key is correctly configured
2. Check relay connectivity
3. Ensure `enabled` is not set to `false`
4. Check the bot's public key matches what you're sending to

### Messages not being delivered

1. Check relay URLs are correct (must use `wss://`)
2. Verify relays are online and accepting connections
3. Check for rate limiting (reduce message frequency)

## License

MIT
