import { describe, expect, it } from "vitest";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  getRunAgentTurnWithFallback,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-fallback-candidate.js";

const state = setupAgentRunnerExecutionTestState();

describe("runAgentTurnWithFallback: nonDeliverableTerminalTurn", () => {
  it("includes terminalFailurePayload when nonDeliverableTerminalTurn is set in message_tool_only mode", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: { nonDeliverableTerminalTurn: true },
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run("anthropic", "claude"),
      provider: "anthropic",
      model: "claude",
      attempts: [],
    }));

    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams({ followupRun }));

    expect(result.kind).toBe("success");
    const successResult = result as Extract<typeof result, { kind: "success" }>;
    expect(successResult.terminalFailurePayload).toMatchObject({
      text: "The agent run failed before producing a reply.",
      isError: true,
    });
  });

  it("includes terminalFailurePayload when nonDeliverableTerminalTurn is set without message_tool_only", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: { nonDeliverableTerminalTurn: true },
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run("anthropic", "claude"),
      provider: "anthropic",
      model: "claude",
      attempts: [],
    }));

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("success");
    const successResult = result as Extract<typeof result, { kind: "success" }>;
    expect(successResult.terminalFailurePayload).toMatchObject({ isError: true });
  });

  it("does not set terminalFailurePayload for normal successful turns in message_tool_only mode", async () => {
    // Regression: normal successful reply must not produce a terminal failure payload.
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello from agent" }],
      meta: {},
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run("anthropic", "claude"),
      provider: "anthropic",
      model: "claude",
      attempts: [],
    }));

    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams({ followupRun }));

    expect(result.kind).toBe("success");
    const successResult = result as Extract<typeof result, { kind: "success" }>;
    expect(successResult.terminalFailurePayload).toBeUndefined();
  });
});
