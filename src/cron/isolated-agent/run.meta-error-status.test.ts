// Run meta error tests cover status reporting when cron run metadata fails.
import { describe, expect, it } from "vitest";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  cleanupDirectCronSessionMock,
  dispatchCronDeliveryMock,
  isHeartbeatOnlyResponseMock,
  loadRunCronIsolatedAgentTurn,
  resolveCronDeliveryPlanMock,
  resolveCronPayloadOutcomeMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeCommandLaneTaskTimeoutError(lane: string, timeoutMs: number): Error {
  const error = new Error(`Command lane "${lane}" task timed out after ${timeoutMs}ms`);
  error.name = "CommandLaneTaskTimeoutError";
  return error;
}

describe("runCronIsolatedAgentTurn - meta.error status propagation", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("marks a run-level error with empty payloads as a cron error", async () => {
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [],
        meta: {
          error: { kind: "provider_error", message: "model provider unreachable" },
          agentMeta: { usage: { input: 0, output: 0 } },
        },
      },
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("error");
    expect(result.error).toBe("cron isolated run failed: model provider unreachable");
    expect(result.outputText).toBe("cron isolated run failed: model provider unreachable");
  });

  it("does not deliver partial success text when a run-level error is present", async () => {
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [{ text: "Partial success-looking text" }],
        meta: {
          error: { kind: "retry_limit", message: "retry limit exceeded" },
          agentMeta: { usage: { input: 0, output: 0 } },
        },
      },
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("error");
    expect(result.error).toBe("cron isolated run failed: retry limit exceeded");
    expect(result.outputText).toBe("cron isolated run failed: retry limit exceeded");
  });

  it("marks an aborted embedded agent run without a run-level error as a cron error", async () => {
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [],
        meta: {
          aborted: true,
          agentMeta: { usage: { input: 0, output: 0 } },
        },
      },
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({ deleteAfterRun: true }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe("cron isolated agent run aborted");
    expect(cleanupDirectCronSessionMock).toHaveBeenCalledWith({
      job: expect.objectContaining({ deleteAfterRun: true }),
      agentSessionKey: "agent:default:cron:test",
      sessionId: "test-session-id",
      lifecycleRevision: "test-lifecycle-revision",
      sessionUpdatedAt: expect.any(Number),
      beforeSessionDelete: expect.any(Function),
      retireReason: "cron-delete-after-run-aborted",
    });
  });

  it("marks a completed embedded run with no final payload as a cron error", async () => {
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [],
        meta: {
          agentMeta: { usage: { input: 10, output: 0 } },
        },
      },
      provider: "anthropic",
      model: "claude-opus-4-8",
      attempts: [],
    });
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "test-target",
    });
    resolveCronPayloadOutcomeMock.mockReturnValue({
      summary: undefined,
      outputText: undefined,
      synthesizedText: undefined,
      deliveryPayload: undefined,
      deliveryPayloads: [],
      deliveryPayloadHasStructuredContent: false,
      hasFatalErrorPayload: false,
      hasFatalStructuredErrorPayload: false,
      embeddedRunError: undefined,
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(dispatchCronDeliveryMock).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
    expect(result.error).toBe("cron isolated run completed without a final assistant payload");
    expect(result.delivered).toBe(false);
  });

  it("marks empty message-tool attempts without source delivery as cron errors", async () => {
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [],
        didSendViaMessagingTool: true,
        messagingToolSentTargets: [],
        meta: {
          agentMeta: { usage: { input: 10, output: 0 } },
        },
      },
      provider: "anthropic",
      model: "claude-opus-4-8",
      attempts: [],
    });
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "test-target",
    });
    resolveCronPayloadOutcomeMock.mockReturnValue({
      summary: undefined,
      outputText: undefined,
      synthesizedText: undefined,
      deliveryPayload: undefined,
      deliveryPayloads: [],
      deliveryPayloadHasStructuredContent: false,
      hasFatalErrorPayload: false,
      hasFatalStructuredErrorPayload: false,
      embeddedRunError: undefined,
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(dispatchCronDeliveryMock).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
    expect(result.error).toBe("cron isolated run completed without a final assistant payload");
    expect(result.delivered).toBe(false);
  });

  it("keeps explicit silent replies as successful cron completions", async () => {
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [],
        meta: {
          finalAssistantRawText: "NO_REPLY",
          finalAssistantVisibleText: "NO_REPLY",
          agentMeta: { usage: { input: 10, output: 1 } },
        },
      },
      provider: "anthropic",
      model: "claude-opus-4-8",
      attempts: [],
    });
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "test-target",
    });
    resolveCronPayloadOutcomeMock.mockReturnValue({
      summary: undefined,
      outputText: undefined,
      synthesizedText: undefined,
      deliveryPayload: undefined,
      deliveryPayloads: [],
      deliveryPayloadHasStructuredContent: false,
      hasFatalErrorPayload: false,
      hasFatalStructuredErrorPayload: false,
      embeddedRunError: undefined,
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(dispatchCronDeliveryMock).toHaveBeenCalled();
    expect(result.status).toBe("ok");
    expect(result.error).toBeUndefined();
  });

  it("keeps committed message-tool deliveries as successful cron completions", async () => {
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered to an intentional recipient"],
        messagingToolSentTargets: [],
        meta: {
          agentMeta: { usage: { input: 10, output: 0 } },
        },
      },
      provider: "anthropic",
      model: "claude-opus-4-8",
      attempts: [],
    });
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "test-target",
    });
    resolveCronPayloadOutcomeMock.mockReturnValue({
      summary: undefined,
      outputText: undefined,
      synthesizedText: undefined,
      deliveryPayload: undefined,
      deliveryPayloads: [],
      deliveryPayloadHasStructuredContent: false,
      hasFatalErrorPayload: false,
      hasFatalStructuredErrorPayload: false,
      embeddedRunError: undefined,
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(dispatchCronDeliveryMock).toHaveBeenCalled();
    expect(result.status).toBe("ok");
    expect(result.error).toBeUndefined();
  });

  it("does not mark empty deterministic approval prompts as cron errors", async () => {
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [],
        didSendDeterministicApprovalPrompt: true,
        meta: {
          agentMeta: { usage: { input: 10, output: 0 } },
        },
      },
      provider: "anthropic",
      model: "claude-opus-4-8",
      attempts: [],
    });
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "test-target",
    });
    resolveCronPayloadOutcomeMock.mockReturnValue({
      summary: undefined,
      outputText: undefined,
      synthesizedText: undefined,
      deliveryPayload: undefined,
      deliveryPayloads: [],
      deliveryPayloadHasStructuredContent: false,
      hasFatalErrorPayload: false,
      hasFatalStructuredErrorPayload: false,
      embeddedRunError: undefined,
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(dispatchCronDeliveryMock).toHaveBeenCalled();
    expect(result.status).toBe("ok");
    expect(result.error).toBeUndefined();
  });

  it("does not mark empty accepted child-session handoffs as cron errors", async () => {
    isHeartbeatOnlyResponseMock.mockReturnValue(true);
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [],
        acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:default:child" }],
        meta: {
          agentMeta: { usage: { input: 10, output: 0 } },
        },
      },
      provider: "anthropic",
      model: "claude-opus-4-8",
      attempts: [],
    });
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "test-target",
    });
    resolveCronPayloadOutcomeMock.mockReturnValue({
      summary: undefined,
      outputText: undefined,
      synthesizedText: undefined,
      deliveryPayload: undefined,
      deliveryPayloads: [],
      deliveryPayloadHasStructuredContent: false,
      hasFatalErrorPayload: false,
      hasFatalStructuredErrorPayload: false,
      embeddedRunError: undefined,
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(dispatchCronDeliveryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spawnOnlyHandoff: true,
        skipHeartbeatDelivery: false,
        deliveryPayloads: [],
        synthesizedText: undefined,
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.error).toBeUndefined();
  });

  it("preserves incomplete accepted child-session handoffs as cron errors", async () => {
    const error = "cron child-session handoff timed out before producing a final assistant payload";
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [],
        acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:default:child" }],
        meta: {
          agentMeta: { usage: { input: 10, output: 0 } },
        },
      },
      provider: "anthropic",
      model: "claude-opus-4-8",
      attempts: [],
    });
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "test-target",
    });
    resolveCronPayloadOutcomeMock.mockReturnValue({
      summary: undefined,
      outputText: undefined,
      synthesizedText: undefined,
      deliveryPayload: undefined,
      deliveryPayloads: [],
      deliveryPayloadHasStructuredContent: false,
      hasFatalErrorPayload: false,
      hasFatalStructuredErrorPayload: false,
      embeddedRunError: undefined,
    });
    dispatchCronDeliveryMock.mockImplementationOnce(({ withRunSession }) => ({
      result: withRunSession({ status: "error", error, deliveryAttempted: true }),
      delivered: false,
      deliveryAttempted: true,
      cronRunSessionCleanupAttempted: false,
      summary: undefined,
      outputText: undefined,
      synthesizedText: undefined,
      deliveryPayloads: [],
    }));

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("error");
    expect(result.error).toBe(error);
    expect(result.delivered).toBe(false);
  });

  it("keeps actual heartbeat acknowledgements silent after an accepted child spawn", async () => {
    const heartbeatPayload = { text: "HEARTBEAT_OK" };
    isHeartbeatOnlyResponseMock.mockReturnValue(true);
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [heartbeatPayload],
        acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:default:child" }],
        meta: { agentMeta: { usage: { input: 10, output: 1 } } },
      },
      provider: "anthropic",
      model: "claude-opus-4-8",
      attempts: [],
    });
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "test-target",
    });
    resolveCronPayloadOutcomeMock.mockReturnValue({
      summary: heartbeatPayload.text,
      outputText: heartbeatPayload.text,
      synthesizedText: heartbeatPayload.text,
      deliveryPayload: heartbeatPayload,
      deliveryPayloads: [heartbeatPayload],
      deliveryPayloadHasStructuredContent: false,
      hasFatalErrorPayload: false,
      hasFatalStructuredErrorPayload: false,
      embeddedRunError: undefined,
    });

    await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(dispatchCronDeliveryMock).toHaveBeenCalledWith(
      expect.objectContaining({ spawnOnlyHandoff: false, skipHeartbeatDelivery: true }),
    );
  });

  it("preserves structured-parent delivery failures after accepting a child", async () => {
    const mediaPayload = { mediaUrl: "https://example.invalid/chart.png" };
    const error = "Structured message failed";
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [mediaPayload],
        acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:default:child" }],
        meta: { agentMeta: { usage: { input: 10, output: 1 } } },
      },
      provider: "anthropic",
      model: "claude-opus-4-8",
      attempts: [],
    });
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "test-target",
    });
    resolveCronPayloadOutcomeMock.mockReturnValue({
      summary: undefined,
      outputText: undefined,
      synthesizedText: undefined,
      deliveryPayload: mediaPayload,
      deliveryPayloads: [mediaPayload],
      deliveryPayloadHasStructuredContent: true,
      hasFatalErrorPayload: false,
      hasFatalStructuredErrorPayload: false,
      embeddedRunError: undefined,
    });
    dispatchCronDeliveryMock.mockImplementationOnce(({ withRunSession }) => ({
      result: withRunSession({ status: "error", error, deliveryAttempted: true }),
      delivered: false,
      deliveryAttempted: true,
      cronRunSessionCleanupAttempted: false,
      summary: undefined,
      outputText: undefined,
      synthesizedText: undefined,
      deliveryPayloads: [mediaPayload],
    }));

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(dispatchCronDeliveryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spawnOnlyHandoff: false,
        deliveryPayloadHasStructuredContent: true,
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.deliveryError).toBe(error);
  });

  it("does not mark empty successful cron-add completions as cron errors", async () => {
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [],
        successfulCronAdds: 1,
        meta: {
          agentMeta: { usage: { input: 10, output: 0 } },
        },
      },
      provider: "anthropic",
      model: "claude-opus-4-8",
      attempts: [],
    });
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "test-target",
    });
    resolveCronPayloadOutcomeMock.mockReturnValue({
      summary: undefined,
      outputText: undefined,
      synthesizedText: undefined,
      deliveryPayload: undefined,
      deliveryPayloads: [],
      deliveryPayloadHasStructuredContent: false,
      hasFatalErrorPayload: false,
      hasFatalStructuredErrorPayload: false,
      embeddedRunError: undefined,
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(dispatchCronDeliveryMock).toHaveBeenCalled();
    expect(result.status).toBe("ok");
    expect(result.error).toBeUndefined();
  });

  it("surfaces cron timeout result when the cron-nested lane watchdog fires", async () => {
    runWithModelFallbackMock.mockRejectedValueOnce(
      makeCommandLaneTaskTimeoutError("cron-nested", 330_000),
    );

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("error");
    expect(result.error).toBe("cron: job execution timed out");
    expect(result.error).not.toContain("CommandLaneTaskTimeoutError");
    expect(result.error).not.toContain("cron-nested");
    // The timeout row must keep the already-resolved run attribution so
    // Task-run history does not show an un-attributed cron timeout (#95873).
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.4");
    expect(result.sessionId).toBe("test-session-id");
  });

  it("keeps cron timeout result when executor rejects after the cron abort signal fires", async () => {
    const abortController = new AbortController();
    const timeoutError = new Error(
      "cron: job execution timed out (last phase: model_call_started)",
    );
    timeoutError.name = "TimeoutError";
    abortController.abort(timeoutError);
    await expect(
      runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({ abortSignal: abortController.signal }),
      ),
    ).rejects.toBe(timeoutError);
    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
  });
});
