import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { wrapToolWithBeforeToolCallHook } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  installCodexToolResultMiddleware,
  installOpenClawOwnedToolHooks,
  mediaToolResult,
  resetOpenClawOwnedToolHooks,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";

function createContractTool(overrides: Partial<AnyAgentTool>): AnyAgentTool {
  return {
    name: "exec",
    description: "Run a command.",
    parameters: { type: "object", properties: {} },
    execute: vi.fn(),
    ...overrides,
  } as unknown as AnyAgentTool;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function requireMockCall(mock: unknown, index: number, label: string): unknown[] {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
  expect(Array.isArray(calls)).toBe(true);
  if (!Array.isArray(calls)) {
    throw new Error(`${label} did not expose mock calls`);
  }
  const call = calls[index];
  expect(call).toBeDefined();
  if (!call) {
    throw new Error(`missing ${label} call ${index + 1}`);
  }
  return call;
}

function expectHookContext(value: unknown, fields: Record<string, unknown>) {
  expectRecordFields(requireRecord(value, "hook context"), fields);
}

function expectExecuteCall(execute: unknown, callId: string, params: Record<string, unknown>) {
  const call = requireMockCall(execute, 0, "execute");
  expect(call[0]).toBe(callId);
  expect(call[1]).toEqual(params);
  expect(call[2]).toBeInstanceOf(AbortSignal);
  expect(call[3]).toBeUndefined();
}

function expectBeforeToolCall(
  hooks: { beforeToolCall: unknown },
  eventFields: Record<string, unknown>,
  contextFields: Record<string, unknown>,
) {
  const call = requireMockCall(hooks.beforeToolCall, 0, "before_tool_call");
  expectRecordFields(requireRecord(call[0], "before_tool_call event"), eventFields);
  expectHookContext(call[1], contextFields);
}

function expectAfterToolCall(
  hooks: { afterToolCall: unknown },
  eventFields: Record<string, unknown>,
  contextFields: Record<string, unknown>,
) {
  const call = requireMockCall(hooks.afterToolCall, 0, "after_tool_call");
  expectRecordFields(requireRecord(call[0], "after_tool_call event"), eventFields);
  expectHookContext(call[1], contextFields);
}

describe("OpenClaw-owned tool runtime contract — Codex app-server adapter", () => {
  afterEach(() => {
    resetOpenClawOwnedToolHooks();
  });

  it("wraps unwrapped dynamic tools with before/after tool hooks", async () => {
    const adjustedParams = { mode: "safe" };
    const mergedParams = { command: "pwd", mode: "safe" };
    const hooks = installOpenClawOwnedToolHooks({ adjustedParams });
    const execute = vi.fn(async () => textToolResult("done", { ok: true }));
    const bridge = createCodexDynamicToolBridge({
      tools: [createContractTool({ name: "exec", execute })],
      signal: new AbortController().signal,
      hookContext: {
        agentId: "agent-1",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
        runId: "run-contract",
      },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-contract",
      namespace: null,
      tool: "exec",
      arguments: { command: "pwd" },
    });

    expect(result).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "done" }],
    });
    expectBeforeToolCall(
      hooks,
      {
        toolName: "exec",
        toolCallId: "call-contract",
        runId: "run-contract",
        params: { command: "pwd" },
      },
      {
        agentId: "agent-1",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
        runId: "run-contract",
        toolCallId: "call-contract",
      },
    );
    expectExecuteCall(execute, "call-contract", mergedParams);
    await vi.waitFor(() => {
      const call = requireMockCall(hooks.afterToolCall, 0, "after_tool_call");
      const event = requireRecord(call[0], "after_tool_call event");
      expectRecordFields(event, {
        toolName: "exec",
        toolCallId: "call-contract",
        params: mergedParams,
      });
      expectRecordFields(requireRecord(event.result, "after_tool_call result"), {
        content: [{ type: "text", text: "done" }],
        details: { ok: true },
      });
      expectHookContext(call[1], {
        agentId: "agent-1",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
        runId: "run-contract",
        toolCallId: "call-contract",
      });
    });
  });

  it("runs tool_result middleware before after_tool_call observes the result", async () => {
    const adjustedParams = { mode: "safe" };
    const mergedParams = { command: "status", mode: "safe" };
    const hooks = installOpenClawOwnedToolHooks({ adjustedParams });
    const middleware = installCodexToolResultMiddleware((event) => {
      const eventRecord = requireRecord(event, "tool_result middleware event");
      expectRecordFields(eventRecord, {
        toolName: "exec",
        toolCallId: "call-middleware",
        args: { command: "status" },
      });
      expectRecordFields(requireRecord(eventRecord.result, "tool_result middleware result"), {
        content: [{ type: "text", text: "raw output" }],
        details: { stage: "execute" },
      });
      return textToolResult("compacted output", { stage: "middleware" });
    });
    const execute = vi.fn(async () => textToolResult("raw output", { stage: "execute" }));
    const bridge = createCodexDynamicToolBridge({
      tools: [createContractTool({ name: "exec", execute })],
      signal: new AbortController().signal,
      hookContext: {
        agentId: "agent-1",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
        runId: "run-middleware",
      },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-middleware",
      namespace: null,
      tool: "exec",
      arguments: { command: "status" },
    });

    expect(result).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "compacted output" }],
    });
    expectExecuteCall(execute, "call-middleware", mergedParams);
    expect(middleware.middleware).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      const call = requireMockCall(hooks.afterToolCall, 0, "after_tool_call");
      const event = requireRecord(call[0], "after_tool_call event");
      expectRecordFields(event, {
        toolName: "exec",
        toolCallId: "call-middleware",
        params: mergedParams,
      });
      expectRecordFields(requireRecord(event.result, "after_tool_call result"), {
        content: [{ type: "text", text: "compacted output" }],
        details: { stage: "middleware" },
      });
      expectHookContext(call[1], {
        runId: "run-middleware",
        toolCallId: "call-middleware",
      });
    });
  });

  it("fails closed when before_tool_call blocks a dynamic tool", async () => {
    const hooks = installOpenClawOwnedToolHooks({ blockReason: "blocked by policy" });
    const execute = vi.fn(async () => textToolResult("should not run"));
    const bridge = createCodexDynamicToolBridge({
      tools: [createContractTool({ name: "message", execute })],
      signal: new AbortController().signal,
      hookContext: { runId: "run-blocked" },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-blocked",
      namespace: null,
      tool: "message",
      arguments: {
        action: "send",
        text: "blocked",
        provider: "telegram",
        to: "chat-1",
      },
    });

    expect(result).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "blocked by policy" }],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(false);
    await vi.waitFor(() => {
      const call = requireMockCall(hooks.afterToolCall, 0, "after_tool_call");
      const event = requireRecord(call[0], "after_tool_call event");
      expectRecordFields(event, {
        toolName: "message",
        toolCallId: "call-blocked",
        params: {
          action: "send",
          text: "blocked",
          provider: "telegram",
          to: "chat-1",
        },
      });
      expectRecordFields(requireRecord(event.result, "after_tool_call result"), {
        content: [{ type: "text", text: "blocked by policy" }],
        details: {
          status: "blocked",
          deniedReason: "plugin-before-tool-call",
          reason: "blocked by policy",
        },
      });
      expectHookContext(call[1], {
        runId: "run-blocked",
        toolCallId: "call-blocked",
      });
    });
  });

  it("reports dynamic tool execution errors through after_tool_call", async () => {
    const adjustedParams = { timeoutSec: 1 };
    const mergedParams = { command: "false", timeoutSec: 1 };
    const hooks = installOpenClawOwnedToolHooks({ adjustedParams });
    const execute = vi.fn(async () => {
      throw new Error("tool failed");
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [createContractTool({ name: "exec", execute })],
      signal: new AbortController().signal,
      hookContext: { runId: "run-error" },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-error",
      namespace: null,
      tool: "exec",
      arguments: { command: "false" },
    });

    expect(result).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "tool failed" }],
    });
    expectExecuteCall(execute, "call-error", mergedParams);
    await vi.waitFor(() => {
      expectAfterToolCall(
        hooks,
        {
          toolName: "exec",
          toolCallId: "call-error",
          params: mergedParams,
          error: "tool failed",
        },
        {
          runId: "run-error",
          toolCallId: "call-error",
        },
      );
    });
  });

  it("records successful Codex messaging text, media, and target telemetry", async () => {
    const hooks = installOpenClawOwnedToolHooks();
    const execute = vi.fn(async () => textToolResult("Sent."));
    const bridge = createCodexDynamicToolBridge({
      tools: [createContractTool({ name: "message", execute })],
      signal: new AbortController().signal,
      hookContext: { runId: "run-message" },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-message",
      namespace: null,
      tool: "message",
      arguments: {
        action: "send",
        text: "hello from Codex",
        mediaUrl: "/tmp/codex-reply.png",
        provider: "telegram",
        to: "chat-1",
        threadId: "thread-ts-1",
      },
    });

    expect(result).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "Sent." }],
    });
    expectRecordFields(requireRecord(bridge.telemetry, "bridge telemetry"), {
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["hello from Codex"],
      messagingToolSentMediaUrls: ["/tmp/codex-reply.png"],
    });
    expect(bridge.telemetry.messagingToolSentTargets).toEqual([
      {
        tool: "message",
        provider: "telegram",
        to: "chat-1",
        threadId: "thread-ts-1",
        text: "hello from Codex",
        mediaUrls: ["/tmp/codex-reply.png"],
      },
    ]);
    await vi.waitFor(() => {
      const call = requireMockCall(hooks.afterToolCall, 0, "after_tool_call");
      const event = requireRecord(call[0], "after_tool_call event");
      expectRecordFields(event, {
        toolName: "message",
        toolCallId: "call-message",
      });
      expectRecordFields(requireRecord(event.params, "after_tool_call params"), {
        text: "hello from Codex",
        mediaUrl: "/tmp/codex-reply.png",
      });
      expectHookContext(call[1], {
        runId: "run-message",
        toolCallId: "call-message",
      });
    });
  });

  it("records successful Codex media artifacts from tool results", async () => {
    const hooks = installOpenClawOwnedToolHooks();
    const execute = vi.fn(async () =>
      mediaToolResult("Generated media reply.", "/tmp/reply.opus", true),
    );
    const bridge = createCodexDynamicToolBridge({
      tools: [createContractTool({ name: "tts", execute })],
      signal: new AbortController().signal,
      hookContext: { runId: "run-media" },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-media",
      namespace: null,
      tool: "tts",
      arguments: { text: "hello" },
    });

    expect(result).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "Generated media reply." }],
    });
    expect(bridge.telemetry.toolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(bridge.telemetry.toolAudioAsVoice).toBe(true);
    await vi.waitFor(() => {
      const call = requireMockCall(hooks.afterToolCall, 0, "after_tool_call");
      const event = requireRecord(call[0], "after_tool_call event");
      expectRecordFields(event, {
        toolName: "tts",
        toolCallId: "call-media",
      });
      const resultRecord = requireRecord(event.result, "after_tool_call result");
      const details = requireRecord(resultRecord.details, "after_tool_call result details");
      expectRecordFields(requireRecord(details.media, "media result details"), {
        mediaUrl: "/tmp/reply.opus",
        audioAsVoice: true,
      });
      expectHookContext(call[1], {
        runId: "run-media",
        toolCallId: "call-media",
      });
    });
  });

  it("does not double-wrap dynamic tools that already have before_tool_call", async () => {
    const adjustedParams = { mode: "safe" };
    const mergedParams = { command: "pwd", mode: "safe" };
    const hooks = installOpenClawOwnedToolHooks({ adjustedParams });
    const execute = vi.fn(async () => textToolResult("done"));
    const tool = wrapToolWithBeforeToolCallHook(createContractTool({ name: "exec", execute }), {
      runId: "run-wrapped",
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
      hookContext: { runId: "run-wrapped" },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-wrapped",
      namespace: null,
      tool: "exec",
      arguments: { command: "pwd" },
    });

    expect(result).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "done" }],
    });
    expect(hooks.beforeToolCall).toHaveBeenCalledTimes(1);
    expectExecuteCall(execute, "call-wrapped", mergedParams);
  });
});
