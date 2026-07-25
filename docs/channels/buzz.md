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
3. Open or create the target Buzz room.
4. Add the displayed public key to the room with the **Bot** role.
5. Retry authenticated discovery in the same setup session, or save and resume
   later with the same bot identity.
6. Select the rooms returned by Buzz.
7. Choose who can activate the agent and whether a mention is required.
8. Choose a default room and optionally send a test message.

OpenClaw attempts authenticated room discovery immediately after creating or
loading the identity. If room access is not ready, it can retry without rotating
the key. If you finish later, OpenClaw saves the relay and bot identity with Buzz
disabled; the next setup run offers to reuse that identity.

### Bot approval

Every target room must contain the bot identity with the **Bot** role. An
existing human member or ordinary room member role is not sufficient.

In Buzz desktop, open the room, open **Members**, choose **Add members**, search
for the bot public key, and select the **Bot** role when the identity appears.
An authorized human owner or admin can always use the Buzz CLI:

```bash
buzz channels add-member \
  --channel <ROOM_UUID> \
  --pubkey <BOT_PUBLIC_KEY> \
  --role bot
```

Run that command as the existing human owner or admin. Never give OpenClaw that
human private key.

The local Buzz `just dev` relay does not require separate relay membership by
default. A hosted or closed relay may require the bot public key to be added to
the workspace community first:

```bash
buzz-admin add-member --pubkey <BOT_PUBLIC_KEY> --role member
```

OpenClaw cannot grant room or relay access. It displays only the bot public key
needed by the authorized human.

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
the selected room with the **Bot** role.

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

| Symptom                                      | What to check                                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| No rooms are discovered                      | Confirm this exact bot public key is in the room with the **Bot** role, then retry authenticated discovery.          |
| Authentication fails                         | Check the relay URL, bot private key, closed-relay membership, and any authorization value supplied by the operator. |
| A message cannot be sent                     | Confirm the bot is a room member with the **Bot** role and that the UUID is configured.                              |
| The bot receives messages but does not reply | Check the sender allowlist and whether the room requires a mention.                                                  |
| Setup says the Gateway is not running        | Start it with `openclaw gateway`, then run the probe and test message again.                                         |
| Setup was paused                             | Rerun `openclaw channels add --channel buzz`, reuse the saved identity, and retry room discovery.                    |

## Related

- [Channel overview](/channels)
- [Channel access controls](/channels/groups)
- [Secrets management](/gateway/secrets)
- [Channel troubleshooting](/channels/troubleshooting)
