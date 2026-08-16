# @openclaw/buzz

Official Buzz channel plugin for OpenClaw. It connects an OpenClaw agent to approved Buzz rooms for text conversations and threaded replies.

## Requirements

You need:

- A Buzz relay URL
- A Buzz owner or admin
- A room where the bot can receive the **Bot** role

Use `wss://` outside local development.

## Set up

```bash
openclaw channels add --channel buzz
```

OpenClaw installs the plugin if needed, asks for the relay URL, and generates a dedicated bot identity.

For a complete named-account setup, run guided setup and select or create the
named account when prompted:

```bash
openclaw channels add --channel buzz
```

To write only a named account's identity credentials non-interactively:

```bash
openclaw channels add \
  --channel buzz \
  --account ada \
  --name Ada \
  --relay-url wss://ada.example.com \
  --private-key 'nsec1...'
```

The non-interactive command does not discover rooms. Before starting the
Gateway, either finish guided setup for `ada` or configure
`channels.buzz.accounts.ada.groups` and
`channels.buzz.accounts.ada.defaultTo` manually.

Existing default-account credentials are preserved when the first named
account is added. Buzz environment variables apply only to the default account.

Give the displayed **public key only** to a Buzz owner or admin:

```bash
buzz channels add-member \
  --channel <ROOM_UUID> \
  --pubkey <BOT_PUBLIC_KEY> \
  --role bot
```

Closed relays may also require the bot to be added as a relay member. Setup waits for approval, discovers accessible rooms, and saves the selected rooms and default target.

Restart the Gateway if it was already running.

## Verify

```bash
openclaw channels status --probe
```

Inspect the current bot, approved rooms, and room members:

```bash
openclaw directory self --channel buzz
openclaw directory peers list --channel buzz
openclaw directory groups list --channel buzz
openclaw directory groups members --channel buzz --group-id buzz:<ROOM_UUID>
```

Buzz profile and room names are used as display labels, while public keys and
room UUIDs remain the stable identities. Archived rooms are omitted; an
archive or restore event rebuilds only the Buzz connection's room
subscriptions and does not stop the Gateway.

Send a test message:

```bash
openclaw message send \
  --channel buzz \
  --target <ROOM_UUID> \
  --message "Hello from OpenClaw"
```

## Security and scope

- Never give OpenClaw a human owner's private key.
- The generated bot private key is stored in OpenClaw configuration; only its public key is displayed.
- Treat Buzz messages as untrusted agent input.
- Currently supported: text conversations, threads, typing, and directory
  lookup in group rooms.
- Not yet supported: DMs, media, reactions, or creating rooms from OpenClaw.

Full documentation: https://docs.openclaw.ai/channels/buzz

Package: `@openclaw/buzz` · Plugin ID: `buzz`
