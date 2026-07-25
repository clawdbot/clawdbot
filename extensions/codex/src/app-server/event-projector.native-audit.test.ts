import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  onInternalDiagnosticEvent,
  expect,
  it,
  vi,
  THREAD_ID,
  flushDiagnosticEvents,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  requireRecord,
  requireArray,
  findAgentEvent,
  forCurrentTurn,
  type DiagnosticEventPayload,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector native tool audit projection", () => {
  it("synthesizes normalized tool progress for Codex-native tool items", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));

    try {
      await projector.handleNotification(
        forCurrentTurn("item/started", {
          startedAtMs: 1_750_000_000_000,
          item: {
            type: "commandExecution",
            id: "cmd-1",
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
        forCurrentTurn("item/completed", {
          completedAtMs: 1_750_000_000_042,
          item: {
            type: "commandExecution",
            id: "cmd-1",
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
        }),
      );
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    const itemStart = findAgentEvent(onAgentEvent, {
      stream: "item",
      phase: "start",
      itemId: "cmd-1",
    }).data;
    expect(itemStart.kind).toBe("command");
    expect(itemStart.name).toBe("bash");
    expect(itemStart.suppressChannelProgress).toBe(true);
    const toolStart = findAgentEvent(onAgentEvent, {
      stream: "tool",
      phase: "start",
      itemId: "cmd-1",
      name: "bash",
    }).data;
    expect(toolStart.toolCallId).toBe("cmd-1");
    expect(toolStart.args).toEqual({ command: "pnpm test extensions/codex", cwd: "/workspace" });
    const toolResult = findAgentEvent(onAgentEvent, {
      stream: "tool",
      phase: "result",
      itemId: "cmd-1",
      name: "bash",
    }).data;
    expect(toolResult.toolCallId).toBe("cmd-1");
    expect(toolResult.status).toBe("completed");
    expect(toolResult.isError).toBe(false);
    const toolResultPayload = requireRecord(toolResult.result, "tool result payload");
    expect(toolResultPayload.exitCode).toBe(0);
    expect(toolResultPayload.durationMs).toBe(42);
    const toolDiagnosticEvents = diagnosticEvents.filter(
      (
        event,
      ): event is Extract<
        DiagnosticEventPayload,
        {
          type:
            | "tool.execution.started"
            | "tool.execution.completed"
            | "tool.execution.error"
            | "tool.execution.blocked";
        }
      > => event.type.startsWith("tool.execution."),
    );
    expect(
      toolDiagnosticEvents.map((event) => ({
        type: event.type,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        durationMs: "durationMs" in event ? event.durationMs : undefined,
        sourceTimestampMs: event.sourceTimestampMs,
      })),
    ).toEqual([
      {
        type: "tool.execution.started",
        toolName: "bash",
        toolCallId: "cmd-1",
        durationMs: undefined,
        sourceTimestampMs: 1_750_000_000_000,
      },
      {
        type: "tool.execution.completed",
        toolName: "bash",
        toolCallId: "cmd-1",
        durationMs: 42,
        sourceTimestampMs: 1_750_000_000_042,
      },
    ]);
    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    const assistant = requireRecord(result.messagesSnapshot[1], "assistant tool call message");
    expect(assistant.role).toBe("assistant");
    const assistantContent = requireArray(assistant.content, "assistant content");
    expect(assistantContent[0]).toEqual({
      type: "toolCall",
      id: "cmd-1",
      name: "bash",
      arguments: { command: "pnpm test extensions/codex", cwd: "/workspace" },
      input: { command: "pnpm test extensions/codex", cwd: "/workspace" },
    });
    const toolResultMessage = requireRecord(result.messagesSnapshot[2], "tool result message");
    expect(toolResultMessage.role).toBe("toolResult");
    expect(toolResultMessage.toolCallId).toBe("cmd-1");
    expect(toolResultMessage.toolName).toBe("bash");
    expect(toolResultMessage.isError).toBe(false);
    const toolResultContent = requireArray(toolResultMessage.content, "tool result content");
    const toolResultContentItem = requireRecord(toolResultContent[0], "tool result content item");
    expect(toolResultContentItem.type).toBe("toolResult");
    expect(toolResultContentItem.id).toBe("cmd-1");
    expect(toolResultContentItem.name).toBe("bash");
    expect(toolResultContentItem.toolName).toBe("bash");
    expect(toolResultContentItem.toolCallId).toBe("cmd-1");
    expect(toolResultContentItem.content).toBe("ok");
  });

  it("preserves structured file-change diffs in mirrored transcript calls", async () => {
    const projector = await createProjector();
    const changes = [
      {
        path: "src/updated.ts",
        kind: { type: "update", move_path: null },
        diff: [
          "--- a/src/updated.ts",
          "+++ b/src/updated.ts",
          "@@ -1 +1,2 @@",
          "-old",
          "+new",
          "+another",
          "",
        ].join("\n"),
      },
      {
        path: "src/created.ts",
        kind: { type: "add" },
        diff: "first\nsecond\n",
      },
      {
        path: "src/deleted.ts",
        kind: { type: "delete" },
        diff: "removed\n",
      },
    ];

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "fileChange",
          id: "patch-structured",
          changes,
          status: "completed",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const assistant = requireRecord(result.messagesSnapshot[1], "assistant tool call message");
    const assistantContent = requireArray(assistant.content, "assistant content");
    const toolCall = requireRecord(assistantContent[0], "file-change tool call");
    const expectedChanges = [
      { ...changes[0], stat: { added: 2, removed: 1 } },
      { ...changes[1], stat: { added: 2, removed: 0 } },
      { ...changes[2], stat: { added: 0, removed: 1 } },
    ];
    expect(toolCall.name).toBe("apply_patch");
    expect(toolCall.arguments).toEqual({ changes: expectedChanges });
    expect(toolCall.input).toEqual({ changes: expectedChanges });
  });

  it("bounds mirrored file-change diffs without losing full stats", async () => {
    const diff = [
      "--- a/src/large.ts",
      "+++ b/src/large.ts",
      "@@ -1 +1,200 @@",
      "-old",
      ...Array.from({ length: 200 }, (_, index) => `+${index}-${"x".repeat(96)}`),
      "",
    ].join("\n");
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "fileChange",
          id: "patch-large",
          changes: [{ path: "src/large.ts", kind: { type: "update" }, diff }],
          status: "completed",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const assistant = requireRecord(result.messagesSnapshot[1], "assistant tool call message");
    const assistantContent = requireArray(assistant.content, "assistant content");
    const toolCall = requireRecord(assistantContent[0], "file-change tool call");
    const args = requireRecord(toolCall.arguments, "file-change arguments");
    const projectedChanges = requireArray(args.changes, "projected file changes");
    const projectedChange = requireRecord(projectedChanges[0], "projected file change");
    const projectedDiff = projectedChange.diff;
    expect(typeof projectedDiff).toBe("string");
    if (typeof projectedDiff !== "string") {
      throw new Error("Expected bounded file-change diff");
    }
    expect(projectedDiff.length).toBeLessThanOrEqual(12_000);
    expect(projectedDiff.endsWith("\n")).toBe(true);
    expect(diff.startsWith(projectedDiff)).toBe(true);
    expect(projectedChange.diffTruncated).toBe(true);
    expect(projectedChange.stat).toEqual({ added: 200, removed: 1 });
  });

  it.each([
    ["cancelled", "cancelled"],
    [Object.assign(new Error("turn timed out"), { name: "TimeoutError" }), "timed_out"],
  ] as const)(
    "preserves enclosing %s provenance for failed native tools",
    async (abortReason, terminalReason) => {
      const abortController = new AbortController();
      abortController.abort(abortReason);
      const diagnosticEvents: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
      const projector = await createProjector(undefined, {
        runAbortSignal: abortController.signal,
      });
      const commandItem = {
        type: "commandExecution",
        id: "cmd-aborted",
        command: "pnpm test extensions/codex",
        cwd: "/workspace",
        processId: null,
        source: "agent",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      };

      try {
        await projector.handleNotification(forCurrentTurn("item/started", { item: commandItem }));
        await projector.handleNotification(
          forCurrentTurn("item/completed", {
            item: { ...commandItem, status: "failed", durationMs: 4 },
          }),
        );
        await flushDiagnosticEvents();
      } finally {
        unsubscribe();
      }

      expect(diagnosticEvents).toContainEqual(
        expect.objectContaining({
          type: "tool.execution.error",
          toolCallId: "cmd-aborted",
          terminalReason,
        }),
      );
    },
  );

  it.each([
    ["cancelled", "cancelled"],
    [Object.assign(new Error("turn timed out"), { name: "TimeoutError" }), "timed_out"],
  ] as const)(
    "finalizes an active native tool as %s when building an interrupted result",
    async (abortReason, terminalReason) => {
      const abortController = new AbortController();
      abortController.abort(abortReason);
      const diagnosticEvents: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
      const projector = await createProjector(undefined, {
        runAbortSignal: abortController.signal,
      });

      try {
        await projector.handleNotification(
          forCurrentTurn("item/started", {
            item: {
              type: "commandExecution",
              id: "cmd-active-abort",
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
        projector.buildResult(buildEmptyToolTelemetry());
        await flushDiagnosticEvents();
      } finally {
        unsubscribe();
      }

      expect(diagnosticEvents).toContainEqual(
        expect.objectContaining({
          type: "tool.execution.error",
          toolCallId: "cmd-active-abort",
          terminalReason,
        }),
      );
      expect(
        diagnosticEvents
          .filter((event) => "toolCallId" in event && event.toolCallId === "cmd-active-abort")
          .map((event) => event.type),
      ).toEqual(["tool.execution.started", "tool.execution.error"]);
    },
  );

  it.each([
    [
      "collaboration",
      {
        id: "collab-audit-1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: THREAD_ID,
        receiverThreadIds: ["child-thread-1"],
        prompt: "sensitive prompt text",
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      },
      "collab.spawnAgent",
    ],
    [
      "image generation",
      {
        id: "image-generation-audit-1",
        type: "imageGeneration",
        status: "completed",
        revisedPrompt: "sensitive revised prompt",
        result: "sensitive image payload",
      },
      "image_generation",
    ],
    [
      "image view",
      {
        id: "image-view-audit-1",
        type: "imageView",
        path: "/workspace/sensitive-filename.png",
      },
      "image_view",
    ],
    [
      "sleep",
      {
        id: "sleep-audit-1",
        type: "sleep",
        durationMs: 250,
      },
      "sleep",
    ],
  ] as const)(
    "emits metadata-only lifecycle diagnostics for native %s items",
    async (_, item, toolName) => {
      const diagnosticEvents: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
      const projector = await createProjector();

      try {
        await projector.handleNotification(
          forCurrentTurn("item/started", { item, startedAtMs: 1_750_000_000_000 }),
        );
        await projector.handleNotification(
          forCurrentTurn("item/completed", { item, completedAtMs: 1_750_000_000_042 }),
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
            toolName: "toolName" in event ? event.toolName : null,
          })),
      ).toEqual([
        { type: "tool.execution.started", toolName },
        { type: "tool.execution.completed", toolName },
      ]);
      expect(JSON.stringify(diagnosticEvents)).not.toContain("sensitive");
    },
  );

  it.each([
    ["completed", "tool.execution.completed", undefined, undefined],
    ["failed", "tool.execution.error", "failed", undefined],
    ["cancelled", "tool.execution.error", "cancelled", undefined],
    [undefined, "tool.execution.error", "failed", "tool_outcome_unknown"],
    ["future_status", "tool.execution.error", "failed", "tool_outcome_unknown"],
  ] as const)(
    "uses raw %s status for redacted native web-search audit actions",
    async (status, terminalType, terminalReason, errorCode) => {
      const diagnosticEvents: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
      const projector = await createProjector();
      const item = {
        id: "web-search-audit-1",
        type: "webSearch",
        query: "sensitive query",
        action: { type: "search", query: "sensitive query", queries: null },
      };

      try {
        await projector.handleNotification(
          forCurrentTurn("item/started", { item, startedAtMs: 1_750_000_000_000 }),
        );
        await projector.handleNotification(
          forCurrentTurn("item/completed", { item, completedAtMs: 1_750_000_000_042 }),
        );
        await projector.handleNotification(
          forCurrentTurn("rawResponseItem/completed", {
            item: {
              id: item.id,
              type: "web_search_call",
              status,
              action: item.action,
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
            toolName: "toolName" in event ? event.toolName : null,
            terminalReason: "terminalReason" in event ? event.terminalReason : undefined,
            errorCode: "errorCode" in event ? event.errorCode : undefined,
            sourceTimestampMs: "sourceTimestampMs" in event ? event.sourceTimestampMs : undefined,
          })),
      ).toEqual([
        {
          type: "tool.execution.started",
          toolName: "web_search",
          terminalReason: undefined,
          errorCode: undefined,
          sourceTimestampMs: 1_750_000_000_000,
        },
        {
          type: terminalType,
          toolName: "web_search",
          terminalReason,
          errorCode,
          sourceTimestampMs: 1_750_000_000_042,
        },
      ]);
      expect(JSON.stringify(diagnosticEvents)).not.toContain("sensitive");
    },
  );
});
