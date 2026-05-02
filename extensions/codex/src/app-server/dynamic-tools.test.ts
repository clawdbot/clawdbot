import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import {
  HEARTBEAT_RESPONSE_TOOL_NAME,
  wrapToolWithBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import {
  createEmptyPluginRegistry,
  createMockPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { JsonValue } from "./protocol.js";

function createTool(overrides: Partial<AnyAgentTool>): AnyAgentTool {
  return {
    name: "tts",
    description: "Convert text to speech.",
    parameters: { type: "object", properties: {} },
    execute: vi.fn(),
    ...overrides,
  } as unknown as AnyAgentTool;
}

function mediaResult(mediaUrl: string, audioAsVoice?: boolean): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: "Generated media reply." }],
    details: {
      media: {
        mediaUrl,
        ...(audioAsVoice === true ? { audioAsVoice: true } : {}),
      },
    },
  };
}

function textToolResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function createBridgeWithToolResult(toolName: string, toolResult: AgentToolResult<unknown>) {
  return createCodexDynamicToolBridge({
    tools: [
      createTool({
        name: toolName,
        execute: vi.fn(async () => toolResult),
      }),
    ],
    signal: new AbortController().signal,
  });
}

function expectInputText(text: string) {
  return {
    success: true,
    contentItems: [{ type: "inputText", text }],
  };
}

async function handleMessageToolCall(
  bridge: ReturnType<typeof createCodexDynamicToolBridge>,
  arguments_: JsonValue,
) {
  return await bridge.handleToolCall({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    namespace: null,
    tool: "message",
    arguments: arguments_,
  });
}

afterEach(() => {
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("createCodexDynamicToolBridge", () => {
  it.each([
    { toolName: "tts", mediaUrl: "/tmp/reply.opus", audioAsVoice: true },
    { toolName: "image_generate", mediaUrl: "/tmp/generated.png" },
    { toolName: "video_generate", mediaUrl: "https://media.example/video.mp4" },
    { toolName: "music_generate", mediaUrl: "https://media.example/music.wav" },
  ])(
    "preserves structured media artifacts from $toolName tool results",
    async ({ toolName, mediaUrl, audioAsVoice }) => {
      const bridge = createBridgeWithToolResult(toolName, mediaResult(mediaUrl, audioAsVoice));

      const result = await bridge.handleToolCall({
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: toolName,
        arguments: { prompt: "hello" },
      });

      expect(result).toEqual(expectInputText("Generated media reply."));
      expect(bridge.telemetry.toolMediaUrls).toEqual([mediaUrl]);
      expect(bridge.telemetry.toolAudioAsVoice).toBe(audioAsVoice === true);
    },
  );

  it("preserves audio-as-voice metadata from tts results", async () => {
    const toolResult = {
      content: [{ type: "text", text: "(spoken) hello" }],
      details: {
        media: {
          mediaUrl: "/tmp/reply.opus",
          audioAsVoice: true,
        },
      },
    } satisfies AgentToolResult<unknown>;
    const tool = createTool({
      execute: vi.fn(async () => toolResult),
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "tts",
      arguments: { text: "hello" },
    });

    expect(result).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "(spoken) hello" }],
    });
    expect(bridge.telemetry.toolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(bridge.telemetry.toolAudioAsVoice).toBe(true);
  });

  it("records messaging tool side effects while returning concise text to app-server", async () => {
    const toolResult = {
      content: [{ type: "text", text: "Sent." }],
      details: { messageId: "message-1" },
    } satisfies AgentToolResult<unknown>;
    const tool = createTool({
      name: "message",
      execute: vi.fn(async () => toolResult),
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
    });

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      text: "hello from Codex",
      mediaUrl: "/tmp/reply.png",
      provider: "telegram",
      to: "chat-1",
      threadId: "thread-ts-1",
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(bridge.telemetry).toMatchObject({
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["hello from Codex"],
      messagingToolSentMediaUrls: ["/tmp/reply.png"],
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "telegram",
          to: "chat-1",
          threadId: "thread-ts-1",
        },
      ],
    });
  });

  it("does not record messaging side effects when the send fails", async () => {
    const tool = createTool({
      name: "message",
      execute: vi.fn(async () => {
        throw new Error("send failed");
      }),
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
    });

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      text: "not delivered",
      provider: "slack",
      to: "C123",
    });

    expect(result).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "send failed" }],
    });
    expect(bridge.telemetry).toMatchObject({
      didSendViaMessagingTool: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
    });
  });

  it("records heartbeat response tool outcomes", async () => {
    const bridge = createBridgeWithToolResult(
      HEARTBEAT_RESPONSE_TOOL_NAME,
      textToolResult("Recorded.", {
        status: "recorded",
        outcome: "needs_attention",
        notify: true,
        summary: "Build is blocked.",
        notificationText: "Build is blocked on missing credentials.",
        priority: "high",
      }),
    );

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: HEARTBEAT_RESPONSE_TOOL_NAME,
      arguments: {},
    });

    expect(result).toEqual(expectInputText("Recorded."));
    expect(bridge.telemetry.heartbeatToolResponse).toEqual({
      outcome: "needs_attention",
      notify: true,
      summary: "Build is blocked.",
      notificationText: "Build is blocked on missing credentials.",
      priority: "high",
    });
  });

  it("applies agent tool result middleware from the active plugin registry", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(
      async (event: { result: AgentToolResult<unknown>; toolName: string }) => ({
        result: {
          ...event.result,
          content: [{ type: "text" as const, text: `${event.toolName} compacted` }],
        },
      }),
    );
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);

    const bridge = createBridgeWithToolResult("exec", {
      content: [{ type: "text", text: "raw output" }],
      details: {},
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "exec",
      arguments: { command: "git status" },
    });

    expect(result).toEqual(expectInputText("exec compacted"));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        turnId: "turn-1",
        toolCallId: "call-1",
        toolName: "exec",
        args: { command: "git status" },
      }),
      expect.objectContaining({ runtime: "codex" }),
    );
  });

  it("passes raw tool failure state into agent tool result middleware", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(async (_event: { isError?: boolean }) => undefined);
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);

    const bridge = createBridgeWithToolResult("exec", {
      content: [{ type: "text", text: "failed output" }],
      details: { status: "failed", exitCode: 1 },
    });

    await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "exec",
      arguments: { command: "false" },
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ isError: true }),
      expect.objectContaining({ runtime: "codex" }),
    );
  });

  it("uses raw tool provenance for media trust after middleware rewrites details", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(async (event: { result: AgentToolResult<unknown> }) => ({
      result: {
        ...event.result,
        content: [{ type: "text" as const, text: "Generated media reply." }],
        details: {
          media: {
            mediaUrl: "/tmp/unsafe.png",
          },
        },
      },
    }));
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);

    const bridge = createBridgeWithToolResult("browser", {
      content: [{ type: "text", text: "raw output" }],
      details: {
        mcpServer: "external",
        mcpTool: "browser",
      },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "browser",
      arguments: {},
    });

    expect(result).toEqual(expectInputText("Generated media reply."));
    expect(bridge.telemetry.toolMediaUrls).toEqual([]);
  });

  it("still applies legacy codex app-server extension factories after middleware", async () => {
    const registry = createEmptyPluginRegistry();
    const factory = async (codex: {
      on: (
        event: "tool_result",
        handler: (event: any) => Promise<{ result: AgentToolResult<unknown> }>,
      ) => void;
    }) => {
      codex.on("tool_result", async (event) => ({
        result: {
          ...event.result,
          content: [{ type: "text", text: "legacy compacted" }],
        },
      }));
    };
    registry.codexAppServerExtensionFactories.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawFactory: factory,
      factory,
      source: "test",
    });
    setActivePluginRegistry(registry);

    const bridge = createBridgeWithToolResult("exec", {
      content: [{ type: "text", text: "raw output" }],
      details: {},
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "exec",
      arguments: { command: "git status" },
    });

    expect(result).toEqual(expectInputText("legacy compacted"));
  });

  it("fires after_tool_call for successful codex tool executions", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );

    const bridge = createBridgeWithToolResult("exec", {
      content: [{ type: "text", text: "done" }],
      details: {},
    });

    await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "exec",
      arguments: { command: "pwd" },
    });

    await vi.waitFor(() => {
      expect(afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "exec",
          toolCallId: "call-1",
          params: { command: "pwd" },
          result: expect.objectContaining({
            content: [{ type: "text", text: "done" }],
            details: {},
          }),
        }),
        expect.objectContaining({
          toolName: "exec",
          toolCallId: "call-1",
        }),
      );
    });
  });

  it("runs before_tool_call for unwrapped dynamic tools before execution", async () => {
    const beforeToolCall = vi.fn(async () => ({ params: { mode: "safe" } }));
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: beforeToolCall },
        { hookName: "after_tool_call", handler: afterToolCall },
      ]),
    );

    const execute = vi.fn(async () => textToolResult("done", { ok: true }));
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "exec", execute })],
      signal: new AbortController().signal,
      hookContext: {
        agentId: "agent-1",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
        runId: "run-1",
      },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "exec",
      arguments: { command: "pwd" },
    });

    expect(result).toEqual(expectInputText("done"));
    expect(beforeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "exec",
        toolCallId: "call-1",
        runId: "run-1",
        params: { command: "pwd" },
      }),
      expect.objectContaining({
        agentId: "agent-1",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
        runId: "run-1",
        toolCallId: "call-1",
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { command: "pwd", mode: "safe" },
      expect.any(AbortSignal),
      undefined,
    );
    await vi.waitFor(() => {
      expect(afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "exec",
          toolCallId: "call-1",
          params: { command: "pwd", mode: "safe" },
          result: expect.objectContaining({
            content: [{ type: "text", text: "done" }],
            details: { ok: true },
          }),
        }),
        expect.objectContaining({
          agentId: "agent-1",
          sessionId: "session-1",
          sessionKey: "agent:agent-1:session-1",
          runId: "run-1",
          toolCallId: "call-1",
        }),
      );
    });
  });

  it("does not execute dynamic tools blocked by before_tool_call", async () => {
    const beforeToolCall = vi.fn(async () => ({
      block: true,
      blockReason: "blocked by policy",
    }));
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: beforeToolCall },
        { hookName: "after_tool_call", handler: afterToolCall },
      ]),
    );
    const execute = vi.fn(async () => textToolResult("should not run"));
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "message", execute })],
      signal: new AbortController().signal,
      hookContext: { runId: "run-blocked" },
    });

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      text: "blocked",
      provider: "telegram",
      to: "chat-1",
    });

    expect(result).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "blocked by policy" }],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(false);
    await vi.waitFor(() => {
      expect(afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "message",
          toolCallId: "call-1",
          params: {
            action: "send",
            text: "blocked",
            provider: "telegram",
            to: "chat-1",
          },
          result: expect.objectContaining({
            content: [{ type: "text", text: "blocked by policy" }],
            details: {
              status: "blocked",
              deniedReason: "plugin-before-tool-call",
              reason: "blocked by policy",
            },
          }),
        }),
        expect.objectContaining({
          runId: "run-blocked",
          toolCallId: "call-1",
        }),
      );
    });
  });

  it("applies dynamic tool result middleware before after_tool_call observes the result", async () => {
    const events: string[] = [];
    const beforeToolCall = vi.fn(async () => {
      events.push("before_tool_call");
      return { params: { mode: "safe" } };
    });
    const afterToolCall = vi.fn(async (event) => {
      events.push("after_tool_call");
      expect(event).toMatchObject({
        params: { command: "status", mode: "safe" },
        result: {
          content: [{ type: "text", text: "compacted output" }],
          details: { stage: "middleware" },
        },
      });
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: beforeToolCall },
        { hookName: "after_tool_call", handler: afterToolCall },
      ]),
    );
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(
      async (event: { args: Record<string, unknown>; result: AgentToolResult<unknown> }) => {
        events.push("middleware");
        expect(event.args).toEqual({ command: "status" });
        return {
          result: {
            ...event.result,
            content: [{ type: "text" as const, text: "compacted output" }],
            details: { stage: "middleware" },
          },
        };
      },
    );
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    const execute = vi.fn(async () => {
      events.push("execute");
      return textToolResult("raw output", { stage: "execute" });
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "exec", execute })],
      signal: new AbortController().signal,
      hookContext: { runId: "run-middleware" },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "exec",
      arguments: { command: "status" },
    });

    expect(result).toEqual(expectInputText("compacted output"));
    await vi.waitFor(() => {
      expect(events).toEqual(["before_tool_call", "execute", "middleware", "after_tool_call"]);
    });
  });

  it("reports dynamic tool execution errors through after_tool_call without stranding the turn", async () => {
    const beforeToolCall = vi.fn(async () => ({ params: { timeoutSec: 1 } }));
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: beforeToolCall },
        { hookName: "after_tool_call", handler: afterToolCall },
      ]),
    );
    const execute = vi.fn(async () => {
      throw new Error("tool failed");
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "exec", execute })],
      signal: new AbortController().signal,
      hookContext: { runId: "run-error" },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-err",
      namespace: null,
      tool: "exec",
      arguments: { command: "false" },
    });

    expect(result).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "tool failed" }],
    });
    expect(execute).toHaveBeenCalledWith(
      "call-err",
      { command: "false", timeoutSec: 1 },
      expect.any(AbortSignal),
      undefined,
    );
    await vi.waitFor(() => {
      expect(afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "exec",
          toolCallId: "call-err",
          params: { command: "false", timeoutSec: 1 },
          error: "tool failed",
        }),
        expect.objectContaining({
          runId: "run-error",
          toolCallId: "call-err",
        }),
      );
    });
  });

  it("passes per-call abort signals into dynamic tool execution", async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveTool: ((result: AgentToolResult<unknown>) => void) | undefined;
    const execute = vi.fn(
      async (_callId: string, _args: Record<string, unknown>, signal: AbortSignal) =>
        await new Promise<AgentToolResult<unknown>>((resolve) => {
          capturedSignal = signal;
          resolveTool = resolve;
        }),
    );
    const runController = new AbortController();
    const callController = new AbortController();
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "exec", execute })],
      signal: runController.signal,
    });

    const result = bridge.handleToolCall(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-signal",
        namespace: null,
        tool: "exec",
        arguments: { command: "sleep" },
      },
      { signal: callController.signal },
    );
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());

    callController.abort(new Error("deadline"));
    expect(capturedSignal?.aborted).toBe(true);
    resolveTool?.(textToolResult("done"));

    await expect(result).resolves.toEqual(expectInputText("done"));
  });

  it("does not double-wrap dynamic tools that already have before_tool_call", async () => {
    const beforeToolCall = vi.fn(async () => ({ params: { mode: "safe" } }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const execute = vi.fn(async () => textToolResult("done"));
    const tool = wrapToolWithBeforeToolCallHook(createTool({ name: "exec", execute }), {
      runId: "run-wrapped",
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
      hookContext: { runId: "run-wrapped" },
    });

    await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-wrapped",
      namespace: null,
      tool: "exec",
      arguments: { command: "pwd" },
    });

    expect(beforeToolCall).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      "call-wrapped",
      { command: "pwd", mode: "safe" },
      expect.any(AbortSignal),
      undefined,
    );
  });
});
