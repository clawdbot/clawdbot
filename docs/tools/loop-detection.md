---
summary: "How to enable guardrails that detect repetitive tool-call loops"
title: "Tool-loop detection"
read_when:
  - A user reports agents getting stuck repeating tool calls
  - You need to control repetitive-call protection
  - You are editing agent tool/runtime policies
  - You hit `compaction_loop_persisted` aborts after a context-overflow retry
---

OpenClaw has three cooperating guardrails against runaway loop behavior, all
configured under `tools.loopDetection`:

1. **RunLoop guards** (opt-in) - three hard cutoffs inside
   the agent-core run loop: a maximum assistant-turn count, a maximum
   consecutive all-error tool batches, and a maximum identical repeated tool
   call. They end the run gracefully instead of burning tokens. Each guard
   activates independently when its key (`turnLimit`,
   `maxConsecutiveErrorBatches`, `maxIdleRepeatCalls`) is explicitly set in
   the block; `enabled: true` alone does NOT engage the hard cutoffs — it
   only activates the rolling-history detectors. With no block or with
   `enabled` unset, behavior is unchanged from the pre-guard build.
2. **Loop detection** (`enabled`) - disabled by default. Watches the rolling
   tool-call history for repeated patterns and unknown-tool retries. Engages
   only when `enabled: true`.
3. **Post-compaction guard** - separate from the runLoop guards: arms
   whenever `enabled` is not explicitly `false` (including when `enabled` is
   unset or when no `tools.loopDetection` block exists). Arms after every
   compaction-retry and aborts the run if the agent repeats the same
   `(tool, args, result)` triple within the window.

Set `tools.loopDetection.enabled: false` to silence all of them. Set
`tools.loopDetection.enabled: true` to activate the rolling-history
detectors; to engage the runLoop hard cutoffs, also set at least one guard
key (`turnLimit`, `maxConsecutiveErrorBatches`, `maxIdleRepeatCalls`). The
post-compaction guard is already active by default.

## Why this exists

- Detect repetitive sequences that make no progress.
- Detect high-frequency no-result loops (same tool, same inputs, repeated
  errors).
- Detect specific repeated-call patterns for known polling tools.
- Break context-overflow -> compaction -> same-loop cycles instead of letting
  them run indefinitely.
- Bound turns even when a loop hides inside **successful** tool output (e.g.
  an HTTP 429 masked as a normal response) - the idle-repeat guard keys on the
  tool name and arguments only, never on results.

## Configuration block

Global setting:

```json5
{
  tools: {
    loopDetection: {
      // Master switch. `true` activates the rolling-history detectors.
      // `false` disables all layers. Unset leaves the runLoop guards and
      // rolling-history detectors off, but the post-compaction guard stays
      // active. To engage the runLoop hard cutoffs, set at least one guard
      // key below — `enabled: true` alone does NOT activate hard cutoffs.
      enabled: true,
      // Each guard activates independently when its key is set:
      turnLimit: 200,
      maxConsecutiveErrorBatches: 3,
      maxIdleRepeatCalls: 3,
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
            turnLimit: 50,
          },
        },
      },
    },
  },
}
```

The per-agent setting overrides the global setting field by field.

You can also enable the global rolling-history detectors in **Settings -> Labs** in the Control UI.

### Field behavior

| Field                        | Default | Effect                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                    | unset   | Master switch. `true` activates the rolling-history detectors but does NOT by itself engage the runLoop hard cutoffs. `false` disables the runLoop guards, the rolling-history detectors, and the post-compaction guard. Unset leaves the runLoop guards and rolling-history detectors off, but the post-compaction guard stays active. |
| `turnLimit`                  | unset   | Maximum assistant turns in one run before graceful termination (agent-core `maxTurns`). Activates the turn guard only when this key is explicitly set; `200` is a recommended starting point.                                                                                                                                           |
| `maxConsecutiveErrorBatches` | unset   | Maximum consecutive tool batches in which every call errored; any successful result resets the streak. Activates the error-batch guard only when this key is explicitly set; `3` is a recommended starting point.                                                                                                                       |
| `maxIdleRepeatCalls`         | unset   | Maximum consecutive tool calls with the same name and identical arguments; fires even when results succeed. Activates the idle-repeat guard only when this key is explicitly set; `3` is a recommended starting point.                                                                                                                  |

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

## RunLoop guards

The three runLoop guards live in the agent-core loop that drives main,
embedded, worker, and sub-agent runs. They are **opt-in**: each guard
activates independently when its key (`turnLimit`,
`maxConsecutiveErrorBatches`, `maxIdleRepeatCalls`) is explicitly set in
the block, with the configured positive integer values. `enabled: true`
alone does NOT engage the hard
cutoffs — it only activates the rolling-history detectors. With no
`tools.loopDetection` block, or with `enabled` unset, every guard stays off
and runtime behavior is unchanged from the pre-guard build.
`tools.loopDetection.enabled: false` disables all three.

- **Turn limit** (`turnLimit` / `maxTurns`): counts assistant responses in one
  run. Reaching the limit stops the run with a terminal assistant message
  instead of making another provider request, so no extra tokens are burned.
- **Consecutive error batches** (`maxConsecutiveErrorBatches`): counts tool
  batches in which _every_ finalized call errored. Any successful result (or a
  turn without tool calls) resets the streak. Calls skipped because a steering
  message interrupted the batch are not tool failures and are excluded from
  the count, so consecutive steering interruptions never trip this guard.
- **Idle repeats** (`maxIdleRepeatCalls`): counts consecutive tool calls with
  the same name and byte-identical arguments (stable-stringified). The streak
  resets when the name or arguments change. Results are deliberately ignored,
  so a "successful" output that hides a failure still cannot spin forever.
  Repeats are counted per observed model decision: multiple identical calls
  inside one assistant message (a concurrent parallel batch) count as a single
  occurrence, because no result or retry interval separates them - the streak
  only builds when the identical call repeats across turns, each a provider
  round trip after the model saw the previous result. A turn with no tool
  calls at all neither extends nor resets any streak - the model made no
  repeat decision - so an intervening text-only turn does not mask an idle
  loop.

Guard state is scoped to a single run: continuations and new runs start with a
fresh budget (same semantics as the tool-loop recovery allowance). Termination
is graceful - the run ends with a terminal assistant message and an
`agent_end` event. Steering or follow-up input that was drained into the loop
but not yet processed is **re-enqueued**, so it is not lost: the next run
picks it up.

```json5
{
  tools: {
    loopDetection: {
      enabled: true, // rolling-history detectors
      turnLimit: 50, // tight budget for long-lived background agents
      maxConsecutiveErrorBatches: 2,
      maxIdleRepeatCalls: 3,
    },
  },
}
```

## Product policy: runLoop guards are opt-in

The runLoop guards are opt-in. With no `tools.loopDetection` block configured (global or per-agent), or with
`enabled` unset, every guard stays disabled and runtime behavior is unchanged
from the pre-guard build. Each guard activates independently when its key
(`turnLimit`, `maxConsecutiveErrorBatches`, `maxIdleRepeatCalls`) is
explicitly set; `enabled: true` alone does NOT engage the hard cutoffs — it
only activates the rolling-history detectors, preserving the upgrade contract
for existing configurations. `enabled: false` is the explicit opt-out.

- **Default state:** guards disabled. Existing native sessions behave exactly
  as before upgrade — no `tools.loopDetection` block is needed to preserve
  pre-guard behavior, and no hard cutoff activates without an explicit guard
  key.
- **Opt-in:** set at least one guard key (`turnLimit`,
  `maxConsecutiveErrorBatches`, `maxIdleRepeatCalls`) in
  `tools.loopDetection` (global or per-agent at
  `agents.entries.*.tools.loopDetection`) to activate that guard with its
  configured positive integer value.
- **Opt-out:** `tools.loopDetection.enabled: false` (or simply omitting any
  guard key) is the supported escape hatch. Setting `enabled: false`
  disables the runLoop guards, the rolling-history detectors, and the
  post-compaction guard for that scope (global or per-agent).
- **Overrides:** per-key values (`turnLimit`,
  `maxConsecutiveErrorBatches`, `maxIdleRepeatCalls`) tighten or relax the
  guard; per-agent `agents.entries.*.tools.loopDetection` overrides apply
  field by field on top of the global block.

## Recommended setup

- Add a `tools.loopDetection` block with at least one guard key set when you
  want the guardrails: e.g. `turnLimit: 200` activates the turn guard at the
  explicit value; set `maxIdleRepeatCalls: 3` and
  `maxConsecutiveErrorBatches: 3` to engage all three guards.
- Set `enabled: true` inside the block to also activate the rolling-history
  detectors. `enabled: true` alone does NOT engage the runLoop hard cutoffs
  — at least one guard key is required.
- Lower `turnLimit` for long-lived background agents where a runaway would be
  most expensive.
- To disable everything — runLoop guards, rolling-history detectors, and the
  post-compaction guard — set `tools.loopDetection.enabled: false` explicitly.

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
