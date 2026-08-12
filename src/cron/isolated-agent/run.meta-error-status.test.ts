// Run meta error tests cover status reporting when cron run metadata fails.
import { describe, expect, it } from "vitest";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  callGatewayMock,
  dispatchCronDeliveryMock,
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

function mockAgentRun({
  provider = "anthropic",
  model = "claude-opus-4-8",
  usage = { input: 10, output: 0 },
  meta = {},
  ...result
}: {
  provider?: string;
  model?: string;
  usage?: { input: number; output: number };
  meta?: Record<string, unknown>;
  [key: string]: unknown;
} = {}) {
  runWithModelFallbackMock.mockResolvedValueOnce({
    result: {
      payloads: [],
      ...result,
      meta: { agentMeta: { usage }, ...meta },
    },
    provider,
    model,
    attempts: [],
  });
}

function mockAnnounceOutcome(overrides: Record<string, unknown> = {}) {
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
    deliveryDisposition: { kind: "visible" },
    deliveryPayloadHasStructuredContent: false,
    hasFatalErrorPayload: false,
    hasFatalStructuredErrorPayload: false,
    embeddedRunError: undefined,
    ...overrides,
  });
}

function mockDeliveryFailure(error: string, deliveryPayloads: unknown[] = []) {
  dispatchCronDeliveryMock.mockImplementationOnce(({ withRunSession }) => ({
    result: withRunSession({ status: "error", error, deliveryAttempted: true }),
    delivered: false,
    deliveryAttempted: true,
    cronRunSessionCleanupAttempted: false,
    summary: undefined,
    outputText: undefined,
    synthesizedText: undefined,
    deliveryPayloads,
  }));
}

describe("runCronIsolatedAgentTurn - meta.error status propagation", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("marks a run-level error with empty payloads as a cron error", async () => {
    mockAgentRun({
      provider: "openai",
      model: "gpt-5.4",
      usage: { input: 0, output: 0 },
      meta: { error: { kind: "provider_error", message: "model provider unreachable" } },
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("error");
    expect(result.error).toBe("cron isolated run failed: model provider unreachable");
    expect(result.outputText).toBe("cron isolated run failed: model provider unreachable");
  });

  it("does not deliver partial success text when a run-level error is present", async () => {
    mockAgentRun({
      provider: "openai",
      model: "gpt-5.4",
      usage: { input: 0, output: 0 },
      payloads: [{ text: "Partial success-looking text" }],
      meta: { error: { kind: "retry_limit", message: "retry limit exceeded" } },
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("error");
    expect(result.error).toBe("cron isolated run failed: retry limit exceeded");
    expect(result.outputText).toBe("cron isolated run failed: retry limit exceeded");
  });

  it("marks an aborted embedded agent run without a run-level error as a cron error", async () => {
    mockAgentRun({
      provider: "openai",
      model: "gpt-5.4",
      usage: { input: 0, output: 0 },
      meta: { aborted: true },
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({ deleteAfterRun: true }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe("cron isolated agent run aborted");
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("marks a completed embedded run with no final payload as a cron error", async () => {
    mockAgentRun();
    mockAnnounceOutcome();

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(dispatchCronDeliveryMock).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
    expect(result.error).toBe("cron isolated run completed without a final assistant payload");
    expect(result.delivered).toBe(false);
  });

  it("marks empty message-tool attempts without source delivery as cron errors", async () => {
    mockAgentRun({
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [],
    });
    mockAnnounceOutcome();

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(dispatchCronDeliveryMock).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
    expect(result.error).toBe("cron isolated run completed without a final assistant payload");
    expect(result.delivered).toBe(false);
  });

  it("keeps explicit silent replies as successful cron completions", async () => {
    mockAgentRun({
      usage: { input: 10, output: 1 },
      meta: {
        finalAssistantRawText: "NO_REPLY",
        finalAssistantVisibleText: "NO_REPLY",
      },
    });
    mockAnnounceOutcome();

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(dispatchCronDeliveryMock).toHaveBeenCalled();
    expect(result.status).toBe("ok");
    expect(result.error).toBeUndefined();
  });

  it("keeps committed message-tool deliveries as successful cron completions", async () => {
    mockAgentRun({
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["Delivered to an intentional recipient"],
      messagingToolSentTargets: [],
    });
    mockAnnounceOutcome();

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(dispatchCronDeliveryMock).toHaveBeenCalled();
    expect(result.status).toBe("ok");
    expect(result.error).toBeUndefined();
  });

  it("does not mark empty deterministic approval prompts as cron errors", async () => {
    mockAgentRun({ didSendDeterministicApprovalPrompt: true });
    mockAnnounceOutcome();

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(dispatchCronDeliveryMock).toHaveBeenCalled();
    expect(result.status).toBe("ok");
    expect(result.error).toBeUndefined();
  });

  it("does not mark empty accepted child-session handoffs as cron errors", async () => {
    mockAgentRun({
      acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:default:child" }],
    });
    mockAnnounceOutcome({ deliveryDisposition: { kind: "empty" } });

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
    mockAgentRun({
      acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:default:child" }],
    });
    mockAnnounceOutcome();
    mockDeliveryFailure(error);

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("error");
    expect(result.error).toBe(error);
    expect(result.delivered).toBe(false);
  });

  it.each([
    "HEARTBEAT_OK",
    "**HEARTBEAT_OK**",
    "<b>HEARTBEAT_OK</b>",
    "<thinking>Check the schedule.</thinking>\nHEARTBEAT_OK",
    '{"action":"HEARTBEAT_OK"}',
    '"HEARTBEAT_OK"',
  ])(
    "waits for the accepted child instead of treating %s as its final reply",
    async (heartbeatReply) => {
      const heartbeatPayload = { text: heartbeatReply };
      mockAgentRun({
        payloads: [heartbeatPayload],
        usage: { input: 10, output: 1 },
        acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:default:child" }],
      });
      mockAnnounceOutcome({
        summary: heartbeatPayload.text,
        outputText: heartbeatPayload.text,
        synthesizedText: heartbeatPayload.text,
        deliveryPayload: heartbeatPayload,
        deliveryPayloads: [heartbeatPayload],
        deliveryDisposition: { kind: "heartbeat", controlOnly: true },
      });

      const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

      expect(dispatchCronDeliveryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          spawnOnlyHandoff: true,
          skipHeartbeatDelivery: false,
          deliveryPayloads: [],
          synthesizedText: undefined,
          summary: undefined,
          outputText: undefined,
        }),
      );
      expect(result.status).toBe("ok");
    },
  );

  it.each([
    {
      name: "a substantive sibling payload",
      parentReply: "Checked inbox and calendar.",
      payloads: [{ text: "Checked inbox and calendar." }, { text: "HEARTBEAT_OK" }],
    },
    {
      name: "substantive text in the heartbeat payload",
      parentReply: "HEARTBEAT_OK child completed reminder",
      payloads: [{ text: "HEARTBEAT_OK child completed reminder" }],
    },
  ])(
    "preserves $name instead of treating an accepted child as the only completion",
    async ({ parentReply, payloads }) => {
      mockAgentRun({
        payloads,
        usage: { input: 10, output: 1 },
        acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:default:child" }],
      });
      mockAnnounceOutcome({
        summary: parentReply,
        outputText: parentReply,
        synthesizedText: parentReply,
        deliveryPayload: payloads.at(-1),
        deliveryPayloads: payloads,
        deliveryDisposition: { kind: "heartbeat", controlOnly: false },
      });

      const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

      expect(dispatchCronDeliveryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          spawnOnlyHandoff: false,
          skipHeartbeatDelivery: true,
          deliveryPayloads: payloads,
          synthesizedText: parentReply,
          summary: parentReply,
          outputText: parentReply,
        }),
      );
      expect(result.summary).toBe(parentReply);
      expect(result.outputText).toBe(parentReply);
    },
  );

  it("preserves a heartbeat-only accepted child handoff failure as a cron error", async () => {
    const heartbeatPayload = { text: "HEARTBEAT_OK" };
    const error = "cron child-session handoff timed out before producing a final assistant payload";
    mockAgentRun({
      payloads: [heartbeatPayload],
      usage: { input: 10, output: 1 },
      acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:default:child" }],
    });
    mockAnnounceOutcome({
      summary: heartbeatPayload.text,
      outputText: heartbeatPayload.text,
      synthesizedText: heartbeatPayload.text,
      deliveryPayload: heartbeatPayload,
      deliveryPayloads: [heartbeatPayload],
      deliveryDisposition: { kind: "heartbeat", controlOnly: true },
    });
    mockDeliveryFailure(error);

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("error");
    expect(result.error).toBe(error);
    expect(result.delivered).toBe(false);
    expect(result.summary).not.toBe(heartbeatPayload.text);
    expect(result.outputText).not.toBe(heartbeatPayload.text);
  });

  it("preserves structured-parent delivery failures after accepting a child", async () => {
    const mediaPayload = { mediaUrl: "https://example.invalid/chart.png" };
    const error = "Structured message failed";
    mockAgentRun({
      payloads: [mediaPayload],
      usage: { input: 10, output: 1 },
      acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:default:child" }],
    });
    mockAnnounceOutcome({
      deliveryPayload: mediaPayload,
      deliveryPayloads: [mediaPayload],
      deliveryPayloadHasStructuredContent: true,
    });
    mockDeliveryFailure(error, [mediaPayload]);

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
    mockAgentRun({ successfulCronAdds: 1 });
    mockAnnounceOutcome();

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
