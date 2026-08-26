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

- Receives normal, rich-content, and structured-diff messages from approved
  Buzz rooms
- Replies in the same room and thread
- Shows typing while an accepted agent turn is running
- Preserves Markdown in replies and sends text through OpenClaw's built-in
  `message` tool
- Sends native Buzz mentions to current room members from replies and proactive
  messages
- Supports mention requirements and sender allowlists
- Discovers rooms after the bot has been approved
- Resolves current Buzz profile names, avatars, room names, and room membership
  through OpenClaw's directory commands
- Reconnects and avoids processing the same message twice

The current plugin supports group rooms, Markdown text, and inbound structured
diffs. Direct messages, media and files, native reactions, room creation, and
automatic admin approval are not supported yet.

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

1. Enter the Buzz relay URL if one is not already configured.
2. OpenClaw reuses the configured bot identity or generates one automatically.
3. If the bot does not have room access yet, give the displayed public key to a
   Buzz room owner or admin.
4. OpenClaw waits for Buzz to confirm the **Bot** role and continues
   automatically. If the automatic wait expires, retry authenticated discovery
   or go back without changing the generated identity.
5. If Buzz returns one room, OpenClaw selects it. If Buzz returns several,
   select the rooms to use and the default outbound room.
6. OpenClaw saves the configuration and silently verifies the authenticated
   room when the Gateway is running.

Fresh setup accepts normal messages from current members of the configured
rooms without requiring a composer mention. Existing explicit mention and
sender-allowlist settings are preserved when setup is rerun.

The automatic room-access wait is bounded. If access is not granted in time,
setup remains open and offers authenticated Retry/Back controls. Every retry
reuses the same relay and bot identity; the timeout does not disable Buzz or
exit setup.

### Bot approval

Every target room must contain the bot identity with the **Bot** role. An
existing human member or ordinary room member role is not sufficient.

Buzz desktop cannot reliably assign the Bot role to an externally managed
OpenClaw identity. Use the Buzz CLI as the existing human room owner or admin:

```bash
buzz channels add-member \
  --channel <ROOM_UUID> \
  --pubkey <BOT_PUBLIC_KEY> \
  --role bot
```

Run that command as the existing human owner or admin. Never give OpenClaw that
human private key.

After the Gateway connects, OpenClaw preserves an existing non-empty Buzz
profile display name. For a new profile it uses the configured Buzz channel
account name, then the identity name of the single agent routed to the
configured Buzz rooms, and finally `OpenClaw`. This replaces the shortened
public key in Buzz after its profile cache refreshes.

OpenClaw also registers the same public identity in Buzz's agent directory. It
preserves an existing agent-directory profile and channel-add policy; for a new
profile it allows authorized Buzz users to add the identity. This lets Buzz
assign the **Bot** role when the identity is invited to additional rooms
instead of treating it as a normal member. OpenClaw still receives messages
only from rooms explicitly selected in `channels.buzz.groups`.

Buzz displays `owner unavailable` when the bot profile has no valid NIP-OA
owner attestation. This does not mean room access failed. When
`channels.buzz.authTag` is configured, OpenClaw includes that attestation in the
published profile so Buzz can show the verified human owner.

While the Gateway is connected, OpenClaw publishes and refreshes the bot's
ephemeral Buzz presence every 30 seconds. Buzz removes the presence when the
last authenticated Gateway connection for that bot identity closes, so
multiple Gateway instances do not incorrectly mark one another offline.

The local Buzz `just dev` relay does not require separate relay membership by
default. A hosted or closed relay may require the bot public key to be added to
the workspace community first. Adding community membership grants relay access;
it does not add the identity to a room with the Bot role.

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
- Show room- or thread-scoped typing while generating a reply
- Receive Buzz kind `9` normal messages, kind `40002` rich-content messages,
  and kind `40008` structured diffs
- Send Markdown text to an approved Buzz room as a normal kind `9` message
- Send native room-member mentions from normal replies and proactive messages
- Use the configured default room when a workflow does not specify a target
- Use the routed agent's normal skills, memory, and allowed tools

Structured diffs include their repository, commit, file, branch, pull request,
language, description, truncation status, and unified-diff content in the agent
context when those fields are present. Diff content is not interpreted as an
OpenClaw command or textual mention.

Typing uses Buzz's ephemeral kind `20002` on the active authenticated Gateway
connection. Ordinary replies refresh it every three seconds; heartbeat-driven
replies use OpenClaw's shared typing interval, which defaults to six seconds.
OpenClaw stops refreshing when the turn completes, is cancelled, fails, or the
Gateway shuts down. Typing failures do not block the reply or reconnect the
Gateway solely to send an ephemeral event.

Humans and automations can test the same outbound path from the CLI:

```bash
openclaw message send \
  --channel buzz \
  --target buzz:<ROOM_UUID> \
  --message "Hello from OpenClaw"
```

### Native mentions

Write a unique current room member's profile name as `@Display Name`. OpenClaw
keeps the visible text unchanged and adds the native Buzz `p` tag, including on
threaded replies. Names are resolved only against the target room's current
relay-signed membership and bounded profile snapshot.

For an explicit identity, include its NIP-27 reference in the message:

```bash
openclaw message send \
  --channel buzz \
  --target engineering \
  --message "Please review this, nostr:npub1..."
```

The referenced public key must be a current member of the target room. Without
an explicit identity, unknown names and duplicate profile names fail visibly
instead of sending text that looks like a mention without notifying anyone.
When the message contains an explicit identity, unresolved or ambiguous labels
remain presentation text; include every intended identity explicitly. Ambiguous
errors list candidate public keys so the sender can retry with the intended
`nostr:npub...` identity. Out-of-room public keys always fail. Mention-like text
inside inline or fenced Markdown code is ignored, and one message can carry at
most 50 native mentions.

Connected Gateways resolve names from their existing in-memory directory
snapshot and do not query the relay per message. Profiles beyond the bounded
snapshot require an explicit `nostr:npub...` identity. A standalone mention send
loads membership and profiles through one bounded authenticated relay session,
publishes, and closes it; standalone messages without mention syntax keep the
existing direct publish path.

### Directory and sender labels

OpenClaw keeps a bounded snapshot of the configured rooms, their current
relay-signed member lists, room metadata, and kind `0` member profiles. Incoming
agent context uses the current profile and room names when available, while the
sender public key remains the stable authorization, routing, and session
identity.

Inspect the same data from the CLI:

```bash
openclaw directory self --channel buzz
openclaw directory peers list --channel buzz --query "alice"
openclaw directory groups list --channel buzz --query "engineering"
openclaw directory groups members \
  --channel buzz \
  --group-id buzz:<ROOM_UUID>
```

When the Gateway is connected, directory reads reuse its authenticated Buzz
connection and in-memory snapshot. A standalone directory command opens one
bounded authenticated connection, loads the current snapshot, and closes it.
Ordinary directory errors are logged without reconnecting. If a directory or
profile subscription does not reach EOSE within 10 seconds, OpenClaw treats the
Buzz relay session as stalled and recycles only that Buzz account connection;
the Gateway keeps running.

Archived rooms are omitted from directory results and live room subscriptions.
If a configured room is archived or restored while OpenClaw is connected, the
plugin recycles only its Buzz connection so the subscription set matches the
relay's current metadata. The Gateway keeps running.

Each configured room uses one room-scoped relay subscription. OpenClaw reserves
four of Buzz's 1,024 connection subscriptions for membership notifications and
concurrent profile, membership, and metadata queries, so one account can
configure up to 1,020 rooms. Near that limit, optional member profile
subscriptions are reduced first; directory entries continue to work with stable
public keys and deterministic fallback labels.

Unique current room names can resolve as outbound targets through OpenClaw's
shared directory lookup. The canonical `buzz:<ROOM_UUID>` target remains the
safest choice for automation and for rooms with duplicate names.

### Route rooms to different agents

Standard OpenClaw bindings can send each Buzz room to a different agent,
workspace, or model while one Gateway and Buzz bot serve all of them:

```json5
{
  agents: {
    entries: {
      support: { default: true, workspace: "~/.openclaw/workspace-support" },
      engineering: { workspace: "~/.openclaw/workspace-engineering" },
    },
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

Buzz applies two independent controls:

- **Require mentions**: the agent responds only when the bot is mentioned.
- **Sender access**: allow every current member of an approved room, disable
  room ingress, or additionally restrict room members to selected Buzz public
  keys.

Fresh guided setup allows normal messages from current members of the selected
rooms. OpenClaw loads Buzz's relay-signed room roster before accepting messages,
checks membership in memory before persistent dedupe or agent work, and refreshes
the roster after Buzz membership-change events. There is no per-message relay
query or Gateway polling.

Use `groupPolicy: "allowlist"` with `groupAllowFrom` in manual configuration
when only specific room members should be able to activate the agent.
Each room can override `groupPolicy`, `groupAllowFrom`, or both. An omitted room
setting inherits the account-wide value; an explicitly empty room allowlist
denies every sender when its effective policy is `"allowlist"`.
Set `requireMention: true` only when the Buzz client used by those members can
address the bot identity.

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
      name: "OpenClaw",
      relayUrl: "wss://buzz.example.com",
      privateKey: "nsec1...",
      groupPolicy: "open",
      groups: {
        "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c": {
          requireMention: false,
        },
      },
      defaultTo: "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c",
    },
  },
}
```

For a narrower sender policy:

```json5
{
  channels: {
    buzz: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["<64_CHARACTER_HEX_SENDER_PUBLIC_KEY>"],
    },
  },
}
```

To restrict one room while keeping other configured rooms open:

```json5
{
  channels: {
    buzz: {
      groupPolicy: "open",
      groups: {
        "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c": {
          groupPolicy: "allowlist",
          groupAllowFrom: ["<64_CHARACTER_HEX_SENDER_PUBLIC_KEY>"],
        },
      },
    },
  },
}
```

Room UUIDs are the canonical targets. Use the UUID shown during discovery or ask
a room admin for it. A unique current room name can resolve through the live
directory, but automation should use `buzz:<ROOM_UUID>` to avoid ambiguity.

For manual configuration, `groupAllowFrom` entries must use the 64-character
hexadecimal form.

### Bot key storage

The default guided path reuses the current bot identity or generates a private
key and stores it in `channels.buzz.privateKey`, following OpenClaw's current
plaintext config convention.

For an existing key, setup can use plaintext or an existing `env`, `file`, or
`exec` SecretRef. See [Secrets management](/gateway/secrets) for provider setup.
The default account can also read:

```bash
export BUZZ_RELAY_URL="wss://buzz.example.com"
export BUZZ_PRIVATE_KEY="nsec1..."
```

If a hosted workspace operator gives you an identity authorization value, set
`channels.buzz.authTag` or `BUZZ_AUTH_TAG`. It can use the same plaintext or
SecretRef forms as the private key. Treat this delegated, reusable value as a
secret: keep it out of logs, screenshots, chat, and source control, and prefer a
SecretRef for persistent deployments. Request a replacement and revoke the old
value whenever the bot identity or relay authorization changes, or if either
credential may have been exposed.

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

### QA Lab round trip

Source checkouts can exercise the production Buzz channel path with two
dedicated test identities:

```bash
pnpm openclaw qa buzz \
  --credential-file /secure/path/buzz-qa-credentials.json \
  --provider-mode mock-openai
```

The command runs a real relay canary and mention-gating check while using the
deterministic mock model. The private JSON credential
file contains `relayUrl`, `roomId`, `driverPrivateKey`, and `sutPrivateKey`, plus
optional `driverAuthTag` and `sutAuthTag` values for closed relays. Both test
public keys must be room members, and the SUT public key must have the **Bot**
role. A closed relay may require both public keys to be enrolled separately.
Use `--credential-source convex` for pooled QA credentials.

Use `wss://` for hosted relays. Plaintext `ws://` credential URLs are accepted
only for loopback development relays.

Never use a human owner or admin private key. Private keys and optional
authorization values are parent-harness secrets and must not appear in logs,
artifacts, screenshots, shell history, or source control.

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
| No rooms are discovered                      | Confirm this exact bot public key is in the room with the **Bot** role, then rerun the same setup command.           |
| Authentication fails                         | Check the relay URL, bot private key, closed-relay membership, and any authorization value supplied by the operator. |
| A message cannot be sent                     | Confirm the bot is a room member with the **Bot** role and that the UUID is configured.                              |
| The bot receives messages but does not reply | Confirm the sender is still a room member, then check the optional sender allowlist and mention requirement.         |
| Setup says the Gateway is not running        | Start it with `openclaw gateway`, then run `openclaw channels status --probe`.                                       |
| Automatic room discovery expires             | Grant the Bot role, then choose Retry; the same identity remains active.                                             |

## Related

- [Channel overview](/channels)
- [Channel access controls](/channels/groups)
- [Secrets management](/gateway/secrets)
- [Channel troubleshooting](/channels/troubleshooting)
