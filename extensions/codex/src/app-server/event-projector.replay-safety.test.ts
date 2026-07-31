import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  embeddedAgentLog,
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
  findAgentEvent,
  forCurrentTurn,
  agentMessageDelta,
  turnCompleted,
  type DiagnosticEventPayload,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector replay safety and progress projection", () => {
  it("clears a prior terminal presentation after a native tool completes", async () => {
    let terminalPresentation: string | undefined = "stale web fetch";
    const projector = await createProjector({
      ...(await createParams()),
      onToolOutcome: (observation) => {
        terminalPresentation = observation.terminalPresentation;
      },
    });
    const item = {
      type: "commandExecution",
      id: "command-clear-presentation",
      command: "git status --short",
      cwd: "/workspace",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [{ type: "unknown", command: "git status --short" }],
      aggregatedOutput: "",
      exitCode: 0,
      durationMs: 1,
    };

    await projector.handleNotification(forCurrentTurn("item/started", { item }));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item,
      }),
    );

    expect(terminalPresentation).toBeUndefined();
  });

  it("clears a prior terminal presentation after an unprojected native tool completes", async () => {
    let terminalPresentation: string | undefined = "stale web fetch";
    const projector = await createProjector({
      ...(await createParams()),
      onToolOutcome: (observation) => {
        terminalPresentation = observation.terminalPresentation;
      },
    });

    await projector.handleNotification(
      turnCompleted([
        {
          type: "imageView",
          id: "image-view-clear-presentation",
          path: "/workspace/reference.png",
        },
        {
          type: "dynamicToolCall",
          id: "stale-dynamic-tool",
          turnId: "turn-old",
          tool: "web_fetch",
          status: "completed",
        },
      ]),
    );

    expect(terminalPresentation).toBeUndefined();
  });

  it("keeps a later dynamic presentation over an earlier snapshot-only native tool", async () => {
    let terminalPresentation: string | undefined = "later dynamic result";
    let latestOrdinal = 1;
    let nextOrdinal = 0;
    const projector = await createProjector({
      ...(await createParams()),
      allocateToolOutcomeOrdinal: () => nextOrdinal++,
      onToolOutcome: (observation) => {
        const ordinal = observation.toolCallOrdinal ?? latestOrdinal + 1;
        if (ordinal >= latestOrdinal) {
          latestOrdinal = ordinal;
          terminalPresentation = observation.terminalPresentation;
        }
      },
    });
    const nativeItem = {
      type: "imageView",
      id: "image-view-before-dynamic",
      path: "/workspace/reference.png",
    };

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: nativeItem,
      }),
    );

    await projector.handleNotification(
      turnCompleted([
        nativeItem,
        {
          type: "dynamicToolCall",
          id: "dynamic-after-image-view",
          turnId: TURN_ID,
          tool: "web_fetch",
          status: "completed",
        },
        {
          type: "imageView",
          id: "stale-image-view",
          turnId: "turn-old",
          path: "/workspace/stale.png",
        },
      ]),
    );

    expect(terminalPresentation).toBe("later dynamic result");
  });

  it("clears a prior presentation for a completion-only native item without a turn snapshot", async () => {
    let terminalPresentation: string | undefined = "stale dynamic result";
    let nextOrdinal = 1;
    const projector = await createProjector({
      ...(await createParams()),
      allocateToolOutcomeOrdinal: () => nextOrdinal++,
      onToolOutcome: (observation) => {
        terminalPresentation = observation.terminalPresentation;
      },
    });

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "imageView",
          id: "completion-only-image-view",
          path: "/workspace/reference.png",
        },
      }),
    );
    await projector.handleNotification(turnCompleted([]));

    expect(terminalPresentation).toBeUndefined();
  });

  it("treats native image generation without a saved path as side-effect evidence", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      turnCompleted([
        {
          type: "imageGeneration",
          id: "image-generation-side-effect",
          status: "completed",
          revisedPrompt: null,
          result: "generated-image-result",
        },
      ]),
    );

    expect(projector.buildResult(buildEmptyToolTelemetry()).replayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("keeps executed dynamic tools side-effecting when their result is rewritten as blocked", async () => {
    const projector = await createProjector();

    projector.recordDynamicToolCall({
      callId: "call-bash-blocked",
      tool: "bash",
      arguments: { command: "touch blocked.txt" },
    });
    projector.recordDynamicToolResult({
      callId: "call-bash-blocked",
      tool: "bash",
      success: false,
      terminalType: "blocked",
      sideEffectEvidence: true,
      contentItems: [{ type: "inputText", text: "blocked" }],
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

  it("treats completed native MCP tool calls as side-effect evidence", async () => {
    const projector = await createProjector();

    await projector.handleNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "mcp-1",
          type: "mcpToolCall",
          server: "github",
          tool: "create_issue",
          status: "completed",
          arguments: { title: "check replay safety" },
        },
      },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

  it("treats native collaboration calls as side-effect evidence", async () => {
    const projector = await createProjector();

    await projector.handleNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "collab-1",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "thread-1",
          receiverThreadIds: ["child-thread-1"],
          prompt: "Inspect the replay path",
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        },
      },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

  it("suppresses transcript progress for message-like tools", async () => {
    const onAgentEvent = vi.fn();
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      onAgentEvent,
      onToolResult,
    });

    projector.recordDynamicToolCall({
      callId: "call-message-1",
      tool: "message",
      arguments: { action: "send", text: "hello" },
    });
    projector.recordDynamicToolResult({
      callId: "call-message-1",
      tool: "message",
      success: true,
      contentItems: [{ type: "inputText", text: "sent" }],
    });

    const toolEvents = onAgentEvent.mock.calls.filter(([event]) => {
      const record = requireRecord(event, "agent event");
      return record.stream === "tool";
    });
    expect(toolEvents).toHaveLength(0);
    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("does not parse shell command text to suppress transcript progress", async () => {
    const onAgentEvent = vi.fn();
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      onAgentEvent,
      onToolResult,
    });

    projector.recordDynamicToolCall({
      callId: "call-log-activity-1",
      tool: "bash",
      arguments: {
        command:
          '/bin/bash -lc \'/home/openclaw/.openclaw/workspace/bin/log_activity.sh "web_search" "Grilled salmon research"\'',
        cwd: "/workspace",
      },
    });
    projector.recordDynamicToolResult({
      callId: "call-log-activity-1",
      tool: "bash",
      success: true,
      contentItems: [{ type: "inputText", text: "Logged: [web_search] Grilled salmon research" }],
    });

    expect(onAgentEvent).not.toHaveBeenCalled();
    const toolProgressText = onToolResult.mock.calls
      .map(([payload]) => (payload as { text?: string }).text ?? "")
      .join("\n");
    expect(toolProgressText).toContain("log_activity.sh");

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.messagesSnapshot.some((message) => message.role === "toolResult")).toBe(true);
  });

  it("keeps diagnostics for exact message-like native tool items while suppressing progress", async () => {
    const onAgentEvent = vi.fn();
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      onAgentEvent,
      onToolResult,
    });
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));

    try {
      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item: {
            type: "mcpToolCall",
            id: "mcp-message-1",
            server: null,
            tool: "message",
            arguments: { text: "hello" },
            status: "inProgress",
            result: null,
            error: null,
            durationMs: null,
          },
        }),
      );
      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: {
            type: "mcpToolCall",
            id: "mcp-message-1",
            server: null,
            tool: "message",
            arguments: { text: "hello" },
            status: "completed",
            result: { ok: true },
            error: null,
            durationMs: 7,
          },
        }),
      );
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    const toolEvents = onAgentEvent.mock.calls.filter(([event]) => {
      const record = requireRecord(event, "agent event");
      return record.stream === "tool";
    });
    expect(toolEvents).toHaveLength(0);
    expect(onToolResult).not.toHaveBeenCalled();

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
      })),
    ).toEqual([
      {
        type: "tool.execution.started",
        toolName: "message",
        toolCallId: "mcp-message-1",
        durationMs: undefined,
      },
      {
        type: "tool.execution.completed",
        toolName: "message",
        toolCallId: "mcp-message-1",
        durationMs: 7,
      },
    ]);
  });

  it("does not suppress qualified external tools that end with message-like names", async () => {
    const onAgentEvent = vi.fn();
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      onAgentEvent,
      onToolResult,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "mcpToolCall",
          id: "mcp-email-send-1",
          server: "email",
          tool: "send",
          arguments: { to: "user@example.com" },
          status: "inProgress",
          result: null,
          error: null,
          durationMs: null,
        },
      }),
    );

    const toolStart = findAgentEvent(onAgentEvent, {
      stream: "tool",
      phase: "start",
      itemId: "mcp-email-send-1",
      name: "email.send",
    }).data;
    expect(toolStart.toolCallId).toBe("mcp-email-send-1");
    expect(onToolResult).toHaveBeenCalledWith({
      text: "🧩 Email.send: `user@example.com`",
    });
  });

  it("marks declined Codex-native tool results as non-success", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-declined",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "declined",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      }),
    );

    const itemEnd = findAgentEvent(onAgentEvent, {
      stream: "item",
      phase: "end",
      itemId: "cmd-declined",
    }).data;
    expect(itemEnd.kind).toBe("command");
    expect(itemEnd.name).toBe("bash");
    expect(itemEnd.status).toBe("blocked");
    expect(itemEnd.suppressChannelProgress).toBe(true);
    const toolResult = findAgentEvent(onAgentEvent, {
      stream: "tool",
      phase: "result",
      itemId: "cmd-declined",
      name: "bash",
    }).data;
    expect(toolResult.toolCallId).toBe("cmd-declined");
    expect(toolResult.status).toBe("blocked");
    expect(toolResult.isError).toBe(true);
  });

  it("warns once and preserves projection for an unknown Codex-native item status", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    const notification = forCurrentTurn("item/completed", {
      item: {
        type: "commandExecution",
        id: "cmd-future-status",
        command: "pnpm test extensions/codex",
        cwd: "/workspace",
        processId: null,
        source: "agent",
        status: "pausedByProtocol",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    });

    await projector.handleNotification(notification);
    await projector.handleNotification(notification);

    expect(
      findAgentEvent(onAgentEvent, {
        stream: "item",
        phase: "end",
        itemId: "cmd-future-status",
      }).data.status,
    ).toBe("completed");
    const toolResult = findAgentEvent(onAgentEvent, {
      stream: "tool",
      phase: "result",
      itemId: "cmd-future-status",
      name: "bash",
    }).data;
    expect(toolResult).toMatchObject({ status: "completed", isError: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "codex app-server item reported unknown status; continuing projection",
      {
        itemId: "cmd-future-status",
        itemType: "commandExecution",
        status: "pausedByProtocol",
      },
    );
  });

  it("warns once per raw unknown event kind and continues projecting known events", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const params = await createParams();
    const onPartialReply = vi.fn();
    const projector = await createProjector({ ...params, onPartialReply });
    await projector.handleNotification(forCurrentTurn("thread/compacted", {}));
    expect(warn).not.toHaveBeenCalled();
    const rawEventKind = "item/futureStatus/updated\nforged";
    const collidingSanitizedEventKind = "item/futureStatus/updated\\nforged";
    const notification = forCurrentTurn(rawEventKind, {
      itemId: "future-1",
    });

    await projector.handleNotification(notification);
    await projector.handleNotification(notification);
    await projector.handleNotification(
      forCurrentTurn(collidingSanitizedEventKind, { itemId: "future-2" }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "msg-after-unknown", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("still projects", "msg-after-unknown"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "msg-after-unknown",
          phase: "final_answer",
          text: "still projects",
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "msg-after-unknown",
          phase: "final_answer",
          text: "still projects",
        },
      ]),
    );

    expect(projector.buildResult(buildEmptyToolTelemetry()).assistantTexts).toEqual([
      "still projects",
    ]);
    expect(onPartialReply).toHaveBeenCalledWith({
      text: "still projects",
      delta: "still projects",
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "codex app-server projector received unknown event kind; continuing: item/futureStatus/updated\\nforged",
      {
        eventKind: "item/futureStatus/updated\\nforged",
        activeThreadId: THREAD_ID,
        activeTurnId: TURN_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        matchesActiveThread: true,
        matchesActiveTurn: true,
      },
    );
  });

  it("leaves Codex dynamic tool item progress to item/tool/call normalization", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "dynamicToolCall",
          id: "call-1",
          namespace: null,
          tool: "message",
          arguments: { action: "send" },
          status: "inProgress",
          contentItems: null,
          success: null,
          durationMs: null,
        },
      }),
    );

    const itemStart = findAgentEvent(onAgentEvent, {
      stream: "item",
      phase: "start",
      name: "message",
    }).data;
    expect(itemStart.kind).toBe("tool");
    expect(itemStart.suppressChannelProgress).toBe(true);
    const calls = (onAgentEvent as { mock: { calls: unknown[][] } }).mock.calls;
    const toolStart = calls.some((call) => {
      const event = requireRecord(call[0], "agent event");
      if (event.stream !== "tool") {
        return false;
      }
      const data = requireRecord(event.data, "agent event data");
      return data.phase === "start" && data.name === "message";
    });
    expect(toolStart).toBe(false);
  });
});
