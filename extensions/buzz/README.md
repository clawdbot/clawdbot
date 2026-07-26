# @openclaw/buzz

Official Buzz channel plugin for OpenClaw.

Bring an OpenClaw agent into Buzz so people can work with it from the same rooms
as the rest of their team. Conversations stay in the room and thread where they
started, while OpenClaw supplies the agent's model, workspace, skills, memory,
tools, and automation.

## What you can do

- Give support, engineering, or operations rooms their own specialized agents
- Let room members ask an agent to research, write, run approved tools, or use
  team-specific skills and memory
- Send proactive updates from OpenClaw automations and operators into Buzz
- Keep one Gateway and bot identity while routing different rooms to different
  agents, models, and workspaces
- Control who can activate an agent with mentions and sender allowlists
- Keep replies attached to the originating Buzz conversation

## How Buzz maps to OpenClaw

Buzz identities are Nostr keypairs. OpenClaw owns a dedicated bot private key;
Buzz admins receive only its public key. A single OpenClaw Gateway and bot
identity can serve multiple approved Buzz rooms, and normal OpenClaw bindings can
route each room to a different agent, model, or workspace.

Each room is identified by a UUID. Incoming room messages enter the normal
OpenClaw conversation flow, while replies stay in the originating Buzz room and
preserve thread context.

The high-level message flow is:

```text
Buzz room <-> Buzz relay <-> Buzz plugin <-> routed OpenClaw agent
```

## What the plugin adds

- Buzz as an OpenClaw group-chat channel
- Guided bot identity and room setup
- Room discovery after a Buzz admin approves the bot
- Mention requirements and sender allowlists
- Connection recovery without replaying the same message twice
- Room-to-agent routing through standard OpenClaw bindings

### Agent tools

The plugin does not register a separate Buzz-only agent tool. Once configured,
Buzz is available through OpenClaw's built-in `message` tool for text sends and
threaded replies. Incoming Buzz messages enter the normal OpenClaw conversation
flow.

OpenClaw agents, automations, and operators can also send proactive text
messages to approved rooms through the same channel delivery path. Because Buzz
messages enter the normal agent flow, each room can be routed to an agent with
its own workspace, model, skills, memory, and tool policy.

## Before you start

You need a Buzz workspace relay URL, a Buzz owner or admin who can approve the
bot, and at least one room where the bot can receive the **Bot** role. Use a
`wss://` relay outside local development.

## Install

```bash
openclaw plugins install @openclaw/buzz
```

Restart the Gateway after installing or updating the plugin.

## Set up

```bash
openclaw channels add --channel buzz
```

The guided flow asks for your Buzz relay URL and creates a dedicated bot
identity automatically when one is not already configured. Give the displayed
**public key only** to a Buzz admin, who must add the identity to each room with
the **Bot** role.

After the Gateway connects, OpenClaw preserves an existing Buzz profile display
name. For a new profile it uses the explicit Buzz account name, then the
identity name of the single agent routed to the configured rooms, and finally
`OpenClaw`. A configured NIP-OA `authTag` is preserved in that profile so Buzz
can display its verified owner.
OpenClaw also registers the public identity in Buzz's agent directory while
preserving any existing directory profile and channel-add policy. Buzz can then
recognize the identity as an agent and assign the **Bot** role when it is added
to more rooms. Those rooms still require explicit OpenClaw configuration before
the Gateway accepts messages from them.
While the Gateway remains connected, OpenClaw also refreshes the bot's Buzz
presence so room members see it as online. Buzz clears that presence when the
last Gateway connection for the bot identity closes.

OpenClaw immediately attempts authenticated room discovery. If room access is
not ready, it waits for Buzz to confirm the Bot role and continues
automatically. If the bounded wait expires, setup offers authenticated
Retry/Back controls without disabling Buzz, exiting setup, or generating
another key.

One discovered room is selected automatically. With several rooms, setup asks
which rooms to use and which one is the default outbound target. Fresh setup
accepts normal messages from current room members without requiring a composer
mention, verifies the saved configuration, and does not post a test message.

For local Buzz development, `just dev` does not require separate relay
membership by default. Buzz desktop cannot reliably assign the Bot role to an
externally managed identity, so add the bot directly with the CLI:

```bash
buzz channels add-member \
  --channel <ROOM_UUID> \
  --pubkey <BOT_PUBLIC_KEY> \
  --role bot
```

Run the command as an existing human owner or admin. Hosted or closed relays may
also require community membership before room membership can be granted.

### Security notes

- Never give OpenClaw a human Buzz owner's private key.
- Share only the bot public key with Buzz owners and room admins.
- Generated bot keys follow OpenClaw's current plaintext config convention.
- Existing keys can use plaintext or an existing `env`, `file`, or `exec`
  SecretRef.
- Fresh guided setup accepts normal messages from current members of the
  selected rooms. Manual configuration can require mentions when the Buzz
  client can address the bot, or restrict activation to specific member public
  keys.
- OpenClaw keeps an in-memory copy of Buzz's relay-signed room roster and
  refreshes it on membership changes; it does not query the relay for each
  message or poll from the Gateway.
- Buzz messages are untrusted input to the routed agent. Match that agent's tool
  policy and sandbox access to the room's trust level.
- Anyone who obtains the bot private key can impersonate it. Treat the key like
  a password, use a SecretRef when appropriate, and never paste it into Buzz.
- Treat a hosted relay `authTag` as a delegated reusable secret. Keep it out of
  logs, screenshots, chat, and source control; prefer a SecretRef and rotate or
  revoke it when the bot identity or relay authorization changes.
- Key rotation requires the new public key to be approved for the relay and
  rooms before the old identity is removed.

## Verify

```bash
openclaw channels status --channel buzz --probe
```

Then send a real room message:

```bash
openclaw message send \
  --channel buzz \
  --target buzz:<ROOM_UUID> \
  --message "Hello from OpenClaw"
```

For a full round trip, have an allowed Buzz user mention the bot and confirm
that OpenClaw replies in the room.

## Roadmap, not supported today

The current plugin supports text conversations in group rooms. The following
areas are planned but are not shipped yet:

- Direct messages
- Media and files
- Native reactions
- Creating rooms from OpenClaw
- Automatic relay and room-role approval
- Guided bot identity rotation

## Docs

Full setup, configuration, access controls, and troubleshooting:

- https://docs.openclaw.ai/channels/buzz

## Package

- Plugin id: `buzz`
- Package: `@openclaw/buzz`
- Minimum OpenClaw host: `2026.7.2`
