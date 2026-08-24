import { describe, expect, it, vi } from "vitest";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import {
  createMinimalRunAgentTurnParams,
  createMockReplyOperation,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";

const state = setupAgentRunnerExecutionTestState();
const { executeAgentTurn } = await import("./agent-runner-execution.js");

describe("executeAgentTurn contract", () => {
  it("returns one closed settled result with winner and fallback facts", async () => {
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: {
        durationMs: 1,
        agentMeta: { provider: "anthropic", model: "claude-sonnet" },
      },
    });

    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result).toMatchObject({
      runId: expect.any(String),
      outcome: {
        kind: "settled",
        status: "ok",
        resolved: { provider: "anthropic", model: "claude" },
        fallback: { exhausted: false, attempts: [] },
        result: { payloads: [{ text: "done" }] },
      },
    });
  });

  it("retains a late completed result for accounting after user abort was accepted", async () => {
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "late reply" }],
      meta: { durationMs: 1 },
    });
    const { replyOperation } = createMockReplyOperation();
    let operationResult: typeof replyOperation.result = null;
    const lateAbortedOperation = {
      ...replyOperation,
      get result() {
        return operationResult;
      },
      freezeAbort: () => {
        operationResult = { kind: "aborted", code: "aborted_by_user" };
      },
    };

    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({ replyOperation: lateAbortedOperation }),
    );

    expect(result.outcome).toMatchObject({
      kind: "settled",
      abortReason: "user",
      result: { payloads: [{ text: "late reply" }] },
    });
  });

  it("releases an unsettled operation when a restart error aborts execution", async () => {
    const { replyOperation } = createMockReplyOperation();
    const complete = vi.fn();
    const unsettledOperation = {
      ...replyOperation,
      complete,
      freezeAbort: () => {
        throw createAgentRunRestartAbortError();
      },
    };

    const params = createMinimalRunAgentTurnParams({ replyOperation: unsettledOperation });
    params.followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    const result = await executeAgentTurn(params);

    expect(result.outcome).toEqual({ kind: "aborted", reason: "restart" });
    expect(complete).toHaveBeenCalledOnce();
    expect(state.recordMessageToolRunOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "mute", runStatus: "aborted" }),
    );
  });
});
