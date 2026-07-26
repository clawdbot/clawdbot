import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  formatToolAggregate,
  inferToolMetaFromArgs,
  expect,
  it,
  vi,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  mockCallArg,
  forCurrentTurn,
  turnCompleted,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector streamed output echo filtering", () => {
  it("keeps typed agentMessage finals that verbatim-equal tool progress text", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      onToolResult,
    });
    const commandOutput = "command-output-line\nsecond-line";

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-verbatim",
          command: "cat result.txt",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-verbatim",
        delta: commandOutput,
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-verbatim",
          command: "cat result.txt",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: commandOutput,
          exitCode: 0,
          durationMs: 12,
        },
      }),
    );
    // Typed finals are deliberate model output, including verbatim tool output.
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "msg-verbatim",
          text: commandOutput,
        },
      }),
    );
    await projector.handleNotification(turnCompleted());

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual([commandOutput]);
    expect(result.lastAssistant).toBeDefined();
    expect(result.currentAttemptAssistant).toBeDefined();
  });

  it("does not promote a raw echo of an earlier tool progress summary after later stream output", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "full",
      onToolResult,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-multi-shape",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      }),
    );
    const summaryText = (mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string }).text;
    expect(summaryText).toBe("🛠️ `run tests (workspace)`");

    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-multi-shape",
        delta: "streamed-output-chunk-that-would-overwrite-summary",
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-earlier-summary",
          role: "assistant",
          content: [{ type: "output_text", text: summaryText }],
        },
      }),
    );
    await projector.handleNotification(turnCompleted());

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.currentAttemptAssistant).toBeUndefined();
  });

  it("does not promote a raw echo of the start summary after a full mechanical stream of chunks", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "full",
      onToolResult,
    });
    const command = "pnpm test extensions/codex";
    const cwd = `/very-long-root/${"a".repeat(10_500)}`;
    const originalSummaryText = formatToolAggregate(
      "bash",
      [inferToolMetaFromArgs("exec", { command, cwd }, { detailMode: "explain" }) ?? ""],
      { markdown: true },
    );
    expect(originalSummaryText.length).toBeGreaterThan(1_024);

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-full-stream-cap",
          command,
          cwd,
          processId: null,
          source: "agent",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      }),
    );
    const emittedSummary = (mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string })
      .text;
    expect(emittedSummary).toBeTruthy();

    // Mechanical max stream messages; each chunk ≥ TOOL_PROGRESS_ECHO_PREFIX_MIN_CHARS so it
    // registers a distinct raw signature. Cap must keep the start summary through all of them.
    const streamChunkCount = 20;
    const streamChunk = "s".repeat(1_500);
    for (let i = 0; i < streamChunkCount; i += 1) {
      await projector.handleNotification(
        forCurrentTurn("item/commandExecution/outputDelta", {
          itemId: "cmd-full-stream-cap",
          delta: `${streamChunk}${i}`,
        }),
      );
    }

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-original-start-summary",
          role: "assistant",
          content: [{ type: "output_text", text: originalSummaryText }],
        },
      }),
    );
    await projector.handleNotification(turnCompleted());

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.currentAttemptAssistant).toBeUndefined();
  });

  it("does not promote raw echoes of either an oversized summary or a later shorter stream", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "full",
      onToolResult,
    });
    const command = "pnpm test";
    const cwd = `/very-long-root/${"a".repeat(10_500)}`;
    const rawSummaryText = formatToolAggregate(
      "bash",
      [inferToolMetaFromArgs("exec", { command, cwd }, { detailMode: "explain" }) ?? ""],
      { markdown: true },
    );
    expect(rawSummaryText.length).toBeGreaterThan(10_000);
    const streamedOutput = `${"o".repeat(2_000)}stream-tail`;

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-summary-then-stream",
          command,
          cwd,
          processId: null,
          source: "agent",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      }),
    );
    const emittedSummary = (mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string })
      .text;
    expect(emittedSummary).toHaveLength(10_000);

    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-summary-then-stream",
        delta: streamedOutput,
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-oversized-summary-shape",
          role: "assistant",
          content: [{ type: "output_text", text: rawSummaryText }],
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-shorter-stream-shape",
          role: "assistant",
          content: [{ type: "output_text", text: streamedOutput }],
        },
      }),
    );
    await projector.handleNotification(turnCompleted());

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.currentAttemptAssistant).toBeUndefined();
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain(rawSummaryText.slice(0, 1_000));
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("stream-tail");
  });

  it("does not promote summary or stream echoes after fine-grained streamed deltas", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "full",
      onToolResult,
    });
    const command = "pnpm test";
    const cwd = `/very-long-root/${"a".repeat(10_500)}`;
    const originalSummaryText = formatToolAggregate(
      "bash",
      [inferToolMetaFromArgs("exec", { command, cwd }, { detailMode: "explain" }) ?? ""],
      { markdown: true },
    );
    expect(originalSummaryText.length).toBeGreaterThan(10_000);

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-fine-stream-slots",
          command,
          cwd,
          processId: null,
          source: "agent",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      }),
    );
    const emittedSummary = (mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string })
      .text;
    expect(emittedSummary).toHaveLength(10_000);

    // Fine-grained pipe chunks: ~40 distinct cumulative prefixes would overflow the old
    // FIFO (cap 24) and evict the start-summary signature. Stream owns one dedicated slot.
    const streamChunkCount = 40;
    const streamChunk = "s".repeat(300);
    const streamedChunks: string[] = [];
    for (let i = 0; i < streamChunkCount; i += 1) {
      const delta = `${streamChunk}${String(i).padStart(2, "0")}`;
      streamedChunks.push(delta);
      await projector.handleNotification(
        forCurrentTurn("item/commandExecution/outputDelta", {
          itemId: "cmd-fine-stream-slots",
          delta,
        }),
      );
    }
    const fullStreamedOutput = streamedChunks.join("");

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-original-summary-after-fine-stream",
          role: "assistant",
          content: [{ type: "output_text", text: originalSummaryText }],
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-full-streamed-output-after-fine-stream",
          role: "assistant",
          content: [{ type: "output_text", text: fullStreamedOutput }],
        },
      }),
    );
    await projector.handleNotification(turnCompleted());

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.currentAttemptAssistant).toBeUndefined();
  });
});
