import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  onInternalDiagnosticEvent,
  expect,
  it,
  vi,
  THREAD_ID,
  TURN_ID,
  flushDiagnosticEvents,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  requireRecord,
  requireArray,
  findAgentEvent,
  forCurrentTurn,
  turnCompleted,
  type DiagnosticEventPayload,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector native tool finalization", () => {
  it("keeps raw open-page status unknown until explicit completion", async () => {
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
    const projector = await createProjector();
    const item = {
      id: "web-search-open-page-1",
      type: "webSearch",
      query: "",
      action: { type: "openPage", url: "https://example.com/sensitive" },
    };

    try {
      await projector.handleNotification(forCurrentTurn("item/started", { item }));
      await projector.handleNotification(forCurrentTurn("item/completed", { item }));
      await projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: {
            id: item.id,
            type: "web_search_call",
            status: "open",
            action: { type: "open_page", url: "https://example.com/sensitive" },
          },
        }),
      );
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    expect(
      diagnosticEvents
        .filter((event) => "toolCallId" in event && event.toolCallId === item.id)
        .map((event) => ({
          type: event.type,
          terminalReason: "terminalReason" in event ? event.terminalReason : undefined,
          errorCode: "errorCode" in event ? event.errorCode : undefined,
        })),
    ).toEqual([
      {
        type: "tool.execution.started",
        terminalReason: undefined,
        errorCode: undefined,
      },
      {
        type: "tool.execution.error",
        terminalReason: "failed",
        errorCode: "tool_outcome_unknown",
      },
    ]);
    expect(JSON.stringify(diagnosticEvents)).not.toContain("sensitive");
  });

  it("keeps native web-search outcomes unknown at finalization when no raw terminal arrives", async () => {
    const abortController = new AbortController();
    abortController.abort("cancelled");
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
    const projector = await createProjector(undefined, {
      runAbortSignal: abortController.signal,
    });
    const item = {
      id: "web-search-without-raw-terminal",
      type: "webSearch",
      query: "sensitive extension query",
      action: { type: "search", query: "sensitive extension query", queries: null },
    };

    try {
      await projector.handleNotification(forCurrentTurn("item/started", { item }));
      await projector.handleNotification(forCurrentTurn("item/completed", { item }));
      projector.buildResult(buildEmptyToolTelemetry());
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    expect(
      diagnosticEvents
        .filter((event) => "toolCallId" in event && event.toolCallId === item.id)
        .map((event) => ({
          type: event.type,
          terminalReason: "terminalReason" in event ? event.terminalReason : undefined,
          errorCode: "errorCode" in event ? event.errorCode : undefined,
        })),
    ).toEqual([
      {
        type: "tool.execution.started",
        terminalReason: undefined,
        errorCode: undefined,
      },
      {
        type: "tool.execution.error",
        terminalReason: "failed",
        errorCode: "tool_outcome_unknown",
      },
    ]);
    expect(JSON.stringify(diagnosticEvents)).not.toContain("sensitive extension query");
  });

  it.each([
    [
      "web search",
      "cancelled",
      {
        id: "web-search-started-only",
        type: "webSearch",
        query: "sensitive query",
        action: { type: "search", query: "sensitive query", queries: null },
      },
    ],
    [
      "image generation",
      Object.assign(new Error("turn timed out"), { name: "TimeoutError" }),
      {
        id: "image-generation-started-only",
        type: "imageGeneration",
        status: "in_progress",
        revisedPrompt: "sensitive prompt",
        result: null,
      },
    ],
  ] as const)(
    "keeps started-only native %s outcomes unknown when the enclosing run stops",
    async (_, abortReason, item) => {
      const abortController = new AbortController();
      abortController.abort(abortReason);
      const diagnosticEvents: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
      const projector = await createProjector(undefined, {
        runAbortSignal: abortController.signal,
      });

      try {
        await projector.handleNotification(forCurrentTurn("item/started", { item }));
        projector.buildResult(buildEmptyToolTelemetry());
        await flushDiagnosticEvents();
      } finally {
        unsubscribe();
      }

      expect(
        diagnosticEvents
          .filter((event) => "toolCallId" in event && event.toolCallId === item.id)
          .map((event) => ({
            type: event.type,
            terminalReason: "terminalReason" in event ? event.terminalReason : undefined,
            errorCode: "errorCode" in event ? event.errorCode : undefined,
          })),
      ).toEqual([
        {
          type: "tool.execution.started",
          terminalReason: undefined,
          errorCode: undefined,
        },
        {
          type: "tool.execution.error",
          terminalReason: "failed",
          errorCode: "tool_outcome_unknown",
        },
      ]);
      expect(JSON.stringify(diagnosticEvents)).not.toContain("sensitive");
    },
  );

  it("projects native image-generation error status as a failed audit action", async () => {
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
    const projector = await createProjector();
    const startedItem = {
      id: "image-generation-error-1",
      type: "imageGeneration",
      status: "in_progress",
      revisedPrompt: null,
      result: null,
    };

    try {
      await projector.handleNotification(forCurrentTurn("item/started", { item: startedItem }));
      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: { ...startedItem, status: "error" },
        }),
      );
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    expect(
      diagnosticEvents
        .filter((event) => "toolCallId" in event && event.toolCallId === startedItem.id)
        .map((event) => ({
          type: event.type,
          terminalReason: "terminalReason" in event ? event.terminalReason : undefined,
        })),
    ).toEqual([
      { type: "tool.execution.started", terminalReason: undefined },
      { type: "tool.execution.error", terminalReason: "failed" },
    ]);
  });

  it.each([
    ["missing", undefined, undefined],
    ["in-progress", "in_progress", undefined],
    [
      "unrecognized",
      "future_status",
      Object.assign(new Error("turn timed out"), { name: "TimeoutError" }),
    ],
  ] as const)(
    "keeps %s native image-generation terminal status non-successful",
    async (_, status, abortReason) => {
      const abortController = new AbortController();
      if (abortReason) {
        abortController.abort(abortReason);
      }
      const diagnosticEvents: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
      const projector = await createProjector(undefined, {
        runAbortSignal: abortController.signal,
      });
      const startedItem = {
        id: `image-generation-${status ?? "missing"}`,
        type: "imageGeneration",
        status: "in_progress",
        revisedPrompt: null,
        result: null,
      };

      try {
        await projector.handleNotification(forCurrentTurn("item/started", { item: startedItem }));
        await projector.handleNotification(
          forCurrentTurn("item/completed", { item: { ...startedItem, status } }),
        );
        await flushDiagnosticEvents();
      } finally {
        unsubscribe();
      }

      expect(
        diagnosticEvents
          .filter((event) => "toolCallId" in event && event.toolCallId === startedItem.id)
          .map((event) => ({
            type: event.type,
            terminalReason: "terminalReason" in event ? event.terminalReason : undefined,
            errorCode: "errorCode" in event ? event.errorCode : undefined,
          })),
      ).toEqual([
        {
          type: "tool.execution.started",
          terminalReason: undefined,
          errorCode: undefined,
        },
        {
          type: "tool.execution.error",
          terminalReason: "failed",
          errorCode: "tool_outcome_unknown",
        },
      ]);
    },
  );

  it("synthesizes native tool progress from turn completion snapshots", async () => {
    const onAgentEvent = vi.fn();
    const onToolResult = vi.fn();
    const trajectoryRecorder = {
      filePath: "trajectory.jsonl",
      recordEvent: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const projector = await createProjector(
      {
        ...(await createParams()),
        verboseLevel: "on",
        onAgentEvent,
        onToolResult,
      },
      {
        trajectoryRecorder,
      },
    );

    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-snapshot",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "ok",
          exitCode: 0,
          durationMs: 42,
        },
      ]),
    );

    const itemStart = findAgentEvent(onAgentEvent, {
      stream: "item",
      phase: "start",
      itemId: "cmd-snapshot",
    }).data;
    expect(itemStart.kind).toBe("command");
    expect(itemStart.name).toBe("bash");
    expect(itemStart.suppressChannelProgress).toBe(true);
    const toolStart = findAgentEvent(onAgentEvent, {
      stream: "tool",
      phase: "start",
      itemId: "cmd-snapshot",
      name: "bash",
    }).data;
    expect(toolStart.args).toEqual({ command: "pnpm test extensions/codex", cwd: "/workspace" });
    const toolResult = findAgentEvent(onAgentEvent, {
      stream: "tool",
      phase: "result",
      itemId: "cmd-snapshot",
      name: "bash",
    }).data;
    expect(toolResult.status).toBe("completed");
    expect(toolResult.isError).toBe(false);
    expect(onToolResult).toHaveBeenCalledWith({
      text: "🛠️ `run tests (workspace)`",
    });
    expect(trajectoryRecorder.recordEvent).toHaveBeenCalledWith("tool.call", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: "cmd-snapshot",
      toolCallId: "cmd-snapshot",
      name: "bash",
      arguments: { command: "pnpm test extensions/codex", cwd: "/workspace" },
    });
    expect(trajectoryRecorder.recordEvent).toHaveBeenCalledWith("tool.result", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: "cmd-snapshot",
      toolCallId: "cmd-snapshot",
      name: "bash",
      status: "completed",
      isError: false,
      result: { status: "completed", exitCode: 0, durationMs: 42 },
      output: "ok",
    });
  });

  it("caps oversized native command output before transcript, trajectory, and progress projection", async () => {
    const trajectoryRecorder = {
      filePath: "trajectory.jsonl",
      recordEvent: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const projector = await createProjector(
      {
        ...(await createParams()),
      },
      {
        trajectoryRecorder,
      },
    );
    const largeOutput = "x".repeat(12_345);

    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-large",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: largeOutput,
          exitCode: 0,
          durationMs: 42,
        },
      ]),
    );

    const output = (
      trajectoryRecorder.recordEvent.mock.calls.find(([type]) => type === "tool.result")?.[1] as
        | { output?: string }
        | undefined
    )?.output;
    expect(output).toHaveLength(10_000);
    expect(output).toContain("OpenClaw truncated Codex native tool output");
    expect(output).toContain("original 12345 chars");
    expect(output).toContain("showing 10000");

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResultMessage = result.messagesSnapshot.find(
      (message) => requireRecord(message, "message").role === "toolResult",
    );
    const toolResultContent = requireArray(
      requireRecord(toolResultMessage, "tool result message").content,
      "tool result content",
    );
    const toolResultContentItem = requireRecord(toolResultContent[0], "tool result content item");
    expect(toolResultContentItem.content).toHaveLength(10_000);
    expect(toolResultContentItem.content).toContain("OpenClaw truncated Codex native tool output");
  });

  it("delivers completed assistant text when a native tool call finishes without a matching result", async () => {
    const trajectoryRecorder = {
      filePath: "trajectory.jsonl",
      recordEvent: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const projector = await createProjector(await createParams(), { trajectoryRecorder });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-denied",
          command: "node scripts/report.js --publish",
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
      turnCompleted([
        {
          type: "agentMessage",
          id: "msg-denied",
          text: "The requested publish command was denied before execution.",
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.promptError).toBeNull();
    expect(result.promptErrorSource).toBeNull();
    expect(result.lastToolError).toMatchObject({
      toolName: "bash",
      error: expect.stringContaining("without a matching tool.result"),
      mutatingAction: true,
    });
    expect(result.lastToolError?.actionFingerprint).toContain("node scripts/report.js --publish");
    expect(result.assistantTexts).toEqual([
      "The requested publish command was denied before execution.",
    ]);
    expect(result.messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    const toolResultMessage = requireRecord(result.messagesSnapshot[2], "tool result message");
    expect(toolResultMessage.toolCallId).toBe("cmd-denied");
    expect(toolResultMessage.toolName).toBe("bash");
    expect(toolResultMessage.isError).toBe(true);
    const toolResultContent = requireArray(toolResultMessage.content, "tool result content");
    expect(JSON.stringify(toolResultContent)).toContain("matching tool.result");
    const finalAssistant = requireRecord(result.messagesSnapshot[3], "final assistant message");
    expect(finalAssistant.content).toEqual([
      {
        type: "text",
        text: "The requested publish command was denied before execution.",
      },
    ]);
    expect(trajectoryRecorder.recordEvent).toHaveBeenCalledWith("tool.call", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: "cmd-denied",
      toolCallId: "cmd-denied",
      name: "bash",
      arguments: {
        command: "node scripts/report.js --publish",
        cwd: "/workspace",
      },
    });
    expect(trajectoryRecorder.recordEvent).toHaveBeenCalledWith("tool.result", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: "cmd-denied",
      toolCallId: "cmd-denied",
      name: "bash",
      status: "failed",
      isError: true,
      result: { status: "failed", reason: "missing_tool_result" },
      output: expect.stringContaining("without a matching tool.result"),
    });
  });

  it("records promptError when a completed turn has only whitespace assistant text and an orphan tool call", async () => {
    const projector = await createProjector(await createParams());

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-whitespace",
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
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "msg-whitespace",
          text: "   \n\t  ",
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.promptError).toContain("without a matching tool.result");
    expect(result.promptErrorSource).toBe("prompt");
    expect(result.lastToolError).toBeUndefined();
    expect(result.assistantTexts).toEqual([]);
  });
});
