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
  it("emits native context-window and prompt-token snapshots", async () => {
    const params = await createParams();
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...params, onAgentEvent });

    await projector.handleNotification(
      forCurrentTurn("thread/tokenUsage/updated", {
        tokenUsage: {
          modelContextWindow: 875_900,
          last: {
            totalTokens: 300_010,
            inputTokens: 300_000,
            cachedInputTokens: 250_000,
            outputTokens: 10,
          },
        },
      }),
    );

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "codex_app_server.usage",
      data: { modelContextWindow: 875_900, promptTokens: 300_000 },
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

  it("accumulates distinct raw responses while keeping the final response fresh", async () => {
    const onRawResponseCompleted = vi.fn();
    const projector = await createProjector(undefined, { onRawResponseCompleted });

    await projector.handleNotification(agentMessageDelta("done"));
    await projector.handleNotification(
      forCurrentTurn("rawResponse/completed", {
        responseId: "response-1",
        usage: {
          totalTokens: 12,
          inputTokens: 5,
          cachedInputTokens: 2,
          outputTokens: 7,
          reasoningOutputTokens: 3,
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponse/completed", {
        responseId: "response-2",
        usage: {
          totalTokens: 20,
          inputTokens: 14,
          cachedInputTokens: 4,
          cacheWriteInputTokens: 2,
          outputTokens: 6,
          reasoningOutputTokens: 2,
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expectUsageFields(result.attemptUsage, {
      input: 11,
      output: 13,
      cacheRead: 6,
      cacheWrite: 2,
      total: 32,
    });
    expect(result.attemptUsage?.reasoningTokens).toBe(5);
    expect(result.attemptUsage?.contextUsage).toEqual({
      state: "available",
      promptTokens: 14,
      totalTokens: 20,
    });
    expectUsageFields(result.lastAssistant?.usage, {
      input: 8,
      output: 6,
      cacheRead: 4,
      cacheWrite: 2,
      total: 20,
    });
    expect(result.lastAssistant?.usage.contextUsage).toEqual({
      state: "available",
      promptTokens: 14,
      totalTokens: 20,
    });
    expect(onRawResponseCompleted).toHaveBeenCalledTimes(2);
    expect(onRawResponseCompleted.mock.calls).toEqual([
      [
        expect.objectContaining({
          responseId: "response-1",
          usage: expect.objectContaining({ input: 3, output: 7, cacheRead: 2, total: 12 }),
          completedAtMs: expect.any(Number),
        }),
      ],
      [
        expect.objectContaining({
          responseId: "response-2",
          usage: expect.objectContaining({
            input: 8,
            output: 6,
            cacheRead: 4,
            cacheWrite: 2,
            total: 20,
          }),
          completedAtMs: expect.any(Number),
        }),
      ],
    ]);
  });

  it("deduplicates raw responses by response id", async () => {
    const projector = await createProjector();
    const usage = {
      totalTokens: 12,
      inputTokens: 5,
      cachedInputTokens: 2,
      outputTokens: 7,
      reasoningOutputTokens: 1,
    };

    await projector.handleNotification(
      forCurrentTurn("rawResponse/completed", { responseId: "response-1", usage }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponse/completed", { responseId: "response-1", usage }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expectUsageFields(result.attemptUsage, { input: 3, output: 7, cacheRead: 2, total: 12 });
    expect(result.attemptUsage?.reasoningTokens).toBe(1);
  });

  it("does not publish a partial aggregate when a response id is missing", async () => {
    const projector = await createProjector();

    await projector.handleNotification(agentMessageDelta("done"));
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
    await projector.handleNotification(
      forCurrentTurn("rawResponse/completed", {
        usage: {
          totalTokens: 20,
          inputTokens: 14,
          cachedInputTokens: 4,
          outputTokens: 6,
          reasoningOutputTokens: 2,
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expectUsageFields(result.attemptUsage, { input: 3, output: 7, cacheRead: 2, total: 12 });
    expect(result.attemptUsage?.contextUsage).toEqual({ state: "unavailable" });
    expectUsageFields(result.lastAssistant?.usage, {
      input: 10,
      output: 6,
      cacheRead: 4,
      total: 20,
    });
    expect(result.lastAssistant?.usage.contextUsage).toEqual({
      state: "available",
      promptTokens: 14,
      totalTokens: 20,
    });
  });

  it("keeps cumulative-only thread usage unknown", async () => {
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
            outputTokens: 7,
            reasoningOutputTokens: 2,
          },
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual(["done"]);
    expectUsageFields(result.attemptUsage, { input: 3, output: 7, cacheRead: 2, total: 12 });
    expect(result.attemptUsage?.contextUsage).toEqual({ state: "unavailable" });
    expect(result.attemptUsage?.reasoningTokens).toBe(2);
    expectUsageFields(result.lastAssistant?.usage, {
      input: 3,
      output: 7,
      cacheRead: 2,
      total: 12,
    });
    expect(result.lastAssistant?.usage.contextUsage).toEqual({ state: "unavailable" });
  });

  it.each([
    ["incomplete", { totalTokens: 12 }],
    [
      "incoherent total",
      {
        totalTokens: 6,
        inputTokens: 5,
        cachedInputTokens: 2,
        outputTokens: 7,
        reasoningOutputTokens: 0,
      },
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
    ],
  ])("keeps %s response usage unknown", async (_label, usage) => {
    const onRawResponseCompleted = vi.fn();
    const projector = await createProjector(undefined, { onRawResponseCompleted });

    await projector.handleNotification(agentMessageDelta("done"));
    await projector.handleNotification(
      forCurrentTurn("rawResponse/completed", { responseId: "response-1", usage }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual(["done"]);
    expect(result.attemptUsage).toBeUndefined();
    expect(result.lastAssistant?.usage.contextUsage).toBeUndefined();
    expect(onRawResponseCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: "response-1",
        completedAtMs: expect.any(Number),
      }),
    );
    expect(onRawResponseCompleted.mock.calls[0]?.[0]).not.toHaveProperty("usage");
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

  it("keeps completed response accounting across retries and clears it on abort", async () => {
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
    const retrying = projector.buildResult(buildEmptyToolTelemetry());
    expectUsageFields(retrying.attemptUsage, {
      input: 3,
      output: 7,
      cacheRead: 2,
      total: 12,
    });
    expect(retrying.attemptUsage?.contextUsage).toEqual({ state: "unavailable" });

    await projector.handleNotification(
      forCurrentTurn("rawResponse/completed", {
        responseId: "response-2",
        usage: exactUsage,
      }),
    );
    const recovered = projector.buildResult(buildEmptyToolTelemetry());
    expectUsageFields(recovered.attemptUsage, {
      input: 6,
      output: 14,
      cacheRead: 4,
      total: 24,
    });
    expect(recovered.attemptUsage?.contextUsage).toEqual({
      state: "available",
      promptTokens: 5,
      totalTokens: 12,
    });

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
