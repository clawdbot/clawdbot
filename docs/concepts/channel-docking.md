---
summary: "Move one OpenClaw session's reply route between linked chat channels"
title: "Channel docking"
read_when:
  - You want replies for one active session to move from Telegram to Discord, Slack, Mattermost, or another linked channel
  - You are configuring session.identityLinks for cross-channel direct messages
  - A /dock command says the sender is not linked or no active session exists
---

Channel docking is call forwarding for one OpenClaw session.

It keeps the same conversation context, but changes where future replies for
that session are delivered.

## Example

Alice can message OpenClaw on Telegram and Discord:

```json5
{
  session: {
    identityLinks: {
      alice: ["telegram:123", "discord:456"],
    },
  },
}
```

If Alice sends this from Telegram:

```text
/dock_discord
```

OpenClaw keeps the current session context and changes the reply route:

| Before docking               | After `/dock_discord`       |
| ---------------------------- | --------------------------- |
| Replies go to Telegram `123` | Replies go to Discord `456` |

The session is not recreated. The transcript history stays attached to the
same session.

## Why use it

Use docking when a task starts in one chat app but the next replies should land
somewhere else.

Common flow:

1. Start an agent task from Telegram.
2. Move to Discord where you are coordinating work.
3. Send `/dock_discord` from the Telegram session.
4. Keep the same OpenClaw session, but receive future replies in Discord.

## Required config

Docking requires `session.identityLinks`. The source sender and target peer
must be in the same identity group:

```json5
{
  session: {
    identityLinks: {
      alice: ["telegram:123", "discord:456", "slack:U123"],
    },
  },
}
```

The values are channel-prefixed peer ids:

| Value          | Meaning                      |
| -------------- | ---------------------------- |
| `telegram:123` | Telegram sender id `123`     |
| `discord:456`  | Discord direct peer id `456` |
| `slack:U123`   | Slack user id `U123`         |

The canonical key (`alice` above) is only the shared identity group name. Dock
commands use the channel-prefixed values to prove that the source sender and
target peer are the same person.

## Commands

Dock commands are generated from loaded channel plugins that support native
commands. Current bundled commands:

| Target channel | Command            | Alias              |
| -------------- | ------------------ | ------------------ |
| Discord        | `/dock-discord`    | `/dock_discord`    |
| Mattermost     | `/dock-mattermost` | `/dock_mattermost` |
| Slack          | `/dock-slack`      | `/dock_slack`      |
| Telegram       | `/dock-telegram`   | `/dock_telegram`   |

The underscore aliases are useful on native command surfaces such as Telegram.

## What changes

Docking updates the active session delivery fields:

| Session field   | Example after `/dock_discord`            |
| --------------- | ---------------------------------------- |
| `lastChannel`   | `discord`                                |
| `lastTo`        | `456`                                    |
| `lastAccountId` | the target channel account, or `default` |

Those fields are persisted in the session store and used by later reply
delivery for that session.

## What does not change

Docking does not:

- create channel accounts
- connect a new Discord, Telegram, Slack, or Mattermost bot
- grant access to a user
- bypass channel allowlists or DM policies
- move transcript history to another session
- make unrelated users share a session

It only changes the delivery route for the current session.

## Troubleshooting

**The command says the sender is not linked.**

Add both the current sender and the target peer to the same
`session.identityLinks` group. For example, if Telegram sender `123` should dock
to Discord peer `456`, include both `telegram:123` and `discord:456`.

**The command says no active session exists.**

Dock from an existing direct-chat session. The command needs an active session
entry so it can persist the new route.

**Replies still go to the old channel.**

Check that the command replied with a success message, and confirm the target
peer id matches the id used by that channel. Docking only changes the active
session route; another session may still route elsewhere.

**I need to switch back.**

Send the matching command for the original channel, such as `/dock_telegram` or
`/dock-telegram`, from a linked sender.
