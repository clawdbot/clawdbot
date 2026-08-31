import {
  emitAgentEvent,
  normalizeUsage,
  onAgentEvent,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  readAttemptTerminal,
  expectUsageFields,
  forCurrentTurn,
  agentMessageDelta,
  turnCompleted,
  turnWithStatus,
  vi,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector usage projection", () => {
  it("keeps the startup harness window when no token-usage update arrives", async () => {
    const projector = await createProjector(undefined, { initialContextTokens: 1_050_000 });

    await projector.handleNotification(agentMessageDelta("done"));
    await projector.handleNotification(turnCompleted());

    expect(projector.buildResult(buildEmptyToolTelemetry())).toMatchObject({
      contextTokens: 1_050_000,
      contextTokensSource: "resolved",
    });
  });

  it("emits native context-window and prompt-token snapshots", async () => {
    const params = await createParams();
    const callback = vi.fn();
    const projector = await createProjector(
      { ...params, onAgentEvent: callback },
      { initialContextTokens: 1_050_000 },
    );

    await projector.handleNotification(
      forCurrentTurn("thread/tokenUsage/updated", {
        tokenUsage: {
          modelContextWindow: 875_900,
          last: {
            totalTokens: 300_010,
            inputTokens: 300_000,
            cachedInputTokens: 250_000,
            cacheWriteInputTokens: 5_000,
            outputTokens: 10,
            reasoningOutputTokens: 4,
          },
        },
      }),
    );

    expect(callback).toHaveBeenCalledWith({
      stream: "usage",
      data: {
        activeContextTokens: 300_010,
        cachedInputTokens: 250_000,
        cacheWriteInputTokens: 5_000,
        inputTokens: 300_000,
        modelContextWindow: 875_900,
        promptTokens: 300_000,
        reasoningOutputTokens: 4,
      },
    });
    expect(projector.buildResult(buildEmptyToolTelemetry())).toMatchObject({
      contextTokens: 875_900,
      contextTokensSource: "runtime",
    });
  });

  it("publishes each completed response once before tools settle and carries totals across native turns", async () => {
    const params = await createParams();
    const callback = vi.fn();
    const hosts: Array<Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>> = [];
    const createBoundProjector = async (attempt: typeof params) => {
      const host = await createAdmittedHostCapabilityTestFixture(attempt);
      hosts.push(host);
      const projector = await createProjector({
        ...attempt,
        hostCapabilities: host.hostCapabilities,
      });
      return { host, projector };
    };
    const observed: number[] = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.stream === "lifecycle") {
        params.lifecycleGeneration = event.lifecycleGeneration;
      }
      if (event.stream === "usage" && typeof event.data.outputTokens === "number") {
        observed.push(event.data.outputTokens);
      }
    });
    emitAgentEvent({
      runId: params.runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1 },
    });
    params.onAgentEvent = callback;
    const { host: runHost, projector } = await createBoundProjector(params);
    const response = (responseId: string, outputTokens: number) =>
      forCurrentTurn("rawResponse/completed", {
        responseId,
        usage: {
          inputTokens: 5,
          cachedInputTokens: 2,
          outputTokens,
          totalTokens: 5 + outputTokens,
          reasoningOutputTokens: 0,
        },
      });

    try {
      await projector.handleNotification(response("response-1", 100));
      expect(observed).toEqual([100]);
      await projector.handleNotification(response("response-2", 20));
      await projector.handleNotification(response("response-1", 100));
      await projector.handleNotification(
        forCurrentTurn("error", { error: { message: "retry" }, willRetry: true }),
      );
      await projector.handleNotification(response("response-3", 50));
      await projector.handleNotification(response("response-1", 100));
      await projector.handleNotification(
        forCurrentTurn("thread/tokenUsage/updated", {
          tokenUsage: { last: { inputTokens: 5, outputTokens: 50, totalTokens: 55 } },
        }),
      );
      expect(observed).toEqual([100, 120, 170]);
      expect(projector.buildResult(buildEmptyToolTelemetry()).attemptUsage?.output).toBe(50);

      const nextAttempt = await createProjector({
        ...params,
        hostCapabilities: runHost.hostCapabilities,
      });
      await nextAttempt.handleNotification(response("response-4", 10));
      expect(observed).toEqual([100, 120, 170, 180]);
      const { projector: otherRun } = await createBoundProjector({
        ...params,
        runId: "another-run",
      });
      await otherRun.handleNotification(response("another-response", 7));

      expect(observed).toEqual([100, 120, 170, 180, 7]);
      expect(
        callback.mock.calls
          .map(([event]) => event)
          .filter(
            (event) => event.stream === "usage" && typeof event.data.outputTokens === "number",
          )
          .map((event) => event.data.outputTokens),
      ).toEqual(observed);
    } finally {
      unsubscribe();
      for (const host of hosts) {
        host.closeHost();
        host.closeAdmission();
      }
    }
  });

  it("marks native telemetry constrained by an authored context cap", async () => {
    const params = await createParams();
    const projector = await createProjector({ ...params, authoredContextTokenCap: 272_000 });

    await projector.handleNotification(
      forCurrentTurn("thread/tokenUsage/updated", {
        tokenUsage: { modelContextWindow: 272_000 },
      }),
    );

    expect(projector.buildResult(buildEmptyToolTelemetry())).toMatchObject({
      contextTokens: 272_000,
      contextTokensSource: "runtime-configured",
    });
  });

  it("ignores cumulative thread usage after exact response usage", async () => {
    const projector = await createProjector();

    await projector.handleNotification(agentMessageDelta("done"));
    await projector.handleNotification(
      forCurrentTurn("rawResponse/completed", {
        responseId: "response-1",
        usage: {
          totalTokens: 12,
          inputTokens: 5,
          cachedInputTokens: 2,
          outputTokens: 7,
          reasoningOutputTokens: 0,
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("thread/tokenUsage/updated", {
        tokenUsage: {
          total: {
            totalTokens: 1_000_000,
            inputTokens: 999_000,
            cachedInputTokens: 500,
            outputTokens: 500,
          },
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual(["done"]);
    expectUsageFields(result.attemptUsage, { input: 3, output: 7, cacheRead: 2, total: 12 });
    expect(result.attemptUsage?.contextUsage).toEqual({
      state: "available",
      promptTokens: 5,
      totalTokens: 12,
    });
  });

  it("counts unique upstream responses as model iterations", async () => {
    const projector = await createProjector();

    for (const responseId of ["response-1", "response-1", "response-2"]) {
      await projector.handleNotification(
        forCurrentTurn("rawResponse/completed", { responseId, usage: null }),
      );
    }

    expect(projector.buildResult(buildEmptyToolTelemetry()).modelIterations).toBe(2);
  });

  it("uses current-turn thread usage when exact response events are unavailable", async () => {
    const projector = await createProjector();

    await projector.handleNotification(agentMessageDelta("done"));
    await projector.handleNotification(
      forCurrentTurn("thread/tokenUsage/updated", {
        tokenUsage: {
          total: {
            totalTokens: 1_000_000,
            inputTokens: 999_000,
            cachedInputTokens: 500,
            outputTokens: 500,
          },
          last: {
            totalTokens: 12,
            inputTokens: 5,
            cachedInputTokens: 2,
            cacheWriteInputTokens: 1,
            outputTokens: 7,
            reasoningOutputTokens: 3,
          },
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual(["done"]);
    expectUsageFields(result.attemptUsage, {
      input: 2,
      output: 7,
      cacheRead: 2,
      cacheWrite: 1,
      total: 12,
    });
    expect(result.attemptUsage?.reasoningTokens).toBe(3);
    expect(result.attemptUsage?.contextUsage).toEqual({
      state: "available",
      promptTokens: 5,
      totalTokens: 12,
    });
    expectUsageFields(result.lastAssistant?.usage, {
      input: 2,
      output: 7,
      cacheRead: 2,
      cacheWrite: 1,
      total: 12,
    });
    expect(result.lastAssistant?.usage.contextUsage).toEqual({
      state: "available",
      promptTokens: 5,
      totalTokens: 12,
    });
    expect(normalizeUsage(result.lastAssistant?.usage)?.reasoningTokens).toBe(3);
  });

  it.each([
    ["incomplete", { totalTokens: 12 }, { total: 12 }],
    [
      "incoherent total",
      {
        totalTokens: 6,
        inputTokens: 5,
        cachedInputTokens: 2,
        outputTokens: 7,
        reasoningOutputTokens: 0,
      },
      { input: 3, output: 7, cacheRead: 2, cacheWrite: 0, total: 6 },
    ],
    [
      "impossible cache counts",
      {
        totalTokens: 12,
        inputTokens: 5,
        cachedInputTokens: 4,
        cacheWriteInputTokens: 2,
        outputTokens: 7,
        reasoningOutputTokens: 0,
      },
      { output: 7, cacheRead: 4, cacheWrite: 2, total: 12 },
    ],
  ])("keeps valid fields from %s response usage", async (_label, usage, expectedUsage) => {
    const projector = await createProjector();

    await projector.handleNotification(agentMessageDelta("done"));
    await projector.handleNotification(
      forCurrentTurn("rawResponse/completed", { responseId: "response-1", usage }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual(["done"]);
    expect(result.attemptUsage).toMatchObject(expectedUsage);
    expect(result.attemptUsage?.contextUsage).toEqual({ state: "unavailable" });
    expect(result.lastAssistant?.usage.contextUsage).toEqual({ state: "unavailable" });
  });

  it("clears prior response usage when the final response omits usage", async () => {
    const projector = await createProjector();

    await projector.handleNotification(agentMessageDelta("done"));
    await projector.handleNotification(
      forCurrentTurn("rawResponse/completed", {
        responseId: "response-1",
        usage: {
          totalTokens: 12,
          inputTokens: 5,
          cachedInputTokens: 2,
          outputTokens: 7,
          reasoningOutputTokens: 0,
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("thread/tokenUsage/updated", {
        tokenUsage: {
          last: {
            totalTokens: 12,
            inputTokens: 5,
            cachedInputTokens: 2,
            outputTokens: 7,
          },
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponse/completed", { responseId: "response-2", usage: null }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expectUsageFields(result.attemptUsage, { input: 3, output: 7, cacheRead: 2, total: 12 });
    expect(result.attemptUsage?.contextUsage).toEqual({ state: "unavailable" });
    expect(result.lastAssistant?.usage.contextUsage).toEqual({ state: "unavailable" });
  });

  it.each(["failed", "interrupted"])(
    "invalidates exact response usage when the turn ends %s",
    async (status) => {
      const projector = await createProjector();

      await projector.handleNotification(
        forCurrentTurn("rawResponse/completed", {
          responseId: "response-1",
          usage: {
            totalTokens: 12,
            inputTokens: 5,
            cachedInputTokens: 2,
            outputTokens: 7,
            reasoningOutputTokens: 0,
          },
        }),
      );
      await projector.handleNotification(turnWithStatus(status));

      expect(projector.buildResult(buildEmptyToolTelemetry()).attemptUsage).toBeUndefined();
    },
  );

  it("invalidates exact response usage on retryable errors and explicit aborts", async () => {
    const projector = await createProjector();
    const exactUsage = {
      totalTokens: 12,
      inputTokens: 5,
      cachedInputTokens: 2,
      outputTokens: 7,
      reasoningOutputTokens: 0,
    };

    await projector.handleNotification(
      forCurrentTurn("rawResponse/completed", {
        responseId: "response-1",
        usage: exactUsage,
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("error", { error: { message: "retry" }, willRetry: true }),
    );
    expect(projector.buildResult(buildEmptyToolTelemetry()).attemptUsage).toBeUndefined();

    await projector.handleNotification(
      forCurrentTurn("rawResponse/completed", {
        responseId: "response-2",
        usage: exactUsage,
      }),
    );
    projector.markAborted();
    expect(projector.buildResult(buildEmptyToolTelemetry()).attemptUsage).toBeUndefined();
  });

  it("restores exact response usage after recovering a completed assistant timeout", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "agentMessage", id: "msg-1", text: "done" },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("thread/tokenUsage/updated", {
        tokenUsage: {
          last: {
            totalTokens: 12,
            inputTokens: 5,
            cachedInputTokens: 2,
            outputTokens: 7,
          },
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponse/completed", {
        responseId: "response-1",
        usage: {
          totalTokens: 12,
          inputTokens: 5,
          cachedInputTokens: 2,
          outputTokens: 7,
          reasoningOutputTokens: 0,
        },
      }),
    );

    projector.markTimedOut();
    const timedOut = projector.buildResult(buildEmptyToolTelemetry());
    expect(readAttemptTerminal(timedOut).aborted).toBe(true);
    expect(timedOut.attemptUsage?.contextUsage).toEqual({ state: "unavailable" });

    expect(projector.recoverCompletedTerminalAssistantAfterTurnWatchTimeout()).toBe(true);
    const recovered = projector.buildResult(buildEmptyToolTelemetry());
    expect(readAttemptTerminal(recovered).aborted).toBe(false);
    expect(readAttemptTerminal(recovered).promptError).toBeNull();
    expect(recovered.attemptUsage?.contextUsage).toEqual({
      state: "available",
      promptTokens: 5,
      totalTokens: 12,
    });
  });

  it("uses raw assistant response items when turn completion omits items", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-1",
          role: "assistant",
          content: [{ type: "output_text", text: "OK from raw" }],
        },
      }),
    );
    await projector.handleNotification(turnCompleted());

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual(["OK from raw"]);
    expect(result.lastAssistant?.content).toEqual([{ type: "text", text: "OK from raw" }]);
  });
});
