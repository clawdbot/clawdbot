import { beforeEach, describe, expect, it } from "vitest";
import { onDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticArgumentChurnObservation,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
} from "../logging/diagnostic-run-activity.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../logging/diagnostic-session-state.js";
import { runBeforeToolCallHook } from "./agent-tools.before-tool-call.policy.js";
import {
  clearBatchAdmittedToolCallsForRun,
  consumeBatchAdmittedToolCall,
  resetAdjustedParamsByToolCallIdForTests,
} from "./agent-tools.before-tool-call.state.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import { admitToolCallBatch } from "./tool-loop-admission.js";
import { recordToolCall, recordToolCallOutcome } from "./tool-loop-detection.js";

const ctx = {
  agentId: "main",
  sessionKey: "tool-loop-admission",
  sessionId: "session-1",
  runId: "run-1",
  loopDetection: { enabled: true },
} satisfies HookContext;

function call(id: string, name: string, args: Record<string, unknown>) {
  return {
    toolCall: { type: "toolCall" as const, id, name, arguments: args },
    args,
  };
}

describe("whole-batch tool-loop admission", () => {
  beforeEach(() => {
    resetDiagnosticRunActivityForTest();
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    resetAdjustedParamsByToolCallIdForTests();
  });

  it("returns a typed critical intervention and records only veto evidence", async () => {
    const state = getDiagnosticSessionState({
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
    });
    const pollArgs = { action: "poll", sessionId: "process-1" };
    for (let index = 0; index < 20; index += 1) {
      const toolCallId = `prior-${index}`;
      recordToolCall(state, "process", pollArgs, toolCallId, ctx.loopDetection, {
        runId: ctx.runId,
      });
      recordToolCallOutcome(state, {
        toolName: "process",
        toolParams: pollArgs,
        toolCallId,
        result: {
          content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
          details: { status: "running" },
        },
        config: ctx.loopDetection,
        runId: ctx.runId,
      });
    }

    const unrelatedSiblings = Array.from({ length: 20 }, (_, index) =>
      call(`safe-sibling-${index}`, "write", {}),
    );
    const admission = await admitToolCallBatch(
      [...unrelatedSiblings, call("repeated", "process", pollArgs)],
      ctx,
    );

    expect(admission).toMatchObject({
      intervention: {
        kind: "critical-tool-loop",
        toolCallId: "repeated",
        toolName: "process",
        detector: "known_poll_no_progress",
        count: 20,
      },
    });
    expect(state.toolCallHistory).toHaveLength(21);
    expect(state.toolCallHistory?.at(-1)).toMatchObject({
      toolName: "process",
      outcomeKind: "tool-loop-veto",
    });
    expect(consumeBatchAdmittedToolCall("safe-sibling-0", ctx.runId)).toBe(false);
    await expect(admitToolCallBatch([call("recovery-write", "write", {})], ctx)).resolves.toEqual(
      expect.objectContaining({
        commitReadyCalls: expect.any(Function),
        releaseSkippedCalls: expect.any(Function),
      }),
    );
  });

  it("blocks a batch that crosses the critical threshold within its own candidates", async () => {
    const state = getDiagnosticSessionState({
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
    });
    const pollArgs = { action: "poll", sessionId: "process-2" };
    for (let index = 0; index < 19; index += 1) {
      const toolCallId = `prior-${index}`;
      recordToolCall(state, "process", pollArgs, toolCallId, ctx.loopDetection, {
        runId: ctx.runId,
      });
      recordToolCallOutcome(state, {
        toolName: "process",
        toolParams: pollArgs,
        toolCallId,
        result: {
          content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
          details: { status: "running" },
        },
        config: ctx.loopDetection,
        runId: ctx.runId,
      });
    }

    const admission = await admitToolCallBatch(
      [call("candidate-20", "process", pollArgs), call("candidate-21", "process", pollArgs)],
      ctx,
    );

    expect(admission).toMatchObject({
      intervention: {
        kind: "critical-tool-loop",
        toolCallId: "candidate-21",
        detector: "known_poll_no_progress",
        count: 20,
      },
    });
    expect(state.toolCallHistory).toHaveLength(21);
    expect(consumeBatchAdmittedToolCall("candidate-20", ctx.runId)).toBe(false);
    await expect(
      admitToolCallBatch([call("recovery-repeat", "process", pollArgs)], ctx),
    ).resolves.toMatchObject({
      intervention: {
        kind: "critical-tool-loop",
        toolCallId: "recovery-repeat",
        detector: "known_poll_no_progress",
      },
    });
  });

  it("records an admitted call once and skips only its duplicate single-call loop policy", async () => {
    const admitted = call("admitted", "read", { path: "/tmp/a" });

    const admission = await admitToolCallBatch([admitted], ctx);
    admission.commitReadyCalls?.([{ toolCallId: admitted.toolCall.id, args: admitted.args }]);
    await expect(
      runBeforeToolCallHook({
        toolName: admitted.toolCall.name,
        params: admitted.args,
        toolCallId: admitted.toolCall.id,
        ctx,
      }),
    ).resolves.toMatchObject({ blocked: false });

    const state = getDiagnosticSessionState({
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
    });
    expect(state.toolCallHistory).toHaveLength(1);
    expect(consumeBatchAdmittedToolCall(admitted.toolCall.id, ctx.runId)).toBe(false);
  });

  it("leaves an established churn lease intact until an admitted escape call completes", async () => {
    markDiagnosticEmbeddedRunStarted({
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
      runId: ctx.runId,
    });
    markDiagnosticArgumentChurnObservation({
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
      runId: ctx.runId,
      active: true,
      now: 1,
    });

    const admitted = call("pending-read-escape", "read", { path: "/tmp/a" });
    const admission = await admitToolCallBatch([admitted], ctx);
    admission.commitReadyCalls?.([{ toolCallId: admitted.toolCall.id, args: admitted.args }]);

    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
      }),
    ).toMatchObject({
      lastProgressReason: "tool_loop:argument_churn",
    });
  });

  it("cleans an admitted marker when a run ends before the wrapped tool consumes it", async () => {
    const admitted = call("blocked-later", "write", {});
    await admitToolCallBatch([admitted], ctx);

    clearBatchAdmittedToolCallsForRun(ctx.runId);

    expect(consumeBatchAdmittedToolCall(admitted.toolCall.id, ctx.runId)).toBe(false);
  });

  it("releases repeated skipped admissions without mutating bounded history", async () => {
    const state = getDiagnosticSessionState({
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
    });
    for (let index = 0; index < 30; index += 1) {
      recordToolCall(state, "read", { path: `/tmp/prior-${index}` }, `prior-${index}`);
    }
    const originalHistory = [...(state.toolCallHistory ?? [])];
    const diagnosticEvents: unknown[] = [];
    const unsubscribe = onDiagnosticEvent((event) => diagnosticEvents.push(event));

    try {
      for (let index = 0; index < 25; index += 1) {
        const skipped = call(`skipped-${index}`, "write", { path: "/tmp/skipped" });
        const admission = await admitToolCallBatch([skipped], ctx);
        admission.releaseSkippedCalls?.([skipped.toolCall.id]);
        expect(consumeBatchAdmittedToolCall(skipped.toolCall.id, ctx.runId)).toBe(false);
      }
    } finally {
      unsubscribe();
    }

    expect(state.toolCallHistory).toEqual(originalHistory);
    expect(diagnosticEvents).toEqual([]);
    const executed = call("executed", "write", { path: "/tmp/skipped" });
    const admission = await admitToolCallBatch([executed], ctx);
    admission.commitReadyCalls?.([{ toolCallId: executed.toolCall.id, args: executed.args }]);
    admission.releaseSkippedCalls?.([]);

    expect(state.toolCallHistory).toHaveLength(30);
    expect(state.toolCallHistory?.at(-1)).toMatchObject({
      runId: ctx.runId,
      toolCallId: executed.toolCall.id,
      toolName: executed.toolCall.name,
    });
    expect(consumeBatchAdmittedToolCall(executed.toolCall.id, ctx.runId)).toBe(true);
    expect(consumeBatchAdmittedToolCall(executed.toolCall.id, ctx.runId)).toBe(false);
  });

  it("commits ready siblings in assistant order and releases exact run markers", async () => {
    const otherRun = { ...ctx, runId: "run-2" };
    const sharedId = "shared-call";
    const first = call("first", "read", { path: "/tmp/first" });
    const skipped = call(sharedId, "write", { path: "/tmp/skipped" });
    const last = call("last", "read", { path: "/tmp/last" });
    const otherAdmission = await admitToolCallBatch(
      [call(sharedId, "read", { path: "/tmp/other" })],
      otherRun,
    );
    const admission = await admitToolCallBatch([first, skipped, last], ctx);

    admission.commitReadyCalls?.([
      { toolCallId: last.toolCall.id, args: last.args },
      { toolCallId: first.toolCall.id, args: first.args },
    ]);
    admission.releaseSkippedCalls?.([skipped.toolCall.id]);

    const state = getDiagnosticSessionState({
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
    });
    expect(state.toolCallHistory?.slice(-2).map((record) => record.toolCallId)).toEqual([
      first.toolCall.id,
      last.toolCall.id,
    ]);
    expect(consumeBatchAdmittedToolCall(skipped.toolCall.id, ctx.runId)).toBe(false);
    expect(consumeBatchAdmittedToolCall(sharedId, otherRun.runId)).toBe(true);
    otherAdmission.releaseSkippedCalls?.([sharedId]);
  });
});
