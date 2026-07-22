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
identity by default. Give the displayed **public key only** to a Buzz admin, who
must approve the bot for the relay and each room it should use.

If approval is not ready, OpenClaw saves the identity with Buzz disabled. Rerun
the same setup command after approval to discover rooms, choose access controls,
and send an optional test message.

### Security notes

- Never give OpenClaw a human Buzz owner's private key.
- Share only the bot public key with Buzz owners and room admins.
- Generated bot keys follow OpenClaw's current plaintext config convention.
- Existing keys can use plaintext or an existing `env`, `file`, or `exec`
  SecretRef.
- Requiring mentions and allowlisting trusted sender public keys is the
  recommended starting policy.
- Buzz messages are untrusted input to the routed agent. Match that agent's tool
  policy and sandbox access to the room's trust level.
- Anyone who obtains the bot private key can impersonate it. Treat the key like
  a password, use a SecretRef when appropriate, and never paste it into Buzz.
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
