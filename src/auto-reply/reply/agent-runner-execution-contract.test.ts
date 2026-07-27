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

  it("rejects a late completed result after user abort was accepted", async () => {
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "late reply" }],
      meta: { durationMs: 1 },
    });
    const { replyOperation } = createMockReplyOperation();
    const abortedOperation = {
      ...replyOperation,
      result: { kind: "aborted", code: "aborted_by_user" } as const,
    };

    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({ replyOperation: abortedOperation }),
    );

    expect(result.outcome).toEqual({ kind: "aborted", reason: "user" });
  });
});
