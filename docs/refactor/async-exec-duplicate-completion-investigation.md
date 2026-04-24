---
summary: "Investigation notes for duplicate async exec completion injection"
read_when:
  - Debugging repeated node exec completion events
  - Working on heartbeat/system-event dedupe
title: "Async exec duplicate completion investigation"
---

## Scope

- Session: `agent:main:telegram:group:-1003774691294:topic:1`
- Symptom: the same async exec completion for session/run `keen-nexus` was recorded twice in LCM as user turns.
- Goal: identify whether this is most likely duplicate session injection or plain outbound delivery retry.

## Conclusion

Most likely this is **duplicate session injection**, not a pure outbound delivery retry.

The strongest gateway-side gap is in the **node exec completion path**:

1. A node-side exec finish emits `exec.finished` with the full `runId`.
2. Gateway `server-node-events` converts that into a system event and requests a heartbeat.
3. The heartbeat run injects the drained system event block into the agent prompt.
4. The embedded runner persists that prompt as a new user turn in the session transcript.

If the same `exec.finished` reaches the gateway twice for the same `runId` for any reason (replay, reconnect duplicate, upstream resend, duplicated producer), OpenClaw currently has **no idempotency check keyed by `runId`/`contextKey`** on this path. The second copy will become a second user message with the same content.

## Exact Code Path

### 1. Producer: node exec completion event

- `src/node-host/invoke.ts:340-360`
  - `sendExecFinishedEvent(...)` emits `node.event` with event `exec.finished`.
  - Payload includes `sessionKey` and full `runId`.

### 2. Gateway event ingestion

- `src/gateway/server-node-events.ts:574-640`
  - Handles `exec.finished`.
  - Builds text:
    - `Exec finished (node=..., id=<runId>, code ...)`
  - Enqueues it via:
    - `enqueueSystemEvent(text, { sessionKey, contextKey: runId ? \`exec:${runId}\` : "exec", trusted: false })`
  - Immediately requests a wake:
    - `requestHeartbeatNow(scopedHeartbeatWakeOptions(sessionKey, { reason: "exec-event" }))`

### 3. System event dedupe weakness

- `src/infra/system-events.ts:90-115`
  - `enqueueSystemEvent(...)` only suppresses **consecutive duplicate text**:
    - `if (entry.lastText === cleaned) return false`
  - It stores `contextKey`, but does **not** use `contextKey` for idempotency.
  - After drain, duplicate suppression resets.

This means a replayed `exec.finished` with the same `runId` can be accepted again later, even though the code already had a stable idempotency candidate (`exec:<runId>`).

### 4. Wake handling is not the primary duplicator

- `src/infra/heartbeat-wake.ts:79-117`
  - Wakes are coalesced by `(agentId, sessionKey)`.
  - Duplicate wake requests for the same target collapse to one pending wake entry.

This makes **duplicate wake handling alone** a weaker explanation than duplicate event ingestion.

### 5. Heartbeat consumes the event and turns it into prompt input

- `src/infra/heartbeat-runner.ts:535-574`
  - Preflight peeks pending system events and classifies exec-event runs.
- `src/auto-reply/reply/session-system-events.ts:86-90`
  - `drainFormattedSystemEvents(...)` drains the queue for the session.
- `src/auto-reply/reply/get-reply-run.ts:400-427`
  - The drained system event block is prepended into the agent prompt body.

### 6. Transcript injection point

- `src/agents/pi-embedded-runner/run/attempt.ts:2000-2017`
  - `activeSession.prompt(effectivePrompt)` submits the full prompt to the embedded PI session.
  - That is the point where the completion-derived prompt becomes a persisted user turn.

So once the same system event is rebuilt into the prompt twice, duplicate LCM user messages are expected.

## Why plain outbound delivery retry is less likely

There is a real outbound failure path in the heartbeat runner:

- `src/infra/heartbeat-runner.ts:1194-1242`
  - The reply is generated first.
  - Outbound delivery happens later via `deliverOutboundPayloads(...)`.
  - Failure there returns `{ status: "failed" }`.

However, for the same system event queue entry, this alone is **not sufficient** to explain the duplicate user turns:

- `src/auto-reply/reply/session-system-events.ts:86-90`
  - The system event queue is already drained before outbound delivery.

So a channel send retry by itself would not recreate the exact same queued event. It could explain missing/failed external delivery, but not by itself a second identical session user message.

## Secondary, lower-confidence possibility

There is a full-run retry loop in the agent runner:

- `src/auto-reply/reply/agent-runner-execution.ts:741-1473`
  - Certain transient failures can retry the whole run and resubmit the same `commandBody`.

That can duplicate a persisted user prompt **within the same reply execution** if the prompt was already appended before the retry condition triggered.

I rank this lower than duplicate `exec.finished` ingestion because:

- the observed gap was around 51 seconds, which looks more like a second wake/turn than an in-process retry;
- the report already mentions repeated message send failures, which points more toward a separate later turn than an immediate model/runtime retry.

## Root Cause Hypothesis

Highest-confidence hypothesis:

- The `keen-nexus` completion came through the **node exec event path**.
- The same `exec.finished` was delivered to `server-node-events` twice.
- Gateway accepted both because `enqueueSystemEvent(...)` does not dedupe by `contextKey` / `runId`.
- Each accepted event triggered a heartbeat and was injected as a user turn into the PI transcript.

## Proposed Tiny Surgical Fix

If a fix is wanted, the smallest high-value change is:

- make exec/system-event idempotency honor `contextKey` for a short horizon, at least for exact `(sessionKey, contextKey, text)` repeats;
- or add a dedicated dedupe in `server-node-events` for `exec.finished` keyed by `(sessionKey, runId, event kind)`.

That would directly block replayed `exec.finished` duplicates before they become session turns.

## Related

- [Exec tool](/tools/exec)
- [Session management](/concepts/session)
