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
    expect(hooks.beforeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "exec",
        toolCallId: "call-contract",
        runId: "run-contract",
        params: { command: "pwd" },
      }),
      expect.objectContaining({
        agentId: "agent-1",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
        runId: "run-contract",
        toolCallId: "call-contract",
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      "call-contract",
      mergedParams,
      expect.any(AbortSignal),
      undefined,
    );
    await vi.waitFor(() => {
      expect(hooks.afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "exec",
          toolCallId: "call-contract",
          params: mergedParams,
          result: expect.objectContaining({
            content: [{ type: "text", text: "done" }],
            details: { ok: true },
          }),
        }),
        expect.objectContaining({
          agentId: "agent-1",
          sessionId: "session-1",
          sessionKey: "agent:agent-1:session-1",
          runId: "run-contract",
          toolCallId: "call-contract",
        }),
      );
    });
  });

  it("runs tool_result middleware before after_tool_call observes the result", async () => {
    const adjustedParams = { mode: "safe" };
    const mergedParams = { command: "status", mode: "safe" };
    const hooks = installOpenClawOwnedToolHooks({ adjustedParams });
    const middleware = installCodexToolResultMiddleware((event) => {
      expect(event).toMatchObject({
        toolName: "exec",
        toolCallId: "call-middleware",
        args: { command: "status" },
        result: {
          content: [{ type: "text", text: "raw output" }],
          details: { stage: "execute" },
        },
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
    expect(execute).toHaveBeenCalledWith(
      "call-middleware",
      mergedParams,
      expect.any(AbortSignal),
      undefined,
    );
    expect(middleware.middleware).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(hooks.afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "exec",
          toolCallId: "call-middleware",
          params: mergedParams,
          result: expect.objectContaining({
            content: [{ type: "text", text: "compacted output" }],
            details: { stage: "middleware" },
          }),
        }),
        expect.objectContaining({
          runId: "run-middleware",
          toolCallId: "call-middleware",
        }),
      );
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
      success: true,
      contentItems: [{ type: "inputText", text: "blocked by policy" }],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(false);
    await vi.waitFor(() => {
      expect(hooks.afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "message",
          toolCallId: "call-blocked",
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
          toolCallId: "call-blocked",
        }),
      );
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
    expect(execute).toHaveBeenCalledWith(
      "call-error",
      mergedParams,
      expect.any(AbortSignal),
      undefined,
    );
    await vi.waitFor(() => {
      expect(hooks.afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "exec",
          toolCallId: "call-error",
          params: mergedParams,
          error: "tool failed",
        }),
        expect.objectContaining({
          runId: "run-error",
          toolCallId: "call-error",
        }),
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
    expect(bridge.telemetry).toMatchObject({
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["hello from Codex"],
      messagingToolSentMediaUrls: ["/tmp/codex-reply.png"],
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "telegram",
          to: "chat-1",
          threadId: "thread-ts-1",
        },
      ],
    });
    await vi.waitFor(() => {
      expect(hooks.afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "message",
          toolCallId: "call-message",
          params: expect.objectContaining({
            text: "hello from Codex",
            mediaUrl: "/tmp/codex-reply.png",
          }),
        }),
        expect.objectContaining({
          runId: "run-message",
          toolCallId: "call-message",
        }),
      );
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
      expect(hooks.afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "tts",
          toolCallId: "call-media",
          result: expect.objectContaining({
            details: {
              media: {
                mediaUrl: "/tmp/reply.opus",
                audioAsVoice: true,
              },
            },
          }),
        }),
        expect.objectContaining({
          runId: "run-media",
          toolCallId: "call-media",
        }),
      );
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
    expect(execute).toHaveBeenCalledWith(
      "call-wrapped",
      mergedParams,
      expect.any(AbortSignal),
      undefined,
    );
  });
});
