/**
 * Real-runtime behavior proof for openclaw-q7i.
 *
 * Bug: the Claude app-server runtime captured `item/reasoning/delta`
 * notifications into `ProjectorAccumulator.reasoning` (used for `/status`
 * and diagnostics) but never called the `onReasoningStream`/`onReasoningEnd`
 * callback pair that channel delivery (Discord/Slack/Telegram/MS Teams/
 * Mattermost/Feishu, and the auto-reply dispatcher) actually listens on to
 * render live thinking. It only emitted a generic
 * `emitAgentEvent({stream: "reasoning", ...})`, a tag the shared
 * `AgentEventStream` union doesn't recognize (`"thinking"` is the canonical
 * value) and that nothing on the delivery path consumes. Net effect: Claude
 * turns never showed reasoning in any channel regardless of `/reasoning on`
 * or `reasoningDefault` config, while Codex turns (which use this same
 * callback pair — see `extensions/codex/src/app-server/
 * event-projector-reasoning.ts`) did.
 *
 * This script does NOT use vitest and does NOT mock the seam under test. It
 * drives the REAL production `ClaudeAppServerEventProjector` (the class whose
 * `handleReasoningDelta` / `handleTurnCompleted` the fix changed) through
 * realistic RPC notifications, with real `onReasoningStream`/`onReasoningEnd`
 * callback functions capturing what they were called with. The only thing
 * stubbed is the `EmbeddedRunAttemptParams` shell (the projector only reads
 * `runId`/`onAgentEvent`/`onReasoningStream`/`onReasoningEnd` off it), which
 * is not the seam under test.
 *
 * It exercises three scenarios:
 *
 *   1. Two reasoning deltas stream in, then the turn completes. Confirms
 *      onReasoningStream fires once per delta with the correctly accumulated
 *      snapshot text (isReasoningSnapshot: true, matching Codex's contract),
 *      and onReasoningEnd fires exactly once, after streaming, at
 *      turn/completed.
 *
 *   2. A turn with tool calls and a final reply but NO reasoning deltas.
 *      Confirms onReasoningStream never fires and onReasoningEnd is not
 *      called — a no-reasoning turn should not open/close an empty
 *      reasoning block in the channel.
 *
 *   3. The pre-fix steady state, without the callbacks at all
 *      (onReasoningStream/onReasoningEnd left undefined on params, as every
 *      real caller's EmbeddedRunAttemptParams would be for a harness that
 *      never wired them). Confirms the projector still accumulates
 *      acc.reasoning correctly and does not throw when the optional
 *      callbacks are absent — proving the fix is additive, not a replacement
 *      for the existing diagnostic accumulation path.
 *
 * Run with:
 *   pnpm tsx scripts/proof-claude-reasoning-stream.ts
 */

import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  ClaudeAppServerEventProjector,
  type ProjectorAccumulator,
} from "../extensions/claude/src/app-server/event-projector.js";
import type { RpcNotification } from "../extensions/claude/src/app-server/types.js";

const TURN_ID = "turn_proof_q7i";

function emptyAcc(): ProjectorAccumulator {
  return {
    assistantTexts: [],
    toolMetas: [],
    reasoning: "",
    itemCount: 0,
    toolCalls: new Map(),
  };
}

function makeProjector(
  acc: ProjectorAccumulator,
  reasoningCallbacks?: {
    onReasoningStream?: (payload: { text: string; isReasoningSnapshot?: boolean }) => void;
    onReasoningEnd?: () => void;
  },
): ClaudeAppServerEventProjector {
  const params = {
    runId: "run_proof",
    onAgentEvent: undefined,
    ...reasoningCallbacks,
  } as unknown as EmbeddedRunAttemptParams;
  return new ClaudeAppServerEventProjector(TURN_ID, acc, params, {
    runId: "run_proof",
    agentId: "tank",
    sessionId: "s_proof",
    sessionKey: "agent:tank:proof",
    channelId: "proof",
  });
}

function notif(method: string, params: Record<string, unknown>): RpcNotification {
  return { jsonrpc: "2.0", method, params } as RpcNotification;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

function eq(a: unknown, b: unknown, msg: string): void {
  assert(
    JSON.stringify(a) === JSON.stringify(b),
    `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`,
  );
}

// ── Scenario 1: reasoning streams, then turn completes ────────────────────
{
  const acc = emptyAcc();
  const streamed: Array<{ text: string; isReasoningSnapshot?: boolean }> = [];
  let endCalls = 0;
  const projector = makeProjector(acc, {
    onReasoningStream: (p) => streamed.push(p),
    onReasoningEnd: () => (endCalls += 1),
  });

  projector.processNotification(
    notif("item/reasoning/delta", { turnId: TURN_ID, delta: "Let me check " }),
  );
  projector.processNotification(
    notif("item/reasoning/delta", { turnId: TURN_ID, delta: "the config first." }),
  );
  eq(
    streamed,
    [
      { text: "Let me check ", isReasoningSnapshot: true },
      { text: "Let me check the config first.", isReasoningSnapshot: true },
    ],
    "S1: onReasoningStream fires per delta with accumulated snapshot text",
  );
  eq(endCalls, 0, "S1: onReasoningEnd has not fired mid-stream");

  projector.processNotification(
    notif("turn/completed", {
      turnId: TURN_ID,
      turn: { id: TURN_ID, status: "completed", items: [] },
    }),
  );
  eq(endCalls, 1, "S1: onReasoningEnd fires exactly once at turn/completed");
  projector.finalize();
  eq(
    acc.reasoning,
    "Let me check the config first.",
    "S1: acc.reasoning still populated (diagnostics unaffected)",
  );
  console.log(
    "✓ S1 reasoning streams + ends correctly:",
    streamed.length,
    "deltas,",
    endCalls,
    "end call",
  );
}

// ── Scenario 2: no reasoning at all — no spurious open/close ──────────────
{
  const acc = emptyAcc();
  const streamed: Array<{ text: string; isReasoningSnapshot?: boolean }> = [];
  let endCalls = 0;
  const projector = makeProjector(acc, {
    onReasoningStream: (p) => streamed.push(p),
    onReasoningEnd: () => (endCalls += 1),
  });

  projector.processNotification(
    notif("item/started", { turnId: TURN_ID, item: { id: "t1", type: "shell" } }),
  );
  projector.processNotification(
    notif("item/completed", { turnId: TURN_ID, item: { id: "t1", type: "shell", result: "ok" } }),
  );
  projector.processNotification(
    notif("turn/completed", {
      turnId: TURN_ID,
      turn: {
        id: TURN_ID,
        status: "completed",
        items: [{ type: "agentMessage", text: "done" }],
      },
    }),
  );
  eq(streamed, [], "S2: onReasoningStream never fires without reasoning deltas");
  eq(endCalls, 0, "S2: onReasoningEnd is not called on a no-reasoning turn");
  console.log("✓ S2 no-reasoning turn → no onReasoningStream/onReasoningEnd calls");
}

// ── Scenario 3: callbacks absent (every real pre-fix caller shape) ─────────
{
  const acc = emptyAcc();
  const projector = makeProjector(acc); // no reasoningCallbacks at all
  projector.processNotification(
    notif("item/reasoning/delta", { turnId: TURN_ID, delta: "thinking " }),
  );
  projector.processNotification(
    notif("item/reasoning/delta", { turnId: TURN_ID, delta: "quietly" }),
  );
  projector.processNotification(
    notif("turn/completed", {
      turnId: TURN_ID,
      turn: { id: TURN_ID, status: "completed", items: [] },
    }),
  );
  projector.finalize();
  eq(
    acc.reasoning,
    "thinking quietly",
    "S3: acc.reasoning still accumulates with callbacks absent",
  );
  console.log("✓ S3 callbacks absent → no throw, acc.reasoning still accumulates:", acc.reasoning);
}

console.log("\nAll runtime assertions passed.");
