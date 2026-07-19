import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  vi,
  createCodexTestToolTerminalObserver,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  requireRecord,
  requireArray,
  mockCallArg,
  forCurrentTurn,
  agentMessageDelta,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector dynamic tool projection", () => {
  it("records dynamic OpenClaw tool calls in mirrored transcript snapshots", async () => {
    const projector = await createProjector();

    projector.recordDynamicToolCall({
      callId: "call-browser-1",
      tool: "browser",
      arguments: { action: "open", url: "http://127.0.0.1:3000" },
    });
    projector.recordDynamicToolResult({
      callId: "call-browser-1",
      tool: "browser",
      success: true,
      contentItems: [{ type: "inputText", text: "opened" }],
    });
    await projector.handleNotification(agentMessageDelta("done"));

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    const assistant = requireRecord(result.messagesSnapshot[1], "assistant tool call message");
    expect(assistant.role).toBe("assistant");
    expect(requireArray(assistant.content, "assistant content")[0]).toEqual({
      type: "toolCall",
      id: "call-browser-1",
      name: "browser",
      arguments: { action: "open", url: "http://127.0.0.1:3000" },
      input: { action: "open", url: "http://127.0.0.1:3000" },
    });
    const toolResultMessage = requireRecord(result.messagesSnapshot[2], "tool result message");
    expect(toolResultMessage.role).toBe("toolResult");
    expect(toolResultMessage.toolCallId).toBe("call-browser-1");
    expect(toolResultMessage.toolName).toBe("browser");
    expect(toolResultMessage.isError).toBe(false);
    const toolResultContent = requireRecord(
      requireArray(toolResultMessage.content, "tool result content")[0],
      "tool result content item",
    );
    expect(toolResultContent.type).toBe("toolResult");
    expect(toolResultContent.id).toBe("call-browser-1");
    expect(toolResultContent.name).toBe("browser");
    expect(toolResultContent.toolName).toBe("browser");
    expect(toolResultContent.toolCallId).toBe("call-browser-1");
    expect(toolResultContent.content).toBe("opened");
  });

  it("does not mirror Codex-native web searches into transcript snapshots", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "webSearch",
          id: "search-observed",
          status: "completed",
          durationMs: 5,
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(
      result.messagesSnapshot.some((message) => {
        const record = message as unknown as Record<string, unknown>;
        if (record.role === "toolResult") {
          return true;
        }
        const content = Array.isArray(record.content) ? record.content : [];
        return content.some((entry) => {
          return (
            typeof entry === "object" &&
            entry !== null &&
            (entry as Record<string, unknown>).type === "toolCall"
          );
        });
      }),
    ).toBe(false);
  });

  it("carries async-started dynamic tool metadata into attempt results", async () => {
    const projector = await createProjector();

    projector.recordDynamicToolCall({
      callId: "call-image-1",
      tool: "image_generate",
      arguments: { action: "generate", prompt: "lighthouse" },
    });
    projector.recordDynamicToolResult({
      callId: "call-image-1",
      tool: "image_generate",
      asyncStarted: true,
      success: true,
      sideEffectEvidence: true,
      contentItems: [{ type: "inputText", text: "Background task started." }],
    });
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "dynamicToolCall",
          id: "call-image-1",
          namespace: null,
          tool: "image_generate",
          arguments: { action: "generate", prompt: "lighthouse" },
          status: "completed",
          contentItems: [{ type: "inputText", text: "Background task started." }],
          success: true,
          durationMs: 10,
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.toolMetas).toEqual([
      {
        toolName: "image_generate",
        meta: "lighthouse",
        asyncStarted: true,
      },
    ]);
    expect(result.replayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("emits verbose summaries for transcript-recorded dynamic tool calls", async () => {
    const onAgentEvent = vi.fn();
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      onAgentEvent,
      onToolResult,
    });

    projector.recordDynamicToolCall({
      callId: "call-browser-1",
      tool: "browser",
      arguments: { action: "open", url: "http://127.0.0.1:3000" },
    });

    const toolEvents = onAgentEvent.mock.calls.filter(([event]) => {
      const record = requireRecord(event, "agent event");
      return record.stream === "tool";
    });
    expect(toolEvents).toHaveLength(0);
    expect(onToolResult).toHaveBeenCalledTimes(1);
    const payload = mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string };
    expect(payload.text).toContain("Browser");
  });

  it("does not replay transcript summaries when only tool output is enabled", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onToolResult,
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => true,
    });

    projector.recordDynamicToolCall({
      callId: "call-browser-1",
      tool: "browser",
      arguments: { action: "open", url: "http://127.0.0.1:3000" },
    });
    projector.recordDynamicToolResult({
      callId: "call-browser-1",
      tool: "browser",
      success: true,
      contentItems: [{ type: "inputText", text: "opened" }],
    });

    expect(onToolResult).toHaveBeenCalledTimes(1);
    const payload = mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string };
    expect(payload.text).toContain("opened");
    expect(payload.text).toContain("```txt\nopened\n```");
  });

  it("keeps side-effect evidence for dynamic tools that error after execution", async () => {
    const projector = await createProjector();

    projector.recordDynamicToolCall({
      callId: "call-process-kill",
      tool: "process",
      arguments: { action: "kill", sessionId: "session-1" },
    });
    projector.recordDynamicToolResult({
      callId: "call-process-kill",
      tool: "process",
      success: false,
      terminalType: "error",
      sideEffectEvidence: true,
      contentItems: [{ type: "inputText", text: "process exited" }],
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

  it("does not keep side-effect evidence for pre-execution dynamic tool errors", async () => {
    const observeToolTerminal = createCodexTestToolTerminalObserver();
    const projector = await createProjector({ ...(await createParams()), observeToolTerminal });

    projector.recordDynamicToolCall({
      callId: "call-unknown-message",
      tool: "message",
      arguments: { action: "send", text: "hello" },
    });
    projector.recordDynamicToolResult({
      callId: "call-unknown-message",
      tool: "message",
      terminalResolution: observeToolTerminal({
        toolCallId: "call-unknown-message",
        toolName: "message",
        arguments: { action: "send", text: "hello" },
        executionStarted: false,
        outcome: "failure",
        failure: { error: "Unknown OpenClaw tool: message" },
      }),
      success: false,
      terminalType: "error",
      contentItems: [{ type: "inputText", text: "Unknown OpenClaw tool: message" }],
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: false, replaySafe: true });
    expect(result.lastToolError).toMatchObject({
      toolName: "message",
      mutatingAction: false,
    });
  });

  it("does not mark a blocked pre-execution dynamic mutation as attempted", async () => {
    const observeToolTerminal = createCodexTestToolTerminalObserver();
    const projector = await createProjector({ ...(await createParams()), observeToolTerminal });
    const messageArgs = { action: "send", to: "channel:123", message: "hello" };

    projector.recordDynamicToolResult({
      callId: "call-message-preflight-blocked",
      tool: "message",
      terminalResolution: observeToolTerminal({
        toolCallId: "call-message-preflight-blocked",
        toolName: "message",
        arguments: messageArgs,
        executionStarted: false,
        outcome: "failure",
        failure: { error: "blocked before execution" },
      }),
      success: false,
      terminalType: "blocked",
      contentItems: [{ type: "inputText", text: "blocked before execution" }],
    });

    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toMatchObject({
      toolName: "message",
      mutatingAction: false,
    });
  });

  it("keeps a blocked dynamic mutation until the same action succeeds", async () => {
    const observeToolTerminal = createCodexTestToolTerminalObserver();
    const projector = await createProjector({ ...(await createParams()), observeToolTerminal });
    const messageArgs = {
      action: "send",
      provider: "discord",
      to: "channel:123",
      message: "deployment ready",
    };

    projector.recordDynamicToolResult({
      callId: "call-message-blocked",
      tool: "message",
      terminalResolution: observeToolTerminal({
        toolCallId: "call-message-blocked",
        toolName: "message",
        arguments: messageArgs,
        meta: "send to channel:123",
        executionStarted: true,
        outcome: "failure",
        failure: { error: "cross-context messaging denied" },
      }),
      success: false,
      terminalType: "blocked",
      contentItems: [{ type: "inputText", text: "cross-context messaging denied" }],
    });

    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toMatchObject({
      toolName: "message",
      error: "cross-context messaging denied",
      mutatingAction: true,
      actionFingerprint: expect.stringContaining("tool=message|action=send|to=channel:123"),
    });

    projector.recordDynamicToolResult({
      callId: "call-read-failed",
      tool: "read",
      terminalResolution: observeToolTerminal({
        toolCallId: "call-read-failed",
        toolName: "read",
        arguments: { path: "/tmp/missing" },
        executionStarted: true,
        outcome: "failure",
        failure: { error: "file not found" },
      }),
      success: false,
      terminalType: "error",
      contentItems: [{ type: "inputText", text: "file not found" }],
    });

    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toMatchObject({
      toolName: "message",
      mutatingAction: true,
    });

    projector.recordDynamicToolResult({
      callId: "call-heartbeat-response",
      tool: "heartbeat_respond",
      terminalResolution: observeToolTerminal({
        toolCallId: "call-heartbeat-response",
        toolName: "heartbeat_respond",
        arguments: { notify: false, summary: "nothing else changed" },
        executionStarted: true,
        outcome: "success",
      }),
      success: true,
      terminalType: "completed",
      contentItems: [{ type: "inputText", text: "HEARTBEAT_OK" }],
    });

    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toMatchObject({
      toolName: "message",
      mutatingAction: true,
    });

    projector.recordDynamicToolResult({
      callId: "call-message-retry",
      tool: "message",
      terminalResolution: observeToolTerminal({
        toolCallId: "call-message-retry",
        toolName: "message",
        arguments: messageArgs,
        meta: "send to channel:123",
        executionStarted: true,
        outcome: "success",
      }),
      success: true,
      terminalType: "completed",
      contentItems: [{ type: "inputText", text: "sent" }],
    });

    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toBeUndefined();
  });

  it.each([
    {
      command: "/bin/zsh -lc 'rg -n TODO src'",
      commandActions: [{ type: "search", command: "rg -n TODO src", query: "TODO", path: "src" }],
    },
    {
      command: "/bin/zsh -lc 'cat package.json'",
      commandActions: [
        { type: "read", command: "cat package.json", name: "cat", path: "/workspace/package.json" },
      ],
    },
    {
      command: "/bin/zsh -lc 'touch changed.txt'",
      commandActions: [{ type: "unknown", command: "touch changed.txt" }],
    },
  ])(
    "treats native command actions as replay-unsafe: $command",
    async ({ command, commandActions }) => {
      const projector = await createProjector();

      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: {
            type: "commandExecution",
            id: "command-native",
            command,
            cwd: "/workspace",
            processId: null,
            source: "agent",
            status: "completed",
            commandActions,
            aggregatedOutput: "",
            exitCode: 0,
            durationMs: 1,
          },
        }),
      );

      expect(projector.buildResult(buildEmptyToolTelemetry()).replayMetadata).toEqual({
        hadPotentialSideEffects: true,
        replaySafe: false,
      });
    },
  );
});
