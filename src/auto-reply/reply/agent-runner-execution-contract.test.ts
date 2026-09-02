import { describe, expect, it } from "vitest";
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

  it("keeps publisher-only compaction counts presentation-only after a late user abort", async () => {
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "late reply" }],
      meta: { durationMs: 1, agentMeta: { compactionCount: 1, compactionTokensAfter: 40 } },
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

    expect(result.outcome).toEqual({
      kind: "aborted",
      reason: "user",
      compaction: { count: 1, durable: [] },
    });
  });
});
