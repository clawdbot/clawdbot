import { describe, expect, it, vi } from "vitest";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import {
  createMinimalRunAgentTurnParams,
  createMockReplyOperation,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";
import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import {
  recordReplyOperationAgentTurnOutcome,
  resolveReplyOperationAgentTurn,
} from "./reply-operation-agent-turn-state.js";

const state = setupAgentRunnerExecutionTestState();
const { executeAgentTurn } = await import("./agent-runner-execution.js");

function resolveRecordedAgentTurnStatus(outcome: AgentTurnExecutionResult["outcome"]) {
  const runState = {};
  recordReplyOperationAgentTurnOutcome(runState, outcome);
  return resolveReplyOperationAgentTurn(runState);
}

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
    expect(resolveRecordedAgentTurnStatus(result.outcome)).toBe("ok");
  });

  it.each([
    { abortCode: "aborted_by_user", abortReason: "user" },
    { abortCode: "aborted_for_restart", abortReason: "restart" },
  ] as const)(
    "records a late completed result as cancelled after $abortReason abort was accepted",
    async ({ abortCode, abortReason }) => {
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
          operationResult = { kind: "aborted", code: abortCode };
        },
      };

      const result = await executeAgentTurn(
        createMinimalRunAgentTurnParams({ replyOperation: lateAbortedOperation }),
      );

      expect(result.outcome).toMatchObject({
        kind: "settled",
        abortReason,
        result: { payloads: [{ text: "late reply" }] },
      });
      expect(resolveRecordedAgentTurnStatus(result.outcome)).toBe("cancelled");
    },
  );

  it.each(["user", "restart"] as const)("records a direct %s abort as cancelled", (reason) => {
    expect(resolveRecordedAgentTurnStatus({ kind: "aborted", reason })).toBe("cancelled");
  });

  it("keeps a rejected result classified as failed", () => {
    expect(resolveRecordedAgentTurnStatus({ kind: "rejected", payload: { text: "failed" } })).toBe(
      "failed",
    );
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

    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({ replyOperation: unsettledOperation }),
    );

    expect(result.outcome).toEqual({ kind: "aborted", reason: "restart" });
    expect(complete).toHaveBeenCalledOnce();
  });
});
