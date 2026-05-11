import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  installOpenClawOwnedToolHooks,
  resetOpenClawOwnedToolHooks,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagingToolSend } from "./pi-embedded-messaging.types.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
} from "./pi-embedded-subscribe.handlers.tools.js";
import type {
  ToolCallSummary,
  ToolHandlerContext,
} from "./pi-embedded-subscribe.handlers.types.js";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";
import { createBaseToolHandlerState } from "./pi-tool-handler-state.test-helpers.js";
import { wrapToolWithBeforeToolCallHook } from "./pi-tools.before-tool-call.js";

function createContractTool(name: string, execute: AgentTool["execute"]): AgentTool {
  return {
    name,
    label: name,
    description: `contract tool: ${name}`,
    parameters: { type: "object", properties: {} },
    execute,
  } as AgentTool;
}

type ToolExecutionStartEvent = Parameters<typeof handleToolExecutionStart>[1];
type ToolExecutionEndEvent = Parameters<typeof handleToolExecutionEnd>[1];

function createToolHandlerCtx(): ToolHandlerContext {
  return {
    params: {
      runId: "run-contract",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
    },
    state: {
      ...createBaseToolHandlerState(),
      toolMetaById: new Map<string, ToolCallSummary>(),
      pendingMessagingTargets: new Map<string, MessagingToolSend>(),
      messagingToolSentTargets: [] as MessagingToolSend[],
      successfulCronAdds: 0,
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    flushBlockReplyBuffer: vi.fn(),
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
  };
}

function toolExecutionStartEvent(params: {
  toolName: string;
  toolCallId: string;
  args: unknown;
}): ToolExecutionStartEvent {
  return {
    type: "tool_execution_start",
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    args: params.args,
  } as ToolExecutionStartEvent;
}

function toolExecutionEndEvent(params: {
  toolName: string;
  toolCallId: string;
  isError: boolean;
  result: unknown;
}): ToolExecutionEndEvent {
  return {
    type: "tool_execution_end",
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    isError: params.isError,
    result: params.result,
  } as ToolExecutionEndEvent;
}

function createToolExtensionContext(): ExtensionContext {
  return {} as ExtensionContext;
}

async function waitForAfterToolCall(hooks: {
  afterToolCall: { mock: { calls: unknown[][] } };
}): Promise<[Record<string, unknown>, Record<string, unknown>]> {
  await vi.waitFor(() => {
    expect(hooks.afterToolCall.mock.calls.length).toBe(1);
  });
  const call = hooks.afterToolCall.mock.calls[0];
  expect(call).toBeDefined();
  return call as [Record<string, unknown>, Record<string, unknown>];
}

describe("OpenClaw-owned tool runtime contract — Pi adapter", () => {
  afterEach(() => {
    resetOpenClawOwnedToolHooks();
  });

  it("preserves partially adjusted before_tool_call params through execution and after_tool_call", async () => {
    const adjustedParams = { mode: "safe" };
    const mergedParams = { command: "pwd", mode: "safe" };
    const hooks = installOpenClawOwnedToolHooks({ adjustedParams });
    const execute = vi.fn(async () => textToolResult("done", { ok: true }));
    const tool = wrapToolWithBeforeToolCallHook(createContractTool("exec", execute), {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-contract",
    });
    const definition = toToolDefinitions([tool])[0];
    if (!definition) {
      throw new Error("missing Pi tool definition");
    }
    const ctx = createToolHandlerCtx();
    const toolCallId = "call-contract";
    const originalParams = { command: "pwd" };

    await handleToolExecutionStart(
      ctx,
      toolExecutionStartEvent({
        toolName: "exec",
        toolCallId,
        args: originalParams,
      }),
    );
    const result = await definition.execute(
      toolCallId,
      originalParams,
      undefined,
      undefined,
      createToolExtensionContext(),
    );
    await handleToolExecutionEnd(
      ctx,
      toolExecutionEndEvent({
        toolName: "exec",
        toolCallId,
        isError: false,
        result,
      }),
    );

    expect(hooks.beforeToolCall).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(toolCallId, mergedParams, undefined, undefined);
    const [afterPayload, afterContext] = await waitForAfterToolCall(hooks);
    expect(afterPayload.toolName).toBe("exec");
    expect(afterPayload.toolCallId).toBe(toolCallId);
    expect(afterPayload.params).toEqual(mergedParams);
    expect(afterPayload.result).toEqual({
      content: [{ type: "text", text: "done" }],
      details: { ok: true },
    });
    expect(afterContext.agentId).toBe("agent-1");
    expect(afterContext.sessionId).toBe("session-1");
    expect(afterContext.sessionKey).toBe("agent:agent-1:session-1");
    expect(afterContext.runId).toBe("run-contract");
    expect(afterContext.toolCallId).toBe(toolCallId);
  });

  it("reports Pi dynamic tool execution errors through after_tool_call", async () => {
    const adjustedParams = { timeoutSec: 1 };
    const mergedParams = { command: "false", timeoutSec: 1 };
    const hooks = installOpenClawOwnedToolHooks({ adjustedParams });
    const execute = vi.fn(async () => {
      throw new Error("tool failed");
    });
    const tool = wrapToolWithBeforeToolCallHook(createContractTool("exec", execute), {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-error",
    });
    const definition = toToolDefinitions([tool])[0];
    if (!definition) {
      throw new Error("missing Pi tool definition");
    }
    const ctx = createToolHandlerCtx();
    ctx.params.runId = "run-error";
    const toolCallId = "call-error";
    const originalParams = { command: "false" };

    await handleToolExecutionStart(
      ctx,
      toolExecutionStartEvent({
        toolName: "exec",
        toolCallId,
        args: originalParams,
      }),
    );
    const result = await definition.execute(
      toolCallId,
      originalParams,
      undefined,
      undefined,
      createToolExtensionContext(),
    );
    const resultDetails = (result as { details?: Record<string, unknown> }).details;
    expect(resultDetails?.status).toBe("error");
    expect(resultDetails?.error).toBe("tool failed");
    await handleToolExecutionEnd(
      ctx,
      toolExecutionEndEvent({
        toolName: "exec",
        toolCallId,
        isError: true,
        result,
      }),
    );

    expect(hooks.beforeToolCall).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(toolCallId, mergedParams, undefined, undefined);
    const [afterPayload, afterContext] = await waitForAfterToolCall(hooks);
    expect(afterPayload.toolName).toBe("exec");
    expect(afterPayload.toolCallId).toBe(toolCallId);
    expect(afterPayload.params).toEqual(mergedParams);
    expect(afterPayload.error).toBe("tool failed");
    expect(afterContext.runId).toBe("run-error");
    expect(afterContext.toolCallId).toBe(toolCallId);
  });

  it("commits successful Pi messaging text, media, and target telemetry", async () => {
    const hooks = installOpenClawOwnedToolHooks();
    const execute = vi.fn(async () => textToolResult("sent"));
    const tool = wrapToolWithBeforeToolCallHook(createContractTool("message", execute), {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-message",
    });
    const definition = toToolDefinitions([tool])[0];
    if (!definition) {
      throw new Error("missing Pi tool definition");
    }
    const ctx = createToolHandlerCtx();
    ctx.params.runId = "run-message";
    const toolCallId = "call-message";
    const originalParams = {
      action: "send",
      content: "hello from Pi",
      mediaUrl: "/tmp/pi-reply.png",
      provider: "telegram",
      to: "chat-1",
    };

    await handleToolExecutionStart(
      ctx,
      toolExecutionStartEvent({
        toolName: "message",
        toolCallId,
        args: originalParams,
      }),
    );
    const result = await definition.execute(
      toolCallId,
      originalParams,
      undefined,
      undefined,
      createToolExtensionContext(),
    );
    await handleToolExecutionEnd(
      ctx,
      toolExecutionEndEvent({
        toolName: "message",
        toolCallId,
        isError: false,
        result,
      }),
    );

    expect(ctx.state.messagingToolSentTexts).toEqual(["hello from Pi"]);
    expect(ctx.state.messagingToolSentMediaUrls).toEqual(["/tmp/pi-reply.png"]);
    expect(
      ctx.state.messagingToolSentTargets.map((target) => ({
        tool: "message",
        provider: target.provider,
        to: target.to,
        text: target.text,
        mediaUrls: target.mediaUrls,
      })),
    ).toEqual([
      {
        tool: "message",
        provider: "telegram",
        to: "chat-1",
        text: "hello from Pi",
        mediaUrls: ["/tmp/pi-reply.png"],
      },
    ]);
    const [afterPayload, afterContext] = await waitForAfterToolCall(hooks);
    expect(afterPayload.toolName).toBe("message");
    expect(afterPayload.toolCallId).toBe(toolCallId);
    expect(afterPayload.params).toEqual(originalParams);
    expect((afterPayload.result as { content?: unknown }).content).toEqual([
      { type: "text", text: "sent" },
    ]);
    expect(afterContext.runId).toBe("run-message");
    expect(afterContext.toolCallId).toBe(toolCallId);
  });

  it("fails closed when before_tool_call blocks a Pi dynamic tool", async () => {
    const hooks = installOpenClawOwnedToolHooks({ blockReason: "blocked by policy" });
    const execute = vi.fn(async () => textToolResult("should not run"));
    const tool = wrapToolWithBeforeToolCallHook(createContractTool("message", execute), {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-blocked",
    });
    const definition = toToolDefinitions([tool])[0];
    if (!definition) {
      throw new Error("missing Pi tool definition");
    }
    const ctx = createToolHandlerCtx();
    ctx.params.runId = "run-blocked";
    const toolCallId = "call-blocked";
    const originalParams = {
      action: "send",
      text: "blocked",
      provider: "telegram",
      to: "chat-1",
    };

    await handleToolExecutionStart(
      ctx,
      toolExecutionStartEvent({
        toolName: "message",
        toolCallId,
        args: originalParams,
      }),
    );
    const result = await definition.execute(
      toolCallId,
      originalParams,
      undefined,
      undefined,
      createToolExtensionContext(),
    );
    const resultDetails = (result as { details?: Record<string, unknown> }).details;
    expect(resultDetails?.status).toBe("blocked");
    expect(resultDetails?.deniedReason).toBe("plugin-before-tool-call");
    expect(resultDetails?.reason).toBe("blocked by policy");
    await handleToolExecutionEnd(
      ctx,
      toolExecutionEndEvent({
        toolName: "message",
        toolCallId,
        isError: true,
        result,
      }),
    );

    expect(hooks.beforeToolCall).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    const [afterPayload, afterContext] = await waitForAfterToolCall(hooks);
    expect(afterPayload.toolName).toBe("message");
    expect(afterPayload.toolCallId).toBe(toolCallId);
    expect(afterPayload.params).toEqual(originalParams);
    expect(afterPayload.result).toEqual({
      content: [{ type: "text", text: "blocked by policy" }],
      details: {
        status: "blocked",
        deniedReason: "plugin-before-tool-call",
        reason: "blocked by policy",
      },
    });
    expect(afterPayload.error).toBe("blocked by policy");
    expect(afterContext.agentId).toBe("agent-1");
    expect(afterContext.sessionId).toBe("session-1");
    expect(afterContext.sessionKey).toBe("agent:agent-1:session-1");
    expect(afterContext.runId).toBe("run-blocked");
    expect(afterContext.toolCallId).toBe(toolCallId);
  });
});
