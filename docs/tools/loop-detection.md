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
    list: [
      {
        id: "safe-runner",
        tools: {
          loopDetection: {
            enabled: true,
          },
        },
      },
    ],
  },
}
```

The per-agent setting overrides the global setting.

### Field behavior

| Field     | Default | Effect                                                                                            |
| --------- | ------- | ------------------------------------------------------------------------------------------------- |
| `enabled` | `false` | Master switch for the rolling-history detectors. `false` also disables the post-compaction guard. |

For `exec`, no-progress hashing compares stable command outcomes (status,
exit code, timed-out flag, output) and ignores volatile runtime metadata such
as duration, PID, session ID, and working directory. Outbound message-send
results are hashed with volatile per-call ids (message id, file id, timestamp)
stripped, so a "sent" result does not look identical to a different "sent"
result. When a run id is available, history is evaluated only within that run,
so scheduled heartbeat cycles and fresh runs do not inherit stale loop counts
from earlier runs.

## Recommended setup

- For smaller models, set `enabled: true`. Flagship models rarely need rolling-history detection and can
  leave the master switch `false` while still benefiting from the
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

- The guard never aborts while results are changing; only byte-identical
  results across the window trigger it.
- It only arms in the immediate aftermath of a compaction-retry, not at other
  points in a run.

<Note>
  The post-compaction guard runs whenever the master flag is not explicitly `false`, even if you never wrote a `tools.loopDetection` block. To verify, look for `post-compaction guard armed for N attempts` in the gateway log immediately after a compaction event.
</Note>

## Logs and expected behavior

When a loop is detected, OpenClaw logs a loop event and either warns or blocks
the next tool-cycle depending on severity, protecting against runaway token
spend and lockups while preserving normal tool access.

- Warnings come first.
- Blocking follows once a pattern persists past the warning threshold.
- Critical thresholds block the next tool-cycle and surface a clear
  loop-detection reason in the run record.
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
  <Card title="Configuration reference" href="/gateway/config-tools#toolsloopdetection" icon="gear">
    Full `tools.loopDetection` schema and merging semantics.
  </Card>
</CardGroup>
