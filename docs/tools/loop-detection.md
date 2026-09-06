---
summary: "How to enable guardrails that detect repetitive tool-call loops"
title: "Tool-loop detection"
read_when:
  - A user reports agents getting stuck repeating tool calls
  - You need to control repetitive-call protection
  - You are editing agent tool/runtime policies
  - You hit `compaction_loop_persisted` aborts after a context-overflow retry
---

OpenClaw has two cooperating guardrails against repetitive tool-call patterns,
both configured under `tools.loopDetection`:

1. **Loop detection** (`enabled`) - disabled by default. Watches the rolling
   tool-call history for repeated patterns and unknown-tool retries.
2. **Post-compaction guard** - enabled whenever
   `enabled` is not explicitly `false`. Arms after every compaction-retry and
   aborts the run if the agent repeats the same `(tool, args, result)` triple
   within the window.

Set `tools.loopDetection.enabled: false` to silence both guardrails.

## Why this exists

- Detect repetitive sequences that make no progress.
- Detect high-frequency no-result loops (same tool, same inputs, repeated
  errors).
- Detect specific repeated-call patterns for known polling tools.
- Break context-overflow -> compaction -> same-loop cycles instead of letting
  them run indefinitely.

## Configuration block

Global setting:

```json5
{
  tools: {
    loopDetection: {
      enabled: false, // master switch for the rolling-history detectors
    },
  },
}
```

Per-agent override (optional, at `agents.entries.*.tools.loopDetection`):

```json5
{
  agents: {
    entries: {
      "safe-runner": {
        default: true,
        tools: {
          loopDetection: {
            enabled: true,
          },
        },
      },
    },
  },
}
```

The per-agent setting overrides the global setting.

You can also enable the global rolling-history detectors in **Settings -> Labs** in the Control UI.

### Field behavior

| Field     | Default | Effect                                                                                            |
| --------- | ------- | ------------------------------------------------------------------------------------------------- |
| `enabled` | `false` | Master switch for the rolling-history detectors. `false` also disables the post-compaction guard. |

For `exec`, no-progress hashing compares stable command outcomes (status,
exit code, timed-out flag, output) and ignores volatile runtime metadata such
as duration, PID, session ID, and working directory.
For typed terminal failures, it also ignores diagnostic timestamps, explicit
attempt or retry counters, elapsed durations, and labeled process IDs. Other
text and numbers remain significant, so a new failure cause resets the streak.
Outbound message-send results are hashed with volatile per-call ids (message id, file id, timestamp)
stripped, so delivery IDs alone do not make repeated equivalent sends look like
progress. When a run id is available, history is evaluated only within that run,
so scheduled heartbeat cycles and fresh runs do not inherit stale loop counts
from earlier runs.

Outcome comparisons also ignore fresh external-content wrapper nonces, including
wrapped errors and JSON results. Delivered security markers remain unchanged;
payload text, status, timestamps, and durations still distinguish network results.
This is a syntactic comparison: literal or copied text matching the complete
wrapper format also ignores nonce-only changes. It does not authenticate content,
change authorization, or modify delivered tool results.

## Recommended setup

- For smaller models, set `enabled: true`. Flagship models rarely need rolling-history detection and can
  leave the master switch unset while still benefiting from the
  post-compaction guard.
- To disable everything, including the post-compaction guard, set
  `tools.loopDetection.enabled: false` explicitly.

## Post-compaction guard

After a compaction-retry following a context-overflow, the runner arms a
short-window guard on the next few tool calls. If the agent emits the same
`(toolName, argsHash, resultHash)` triple enough times within that window, the guard concludes compaction did not break the
loop and aborts the run with a `compaction_loop_persisted` error.

The guard is gated by the master `tools.loopDetection.enabled` flag with one
twist: it stays **enabled when the flag is unset or `true`**, and only turns
off when the flag is explicitly `false`. This is intentional - the guard
exists to escape compaction loops that would otherwise burn unbounded tokens,
so a no-config user still gets the protection.

```json5
{
  tools: {
    loopDetection: {
      // master switch; set false to disable the guard along with the rolling detectors
      enabled: true,
    },
  },
}
```

- The guard compares normalized outcome hashes, not raw result bytes. Meaningful
  changes keep it from aborting; fresh wrapper nonces alone do not count as progress.
- It only arms in the immediate aftermath of a compaction-retry, not at other
  points in a run.

<Note>
  The post-compaction guard runs whenever the master flag is not explicitly `false`, even if you never wrote a `tools.loopDetection` block. To verify, look for `post-compaction guard armed for N attempts` in the gateway log immediately after a compaction event.
</Note>

## Per-turn send budget

Loop detection hashes the full tool arguments, so a model that re-sends the same
answer reworded produces a different hash each time and slips past it by design
(different text is a legitimately different message). To catch that pattern, the
`message` and `conversations_send` tools keep a per-turn, per-target count of
successful sends, independent of `tools.loopDetection` and its master switch.

- **Soft reminder (on by default).** From the second successful send to the same
  target within one turn, the tool result carries a one-line note reminding the
  model to finalize instead of sending another variant. The first send is never
  annotated, so ordinary single replies stay noise-free. Broadcast fan-out and
  dry runs are not counted. Set `tools.message.turnSendNudge` to `false` to
  suppress only this reminder text; the per-turn counting and the hard cap below
  keep working. The per-agent override lives at
  `agents.entries.*.tools.message.turnSendNudge`, and an unset per-agent value
  inherits the global setting.
- **Hard cap (opt-in, default off).** Set
  `tools.message.maxMessagesPerTurnPerTarget` to a positive integer to block
  sends beyond that many deliveries to the same target in one turn. The block
  happens before delivery, and the two tools report it in the two different
  shapes their result schemas allow. The `message` tool returns a suppressed
  result carrying the structured reason `turn_send_budget_exhausted`.
  `conversations_send` declares a closed result schema with no reason field, so
  it returns a suppressed result (status `suppressed`) whose block reason is in
  the human-readable text instead of a structured field. Media actions
  (`sendAttachment`, `upload-file`) and broadcast fan-out are exempt so
  legitimately split messages are never truncated. The per-agent override lives
  at `agents.entries.*.tools.message.maxMessagesPerTurnPerTarget`.

```json5
{
  tools: {
    message: {
      // Off when unset. Blocks the 3rd+ send to the same target in one turn.
      maxMessagesPerTurnPerTarget: 2,
      // On by default. Set false to drop the soft reminder while keeping counting.
      turnSendNudge: true,
    },
  },
}
```

## Logs and expected behavior

When a loop is detected, OpenClaw logs a loop event and either warns or blocks
the next tool-cycle depending on severity, protecting against runaway token
spend and lockups while preserving normal tool access.

- Warnings come first. On OpenClaw-executed tool calls, a short system note is
  appended to the affected tool result so the model can change approach before
  a critical block. Warnings share the diagnostic log's rate limit, rather than
  appearing on every repeated call. The raw outcome is recorded before the note
  is added, so warning text does not count as progress.
- Blocking follows once a pattern persists past the warning threshold.
- In the embedded agent loop, the first critical loop blocks the whole tool
  batch before any tool in that batch runs. The model then gets one more
  response with its normal tools.
- During that response, the model can answer, ask a question, or continue with
  a different tool or different arguments.
- Another critical loop in the same run blocks its whole batch and ends the
  run. A new user run starts with a fresh recovery allowance.
- The post-compaction guard emits `compaction_loop_persisted` errors naming
  the offending tool and identical-call count.

## Related

<CardGroup cols={2}>
  <Card title="Exec approvals" href="/tools/exec-approvals" icon="shield">
    Allow/deny policy for shell execution.
  </Card>
  <Card title="Thinking levels" href="/tools/thinking" icon="brain">
    Reasoning effort levels and provider-policy interaction.
  </Card>
  <Card title="Sub-agents" href="/tools/subagents" icon="users">
    Spawning isolated agents to bound runaway behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/config-tools#tools-loopdetection" icon="gear">
    Full `tools.loopDetection` schema and merging semantics.
  </Card>
</CardGroup>
