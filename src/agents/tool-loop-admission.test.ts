import { beforeEach, describe, expect, it } from "vitest";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
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
    const intervention = await admitToolCallBatch(
      [...unrelatedSiblings, call("repeated", "process", pollArgs)],
      ctx,
    );

    expect(intervention).toMatchObject({
      kind: "critical-tool-loop",
      toolCallId: "repeated",
      toolName: "process",
      detector: "known_poll_no_progress",
      count: 20,
    });
    expect(state.toolCallHistory).toHaveLength(21);
    expect(state.toolCallHistory?.at(-1)).toMatchObject({
      toolName: "process",
      outcomeKind: "tool-loop-veto",
    });
    expect(consumeBatchAdmittedToolCall("safe-sibling-0", ctx.runId)).toBe(false);
    await expect(
      admitToolCallBatch([call("recovery-write", "write", {})], ctx),
    ).resolves.toBeUndefined();
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

    const intervention = await admitToolCallBatch(
      [call("candidate-20", "process", pollArgs), call("candidate-21", "process", pollArgs)],
      ctx,
    );

    expect(intervention).toMatchObject({
      kind: "critical-tool-loop",
      toolCallId: "candidate-21",
      detector: "known_poll_no_progress",
      count: 20,
    });
    expect(state.toolCallHistory).toHaveLength(21);
    expect(consumeBatchAdmittedToolCall("candidate-20", ctx.runId)).toBe(false);
    await expect(
      admitToolCallBatch([call("recovery-repeat", "process", pollArgs)], ctx),
    ).resolves.toMatchObject({
      kind: "critical-tool-loop",
      toolCallId: "recovery-repeat",
      detector: "known_poll_no_progress",
    });
  });

  it("records an admitted call once and skips only its duplicate single-call loop policy", async () => {
    const admitted = call("admitted", "read", { path: "/tmp/a" });

    await expect(admitToolCallBatch([admitted], ctx)).resolves.toBeUndefined();
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

  it("cleans an admitted marker when a run ends before the wrapped tool consumes it", async () => {
    const admitted = call("blocked-later", "write", {});
    await admitToolCallBatch([admitted], ctx);

    clearBatchAdmittedToolCallsForRun(ctx.runId);

    expect(consumeBatchAdmittedToolCall(admitted.toolCall.id, ctx.runId)).toBe(false);
  });
});
