---
summary: "Inferred follow-up memory for check-ins that are not exact reminders"
title: "Inferred commitments"
sidebarTitle: "Commitments"
read_when:
  - You want OpenClaw to remember natural follow-ups
  - You want to understand how inferred check-ins differ from reminders
  - You want to review or dismiss follow-up commitments
---

Commitments are short-lived follow-up memories. When enabled, OpenClaw can
notice that a conversation created a future check-in opportunity and remember
to bring it back later.

Examples:

- You mention an interview tomorrow. OpenClaw may check in afterward.
- You say you are exhausted. OpenClaw may ask later whether you slept.
- The agent says it will follow up after something changes. OpenClaw may track
  that open loop.

Commitments are not durable facts like `MEMORY.md`, and they are not exact
reminders. They sit between memory and automation: OpenClaw remembers a
conversation-bound obligation, then heartbeat delivers it when it is due.

## Enable commitments

Commitments are off by default. Enable them in config:

```bash
openclaw config set commitments.enabled true
openclaw config set commitments.maxPerDay 3
```

Equivalent `openclaw.json`:

```json
{
  "commitments": {
    "enabled": true,
    "maxPerDay": 3
  }
}
```

`commitments.maxPerDay` limits how many inferred follow-ups can be delivered
per agent session in a rolling day. The default is `3`.

## How it works

After an agent reply, OpenClaw may run a hidden background extraction pass in a
separate context. That pass looks only for inferred follow-up commitments. It
does not write into the visible conversation and it does not ask the main agent
to reason about the extraction.

When it finds a high-confidence candidate, OpenClaw stores a commitment with:

- the agent id
- the session key
- the original channel and delivery target
- a due window
- a short suggested check-in
- non-instructional metadata for heartbeat to decide whether to send it

Delivery happens through heartbeat. When a commitment becomes due, heartbeat
adds the commitment to the heartbeat turn for the same agent and channel scope.
The model can send one natural check-in or reply `HEARTBEAT_OK` to dismiss it.
If heartbeat is configured with `target: "none"`, due commitments remain
internal and do not send external check-ins. Commitment delivery prompts do not
replay the original conversation text, and due commitment heartbeat turns run
without OpenClaw tools.

OpenClaw never delivers an inferred commitment immediately after writing it.
The due time is clamped to at least one heartbeat interval after the commitment
is created, so the follow-up cannot echo back in the same moment it was
inferred.

## Scope

Commitments are scoped to the exact agent and channel context where they were
created. A follow-up inferred while talking to one agent in Discord is not
delivered by another agent, another channel, or an unrelated session.

This scope is part of the feature. Natural check-ins should feel like the same
conversation continuing, not like a global reminder system.

## Commitments vs reminders

| Need                                            | Use                                      |
| ----------------------------------------------- | ---------------------------------------- |
| "Remind me at 3 PM"                             | [Scheduled tasks](/automation/cron-jobs) |
| "Ping me in 20 minutes"                         | [Scheduled tasks](/automation/cron-jobs) |
| "Run this report every weekday"                 | [Scheduled tasks](/automation/cron-jobs) |
| "I have an interview tomorrow"                  | Commitments                              |
| "I was up all night"                            | Commitments                              |
| "Follow up if I do not answer this open thread" | Commitments                              |

Exact user requests already belong to the scheduler path. Commitments are only
for inferred follow-ups: the moments where the user did not ask for a reminder,
but the conversation clearly created a useful future check-in.

## Manage commitments

Use the CLI to inspect and clear stored commitments:

```bash
openclaw commitments
openclaw commitments --all
openclaw commitments --agent main
openclaw commitments --status snoozed
openclaw commitments dismiss cm_abc123
```

See [`openclaw commitments`](/cli/commitments) for the command reference.

## Privacy and cost

Commitment extraction uses an LLM pass, so enabling it adds background model
usage after eligible turns. The pass is hidden from the user-visible
conversation, but it can read the recent exchange needed to decide whether a
follow-up exists.

Stored commitments are local OpenClaw state. They are operational memory, not
long-term memory. Disable the feature with:

```bash
openclaw config set commitments.enabled false
```

## Troubleshooting

If expected follow-ups are not appearing:

- Confirm `commitments.enabled` is `true`.
- Check `openclaw commitments --all` for pending, dismissed, snoozed, or expired
  records.
- Make sure heartbeat is running for the agent.
- Check whether `commitments.maxPerDay` has already been reached for that
  agent session.
- Remember that exact reminders are skipped by commitment extraction and should
  appear under [scheduled tasks](/automation/cron-jobs) instead.

## Related

- [Memory overview](/concepts/memory)
- [Active memory](/concepts/active-memory)
- [Heartbeat](/gateway/heartbeat)
- [Scheduled tasks](/automation/cron-jobs)
- [`openclaw commitments`](/cli/commitments)
- [Configuration reference](/gateway/configuration-reference#commitments)
