import type { AgentToolResult } from "@earendil-works/pi-agent-core";
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
import {
  CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
  createCodexDynamicToolBridge,
} from "./dynamic-tools.js";
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): Array<unknown> {
  expect(Array.isArray(value), label).toBe(true);
  return value as Array<unknown>;
}

function callArg(
  mock: { mock: { calls: Array<Array<unknown>> } },
  callIndex: number,
  argIndex: number,
  label: string,
) {
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected ${label}`);
  }
  return call[argIndex];
}

function expectDynamicSpec(
  spec: unknown,
  fields: { name: string; namespace?: string; deferLoading?: boolean },
) {
  const record = requireRecord(spec, `${fields.name} spec`);
  expect(record.name).toBe(fields.name);
  if (fields.namespace !== undefined) {
    expect(record.namespace).toBe(fields.namespace);
  }
  if (fields.deferLoading !== undefined) {
    expect(record.deferLoading).toBe(fields.deferLoading);
  }
}

function expectNoNamespace(spec: unknown) {
  const record = requireRecord(spec, "tool spec");
  expect(record).not.toHaveProperty("namespace");
  expect(record).not.toHaveProperty("deferLoading");
}

function expectContextFields(context: unknown, fields: Record<string, unknown>) {
  const record = requireRecord(context, "hook context");
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectToolResult(value: unknown, expected: AgentToolResult<unknown>) {
  const result = requireRecord(value, "tool result");
  expect(result.content).toEqual(expected.content);
  expect(result.details).toEqual(expected.details);
}

function expectExecuteCall(
  execute: { mock: { calls: Array<Array<unknown>> } },
  expected: { callId: string; args: Record<string, unknown> },
) {
  expect(callArg(execute, 0, 0, "execute call id")).toBe(expected.callId);
  expect(callArg(execute, 0, 1, "execute args")).toEqual(expected.args);
  expect(callArg(execute, 0, 2, "execute signal")).toBeInstanceOf(AbortSignal);
  expect(callArg(execute, 0, 3, "execute extra")).toBeUndefined();
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
  it("defers OpenClaw dynamic tools behind Codex tool search by default", () => {
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({ name: "web_search" }),
        createTool({ name: "message" }),
        createTool({ name: HEARTBEAT_RESPONSE_TOOL_NAME }),
        createTool({ name: "sessions_yield" }),
      ],
      signal: new AbortController().signal,
    });

    const webSearch = bridge.specs.find((tool) => tool.name === "web_search");
    const message = bridge.specs.find((tool) => tool.name === "message");
    const heartbeat = bridge.specs.find((tool) => tool.name === HEARTBEAT_RESPONSE_TOOL_NAME);
    const sessionsYield = bridge.specs.find((tool) => tool.name === "sessions_yield");

    expectDynamicSpec(webSearch, {
      name: "web_search",
      namespace: CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
      deferLoading: true,
    });
    expectDynamicSpec(message, {
      name: "message",
      namespace: CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
      deferLoading: true,
    });
    expectDynamicSpec(heartbeat, {
      name: HEARTBEAT_RESPONSE_TOOL_NAME,
      namespace: CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
      deferLoading: true,
    });
    expectNoNamespace(sessionsYield);
  });

  it("keeps configured direct tools in the initial Codex tool context", () => {
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "message" }), createTool({ name: "web_search" })],
      signal: new AbortController().signal,
      directToolNames: ["message"],
    });

    expect(bridge.specs).toHaveLength(2);
    expectDynamicSpec(bridge.specs[0], { name: "message" });
    expectDynamicSpec(bridge.specs[1], {
      name: "web_search",
      namespace: CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
      deferLoading: true,
    });
    expectNoNamespace(bridge.specs[0]);
  });

  it("can expose all dynamic tools directly for compatibility", () => {
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "web_search" }), createTool({ name: "message" })],
      signal: new AbortController().signal,
      loading: "direct",
    });

    expect(bridge.specs).toHaveLength(2);
    expectDynamicSpec(bridge.specs[0], { name: "web_search" });
    expectDynamicSpec(bridge.specs[1], { name: "message" });
    expectNoNamespace(bridge.specs[0]);
    expectNoNamespace(bridge.specs[1]);
  });

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
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(true);
    expect(bridge.telemetry.messagingToolSentTexts).toEqual(["hello from Codex"]);
    expect(bridge.telemetry.messagingToolSentMediaUrls).toEqual(["/tmp/reply.png"]);
    expect(bridge.telemetry.messagingToolSentTargets).toEqual([
      {
        tool: "message",
        provider: "telegram",
        to: "chat-1",
        threadId: "thread-ts-1",
        text: "hello from Codex",
        mediaUrls: ["/tmp/reply.png"],
      },
    ]);
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
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(false);
    expect(bridge.telemetry.messagingToolSentTexts).toEqual([]);
    expect(bridge.telemetry.messagingToolSentMediaUrls).toEqual([]);
    expect(bridge.telemetry.messagingToolSentTargets).toEqual([]);
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
    const event = requireRecord(callArg(handler, 0, 0, "middleware event"), "middleware event");
    expect(event.threadId).toBe("thread-1");
    expect(event.turnId).toBe("turn-1");
    expect(event.toolCallId).toBe("call-1");
    expect(event.toolName).toBe("exec");
    expect(event.args).toEqual({ command: "git status" });
    expectContextFields(callArg(handler, 0, 1, "middleware context"), { runtime: "codex" });
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

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "exec",
      arguments: { command: "false" },
    });

    expect(result).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "failed output" }],
    });
    const event = requireRecord(callArg(handler, 0, 0, "middleware event"), "middleware event");
    expect(event.isError).toBe(true);
    expectContextFields(callArg(handler, 0, 1, "middleware context"), { runtime: "codex" });
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
    expect(bridge.telemetry.toolMediaUrls).toStrictEqual([]);
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

  it("keeps config out of Codex tool-result contexts", async () => {
    const config = { session: { store: "/tmp/openclaw-session-store.json" } };
    const registry = createEmptyPluginRegistry();
    const middlewareContexts: Record<string, unknown>[] = [];
    const legacyContexts: Record<string, unknown>[] = [];
    const middleware = vi.fn(async (_event: unknown, ctx: Record<string, unknown>) => {
      middlewareContexts.push(ctx);
      return undefined;
    });
    const factory = async (codex: {
      on: (
        event: "tool_result",
        handler: (
          event: unknown,
          ctx: Record<string, unknown>,
        ) => Promise<{ result: AgentToolResult<unknown> } | void>,
      ) => void;
    }) => {
      codex.on("tool_result", async (_event, ctx) => {
        legacyContexts.push(ctx);
      });
    };
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawHandler: middleware,
      handler: middleware,
      runtimes: ["codex"],
      source: "test",
    });
    registry.codexAppServerExtensionFactories.push({
      pluginId: "legacy",
      pluginName: "Legacy",
      rawFactory: factory,
      factory,
      source: "test",
    });
    setActivePluginRegistry(registry);

    const execute = vi.fn(async () => textToolResult("done"));
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "exec", execute })],
      signal: new AbortController().signal,
      hookContext: {
        agentId: "agent-1",
        config: config as never,
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
        runId: "run-1",
      },
    });

    await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "exec",
      arguments: { command: "pwd" },
    });

    expectExecuteCall(execute, { callId: "call-1", args: { command: "pwd" } });
    expect(middlewareContexts).toHaveLength(1);
    expectContextFields(middlewareContexts[0], {
      runtime: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-1",
    });
    expect(middlewareContexts[0]).not.toHaveProperty("config");
    expect(legacyContexts).toHaveLength(1);
    expectContextFields(legacyContexts[0], {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-1",
    });
    expect(legacyContexts[0]).not.toHaveProperty("config");
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
      expect(afterToolCall).toHaveBeenCalledTimes(1);
    });
    const event = requireRecord(callArg(afterToolCall, 0, 0, "after_tool_call event"), "event");
    expect(event.toolName).toBe("exec");
    expect(event.toolCallId).toBe("call-1");
    expect(event.params).toEqual({ command: "pwd" });
    expectToolResult(event.result, {
      content: [{ type: "text", text: "done" }],
      details: {},
    });
    expectContextFields(callArg(afterToolCall, 0, 1, "after_tool_call context"), {
      toolName: "exec",
      toolCallId: "call-1",
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
    const beforeEvent = requireRecord(
      callArg(beforeToolCall, 0, 0, "before_tool_call event"),
      "before event",
    );
    expect(beforeEvent.toolName).toBe("exec");
    expect(beforeEvent.toolCallId).toBe("call-1");
    expect(beforeEvent.runId).toBe("run-1");
    expect(beforeEvent.params).toEqual({ command: "pwd" });
    expectContextFields(callArg(beforeToolCall, 0, 1, "before_tool_call context"), {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-1",
      toolCallId: "call-1",
    });
    expectExecuteCall(execute, { callId: "call-1", args: { command: "pwd", mode: "safe" } });
    await vi.waitFor(() => {
      expect(afterToolCall).toHaveBeenCalledTimes(1);
    });
    const afterEvent = requireRecord(
      callArg(afterToolCall, 0, 0, "after_tool_call event"),
      "after event",
    );
    expect(afterEvent.toolName).toBe("exec");
    expect(afterEvent.toolCallId).toBe("call-1");
    expect(afterEvent.params).toEqual({ command: "pwd", mode: "safe" });
    expectToolResult(afterEvent.result, {
      content: [{ type: "text", text: "done" }],
      details: { ok: true },
    });
    expectContextFields(callArg(afterToolCall, 0, 1, "after_tool_call context"), {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-1",
      toolCallId: "call-1",
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
      success: false,
      contentItems: [{ type: "inputText", text: "blocked by policy" }],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(false);
    await vi.waitFor(() => {
      expect(afterToolCall).toHaveBeenCalledTimes(1);
    });
    const event = requireRecord(callArg(afterToolCall, 0, 0, "after_tool_call event"), "event");
    expect(event.toolName).toBe("message");
    expect(event.toolCallId).toBe("call-1");
    expect(event.params).toEqual({
      action: "send",
      text: "blocked",
      provider: "telegram",
      to: "chat-1",
    });
    expectToolResult(event.result, {
      content: [{ type: "text", text: "blocked by policy" }],
      details: {
        status: "blocked",
        deniedReason: "plugin-before-tool-call",
        reason: "blocked by policy",
      },
    });
    expectContextFields(callArg(afterToolCall, 0, 1, "after_tool_call context"), {
      runId: "run-blocked",
      toolCallId: "call-1",
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
      const record = requireRecord(event, "after_tool_call event");
      expect(record.params).toEqual({ command: "status", mode: "safe" });
      expectToolResult(record.result, {
        content: [{ type: "text", text: "compacted output" }],
        details: { stage: "middleware" },
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
    expectExecuteCall(execute, {
      callId: "call-err",
      args: { command: "false", timeoutSec: 1 },
    });
    await vi.waitFor(() => {
      expect(afterToolCall).toHaveBeenCalledTimes(1);
    });
    const event = requireRecord(callArg(afterToolCall, 0, 0, "after_tool_call event"), "event");
    expect(event.toolName).toBe("exec");
    expect(event.toolCallId).toBe("call-err");
    expect(event.params).toEqual({ command: "false", timeoutSec: 1 });
    expect(event.error).toBe("tool failed");
    expectContextFields(callArg(afterToolCall, 0, 1, "after_tool_call context"), {
      runId: "run-error",
      toolCallId: "call-err",
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
    await vi.waitFor(() => {
      if (!capturedSignal) {
        throw new Error("expected dynamic tool call signal");
      }
    });
    if (!capturedSignal) {
      throw new Error("expected dynamic tool call signal");
    }

    callController.abort(new Error("deadline"));
    expect(capturedSignal.aborted).toBe(true);
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
    expectExecuteCall(execute, {
      callId: "call-wrapped",
      args: { command: "pwd", mode: "safe" },
    });
  });
});
