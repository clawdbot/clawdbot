---
summary: "Connect OpenClaw agents to Buzz rooms"
read_when:
  - You want people to reach an OpenClaw agent from Buzz
  - You are setting up a Buzz bot identity and room access
  - You are troubleshooting a Buzz connection
title: "Buzz"
---

Buzz is an official channel plugin that connects OpenClaw agents to team rooms
in a hosted or self-hosted Buzz workspace.

## What it does

- Receives text messages from approved Buzz rooms
- Replies in the same room and thread
- Sends text messages through OpenClaw's built-in `message` tool
- Supports mention requirements and sender allowlists
- Discovers rooms after the bot has been approved
- Reconnects and avoids processing the same message twice

The current plugin supports group rooms and text messages. Direct messages,
media and files, native reactions, room creation, and automatic admin approval
are not supported yet.

## Buzz identity and room model

Buzz uses Nostr keypairs for identity:

- The **private key** lets OpenClaw authenticate and sign messages. It stays with
  the Gateway.
- The **public key** identifies the bot. Buzz owners use it for relay approval,
  room admins use it to grant the **Bot** role, and OpenClaw can use public keys
  in sender allowlists.

The relay URL points to one Buzz workspace. Each room has a UUID, and OpenClaw
treats each configured UUID as a separate group conversation. One Gateway and
bot identity can serve many rooms; you do not need a Gateway per agent or room.

## Before you start

You need:

1. The `wss://` relay URL for your Buzz workspace.
2. A Buzz owner or admin who can approve a bot identity.
3. At least one room where the bot can be added with the **Bot** role.

<Warning>
Never give OpenClaw a human Buzz owner's private key. OpenClaw creates or uses a
dedicated bot identity and displays the public key that an admin needs for
approval.
</Warning>

## Install

```bash
openclaw plugins install @openclaw/buzz
```

Restart the Gateway after installing or updating the plugin.

## Guided setup

Run:

```bash
openclaw channels add --channel buzz
```

The setup flow walks through the following steps:

1. Enter the Buzz relay URL.
2. Generate a dedicated bot identity, or choose an existing bot identity.
3. Give the displayed public key to a Buzz admin.
4. Ask the admin to approve the bot for the relay and add it to each room with
   the **Bot** role.
5. Rerun setup after approval if the first run paused.
6. Select discovered rooms, or enter a room UUID manually.
7. Choose who can activate the agent and whether a mention is required.
8. Choose a default room and optionally send a test message.

If admin approval is not ready, OpenClaw saves the relay and bot identity with
Buzz disabled. The next setup run offers to reuse that identity, so you do not
need to create another bot.

### Bot approval

Buzz has two approval steps:

- The bot must be allowed to connect to the workspace relay when the workspace
  restricts relay membership.
- The bot must be added to every target room with the **Bot** role.

OpenClaw cannot grant either permission. It gives the admin only the bot's public
key and never asks for the admin's private key.

For self-hosted Buzz, an operator can add relay membership from the relay host:

```bash
buzz-admin add-member --pubkey <BOT_PUBLIC_KEY> --role member
```

An authorized room member can then add the bot to a room:

```bash
buzz channels add-member \
  --channel <ROOM_UUID> \
  --pubkey <BOT_PUBLIC_KEY> \
  --role bot
```

Hosted Buzz workspaces may provide their own invitation or approval flow. Ask
the workspace operator which path to use.

## Agent tools and messaging

The Buzz plugin does not add a separate Buzz-only agent tool. It registers Buzz
as a destination for OpenClaw's built-in `message` tool and normal reply
delivery.

Agents can:

- Reply to an incoming Buzz message in its room or thread
- Send text to an approved Buzz room
- Use the configured default room when a workflow does not specify a target
- Use the routed agent's normal skills, memory, and allowed tools

Humans and automations can test the same outbound path from the CLI:

```bash
openclaw message send \
  --channel buzz \
  --target buzz:<ROOM_UUID> \
  --message "Hello from OpenClaw"
```

### Route rooms to different agents

Standard OpenClaw bindings can send each Buzz room to a different agent,
workspace, or model while one Gateway and Buzz bot serve all of them:

```json5
{
  agents: {
    list: [
      { id: "support", workspace: "~/.openclaw/workspace-support" },
      { id: "engineering", workspace: "~/.openclaw/workspace-engineering" },
    ],
  },
  bindings: [
    {
      agentId: "support",
      match: {
        channel: "buzz",
        peer: { kind: "group", id: "buzz:<SUPPORT_ROOM_UUID>" },
      },
    },
    {
      agentId: "engineering",
      match: {
        channel: "buzz",
        peer: { kind: "group", id: "buzz:<ENGINEERING_ROOM_UUID>" },
      },
    },
  ],
}
```

Without a room-specific binding, normal OpenClaw routing selects the default
agent. See [Channel routing](/channels/channel-routing) for matching precedence.

## Access control

Guided setup configures two independent controls:

- **Require mentions**: the agent responds only when the bot is mentioned.
- **Sender access**: allow every member of an approved room, disable the room,
  or allow only selected Buzz public keys.

The recommended default is to require a mention and use a sender allowlist.
Buzz room membership still applies in addition to these OpenClaw controls.

These controls decide who can start an agent run; they do not limit what the
routed agent can do after a message is accepted. Treat room messages as
untrusted input, and configure that agent's [sandbox and tool policy](/gateway/sandbox-vs-tool-policy-vs-elevated)
for the room's trust level.

## Manual configuration

Guided setup is recommended. The equivalent configuration looks like:

```json5
{
  channels: {
    buzz: {
      relayUrl: "wss://buzz.example.com",
      privateKey: "nsec1...",
      groupPolicy: "allowlist",
      groupAllowFrom: ["<64_CHARACTER_HEX_SENDER_PUBLIC_KEY>"],
      groups: {
        "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c": {
          requireMention: true,
        },
      },
      defaultTo: "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c",
    },
  },
}
```

Room targets are UUIDs. Use the room UUID shown during discovery or ask a room
admin for it; a display name such as `general` is not a valid target.

Guided setup accepts sender keys as `npub` or 64-character hexadecimal values
and stores normalized hexadecimal keys. For manual configuration,
`groupAllowFrom` entries must use the 64-character hexadecimal form.

### Bot key storage

The default guided path generates a bot private key and stores it in
`channels.buzz.privateKey`, following OpenClaw's current plaintext config
convention.

For an existing key, setup can use plaintext or an existing `env`, `file`, or
`exec` SecretRef. See [Secrets management](/gateway/secrets) for provider setup.
The default account can also read:

```bash
export BUZZ_RELAY_URL="wss://buzz.example.com"
export BUZZ_PRIVATE_KEY="nsec1..."
```

If a hosted workspace operator gives you an identity authorization value, set
`channels.buzz.authTag` or `BUZZ_AUTH_TAG`. It can use the same plaintext or
SecretRef forms as the private key. This value is tied to the bot identity, so
request a new one when rotating keys.

Self-hosted operators can generate a key manually for recovery or advanced
setup:

```bash
buzz-admin generate-key
```

## Verify the connection

Run the authenticated channel probe:

```bash
openclaw channels status --channel buzz --probe
```

A successful probe confirms that the bot can authenticate and that Buzz reports
the selected room membership. It does not replace the admin's confirmation that
the identity has the **Bot** role.

Then send a real message:

```bash
openclaw message send \
  --channel buzz \
  --target buzz:<ROOM_UUID> \
  --message "OpenClaw Buzz test"
```

For a full round trip, have an allowed Buzz user mention the bot and confirm that
OpenClaw replies in the room.

## Rotate the bot identity

Bot identity rotation requires admin approval for the new public key:

1. Generate a new dedicated bot identity.
2. Have an admin approve its public key for the relay and every configured room.
3. Replace the configured private key and restart or reload the Gateway.
4. Test outbound and inbound messages.
5. Remove the old public key from the rooms and relay.

Complete approval before switching keys to minimize downtime. Rotation is not
automatic today.

## Current limits and roadmap

These follow-up areas are planned but are not part of the current plugin:

- Direct messages
- Media and file upload or download
- Native emoji reactions
- Creating or administering rooms from OpenClaw
- Automatic relay membership and room-role approval
- Guided bot identity rotation

## Troubleshooting

| Symptom                                      | What to check                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| No rooms are discovered                      | Confirm the admin approved this exact bot public key. Enter a room UUID manually if needed.                             |
| Authentication fails                         | Check the relay URL, bot private key, relay membership, and any authorization value supplied by the workspace operator. |
| A message cannot be sent                     | Confirm the bot is a room member with the **Bot** role and that the UUID is configured.                                 |
| The bot receives messages but does not reply | Check the sender allowlist and whether the room requires a mention.                                                     |
| Setup says the Gateway is not running        | Start it with `openclaw gateway`, then run the probe and test message again.                                            |
| Setup was paused                             | Finish admin approval, then rerun `openclaw channels add --channel buzz`; choose the saved identity.                    |

## Related

- [Channel overview](/channels)
- [Channel access controls](/channels/groups)
- [Secrets management](/gateway/secrets)
- [Channel troubleshooting](/channels/troubleshooting)
