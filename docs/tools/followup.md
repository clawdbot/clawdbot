---
summary: "Queue one later turn without changing the session queue mode"
read_when:
  - Using /followup while an agent is already running
  - Comparing one-off followups with /queue followup
title: "Followup"
sidebarTitle: "Followup"
---

`/followup` queues one message for a separate agent turn after the current run
ends. It does not change the session's stored `/queue` mode.

## Current session

Use top-level `/followup` when the current run should finish before OpenClaw
starts a separate turn:

```text
/followup when you finish, explain why you chose that approach
```

Behavior:

- Targets the current session.
- Applies `followup` mode only to the supplied message.
- Leaves the session's stored `/queue` mode unchanged.
- Starts normally when the session is idle.

This avoids changing the session to `/queue followup`, sending one message,
and then changing it back to `/queue steer`.

## Followup vs queue

Use:

- `/followup <message>` when one message should wait for a later turn.
- `/queue followup` when future normal messages should all wait for later turns.
- `/queue steer` when future normal messages should guide active runs by default.
- `/steer <message>` when one message should guide the active run now.

If an installed skill already uses the name `followup`, that skill keeps the
direct `/followup` command after upgrade. Use `/skill followup [input]` as its
stable explicit form. In that workspace, use the session-level `/queue`
sequence for queue followups; OpenClaw does not silently take the existing
skill command away.

The explicit `/followup` command is Gateway-backed. In `openclaw chat` or
`openclaw tui --local`, select `/queue followup`, send the message, and restore
the preferred mode afterward.

## Related

- [Slash commands](/tools/slash-commands)
- [Command queue](/concepts/queue)
- [Steer](/tools/steer)
