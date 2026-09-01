import { withDynamicToolTranscriptDetails } from "./dynamic-tool-response-state.js";
import { recordCodexDynamicToolResult } from "./dynamic-tool-result-projection.js";
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
  it.each([
    ["gateway", { ok: true, result: { path: "gateway.port", config: 19_801 } }],
    ["dashboard", { ok: true, delivered: 0 }],
    ["memory_search", { ok: true, results: [{ id: "memory-1" }] }],
  ])("retains structured %s transcript details", async (tool, details) => {
    const projector = await createProjector();
    const call = {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: `call-${tool}`,
      namespace: null,
      tool,
      arguments: {},
    };
    const protocolResponse = {
      success: true,
      contentItems: [{ type: "inputText" as const, text: `${tool} done` }],
    };

    projector.recordDynamicToolCall({ callId: call.callId, tool, arguments: {} });
    recordCodexDynamicToolResult(
      projector,
      call,
      withDynamicToolTranscriptDetails({ ...protocolResponse }, details),
      protocolResponse,
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResultMessage = requireRecord(result.messagesSnapshot[2], "tool result message");
    expect(toolResultMessage).toMatchObject({ role: "toolResult", toolName: tool, details });
    expect(protocolResponse).not.toHaveProperty("details");
  });

  it("records dynamic OpenClaw tool calls in mirrored transcript snapshots", async () => {
    const projector = await createProjector(undefined, {
      resolveDynamicToolResultContentSource: (toolName) =>
        toolName === "browser" ? "network" : undefined,
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
    await projector.handleNotification(agentMessageDelta("done"));

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.toolMetas).toEqual([{ toolName: "browser", isError: false }]);
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
    expect(toolResultMessage["__openclaw"]).toMatchObject({ resultContentSource: "network" });
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
    expect(
      requireRecord(result.messagesSnapshot[3], "final assistant")["__openclaw"],
    ).toMatchObject({
      turnTainted: true,
    });
  });

  it("retains MCP App preview details in mirrored dynamic tool results", async () => {
    const projector = await createProjector();
    const details = {
      mcpAppPreview: {
        kind: "canvas",
        view: { id: "mcp-app-view-1" },
        presentation: { target: "assistant_message", sandbox: "scripts" },
        mcpApp: { viewId: "mcp-app-view-1" },
      },
    };

    projector.recordDynamicToolCall({
      callId: "call-app-1",
      tool: "sample__show_options",
      arguments: { limit: 4 },
    });
    projector.recordDynamicToolResult({
      callId: "call-app-1",
      tool: "sample__show_options",
      success: true,
      contentItems: [{ type: "inputText", text: "Found four nearby restaurants." }],
      details,
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResultMessage = requireRecord(result.messagesSnapshot[2], "tool result message");
    expect(toolResultMessage.details).toEqual(details);
  });

  it("awaits MCP App preview details for native MCP tool results", async () => {
    const details = {
      mcpAppPreview: {
        kind: "canvas",
        view: { id: "mcp-app-native-1" },
        presentation: { target: "assistant_message", sandbox: "scripts" },
        mcpApp: {
          viewId: "mcp-app-native-1",
          serverName: "sample",
          toolName: "show_options",
          uiResourceUri: "ui://sample/options.html",
          toolCallId: "call-native-app-1",
        },
      },
    };
    const prepareNativeMcpAppResultDetails = vi.fn(async () => details);
    const projector = await createProjector(undefined, { prepareNativeMcpAppResultDetails });

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "mcpToolCall",
          id: "call-native-app-1",
          status: "completed",
          server: "sample",
          tool: "show_options",
          arguments: { limit: 4 },
          appContext: { connectorId: "sample", resourceUri: "ui://sample/options.html" },
          result: {
            content: [{ type: "text", text: "Found four nearby restaurants." }],
            structuredContent: { stores: [{ id: "store-1", name: "Nan's Noodle House" }] },
          },
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResultMessage = requireRecord(result.messagesSnapshot[2], "tool result message");
    expect(prepareNativeMcpAppResultDetails).toHaveBeenCalledWith(
      expect.objectContaining({ id: "call-native-app-1", type: "mcpToolCall" }),
    );
    expect(toolResultMessage.details).toEqual(details);
  });

  it("marks native web-search results and subsequent assistant output as tainted", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "webSearch",
          id: "search-observed",
          status: "completed",
          durationMs: 5,
          query: "hostile result",
        },
      }),
    );
    await projector.handleNotification(agentMessageDelta("summary"));

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResult = requireRecord(result.messagesSnapshot[2], "native web-search result");
    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolName: "web_search",
      __openclaw: { resultContentSource: "network" },
    });
    expect(
      requireRecord(result.messagesSnapshot[3], "final assistant")["__openclaw"],
    ).toMatchObject({
      turnTainted: true,
    });
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
        isError: false,
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

  it("keeps the latest dynamic failure until the same tool succeeds", async () => {
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
      toolName: "read",
      mutatingAction: false,
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
      toolName: "read",
      mutatingAction: false,
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

    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError?.toolName).toBe("read");

    projector.recordDynamicToolResult({
      callId: "call-read-retry",
      tool: "read",
      terminalResolution: observeToolTerminal({
        toolCallId: "call-read-retry",
        toolName: "read",
        arguments: { path: "/tmp/available" },
        executionStarted: true,
        outcome: "success",
      }),
      success: true,
      terminalType: "completed",
      contentItems: [{ type: "inputText", text: "ok" }],
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
