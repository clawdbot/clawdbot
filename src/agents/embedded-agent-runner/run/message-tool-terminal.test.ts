import type { Agent, AfterToolCallContext } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  installMessageToolOnlyTerminalHook,
  shouldTerminateAfterMessageToolOnlySend,
} from "./message-tool-terminal.js";

describe("message-tool-only terminal sends", () => {
  it("marks successful message-tool-only sends as terminal", () => {
    expect(
      shouldTerminateAfterMessageToolOnlySend({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "visible reply" },
        }),
      }),
    ).toBe(true);
    expect(
      shouldTerminateAfterMessageToolOnlySend({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "visible reply" },
          result: createDirectSendResult({ messageId: "discord-message-1" }),
        }),
      }),
    ).toBe(true);
    expect(
      shouldTerminateAfterMessageToolOnlySend({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "visible reply" },
          result: createSuppressedSendResult(),
        }),
        hookResult: { details: { result: { messageId: "discord-message-2" } } },
      }),
    ).toBe(true);
  });

  it("does not terminate automatic delivery, non-send actions, explicit routes, or failed sends", () => {
    expect(
      shouldTerminateAfterMessageToolOnlySend({
        sourceReplyDeliveryMode: "automatic",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "visible reply" },
        }),
      }),
    ).toBe(false);
    expect(
      shouldTerminateAfterMessageToolOnlySend({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "reaction", emoji: "thumbsup" },
        }),
      }),
    ).toBe(false);
    expect(
      shouldTerminateAfterMessageToolOnlySend({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", target: "channel:other", message: "cross-channel" },
        }),
      }),
    ).toBe(false);
    expect(
      shouldTerminateAfterMessageToolOnlySend({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "sessions_send",
          args: { message: "internal delegation" },
        }),
      }),
    ).toBe(false);
    expect(
      shouldTerminateAfterMessageToolOnlySend({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "failed reply" },
          isError: true,
        }),
      }),
    ).toBe(false);
  });

  it("does not terminate dry-run or non-delivered sends", () => {
    expect(
      shouldTerminateAfterMessageToolOnlySend({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "preview reply", dryRun: true },
        }),
      }),
    ).toBe(false);
    expect(
      shouldTerminateAfterMessageToolOnlySend({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "preview reply" },
          result: {
            content: [{ type: "text", text: '{"ok":true}' }],
            details: {
              payload: {
                deliveryStatus: "dry_run",
                dryRun: true,
              },
            },
          },
        }),
      }),
    ).toBe(false);
    expect(
      shouldTerminateAfterMessageToolOnlySend({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "preview reply" },
        }),
        hookResult: { details: { deliveryStatus: "dry_run" } },
      }),
    ).toBe(false);
    expect(
      shouldTerminateAfterMessageToolOnlySend({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "preview reply" },
          result: {
            content: [{ type: "text", text: '{"deliveryStatus":"dry_run","dryRun":true}' }],
            details: { ok: true },
          },
        }),
      }),
    ).toBe(false);
  });

  it("does not terminate suppressed sends without delivery evidence", () => {
    expect(
      shouldTerminateAfterMessageToolOnlySend({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "suppressed reply" },
          result: createSuppressedSendResult(),
        }),
      }),
    ).toBe(false);
  });

  it("preserves existing after-tool-call output while adding the terminal hint", async () => {
    const previousAfterToolCall = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "rewritten" }],
      details: { rewritten: true },
    }));
    const agent = { afterToolCall: previousAfterToolCall } as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
    });

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "visible reply" },
        }),
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: "rewritten" }],
      details: { rewritten: true },
      terminate: true,
    });
    expect(previousAfterToolCall).toHaveBeenCalledTimes(1);
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(1);
  });

  it("leaves existing after-tool-call output alone when the send failed", async () => {
    const previousAfterToolCall = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "failed" }],
      details: { ok: false },
      isError: true,
    }));
    const agent = { afterToolCall: previousAfterToolCall } as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
    });

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "failed reply" },
        }),
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: "failed" }],
      details: { ok: false },
      isError: true,
    });
    expect(previousAfterToolCall).toHaveBeenCalledTimes(1);
    expect(onDeliveredSourceReply).not.toHaveBeenCalled();
  });

  it("does not install a wrapper for non-message-tool-only delivery", async () => {
    const previousAfterToolCall = vi.fn(async () => ({
      details: { untouched: true },
    }));
    const agent = { afterToolCall: previousAfterToolCall } as unknown as Agent;
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "automatic",
    });

    expect(agent.afterToolCall).toBe(previousAfterToolCall);
  });
});

function createAfterToolCallContext(params: {
  toolName: string;
  args: Record<string, unknown>;
  isError?: boolean;
  result?: AfterToolCallContext["result"];
}): AfterToolCallContext {
  return {
    assistantMessage: createToolCallAssistant(params.toolName, params.args),
    toolCall: {
      type: "toolCall",
      id: "call_message",
      name: params.toolName,
      arguments: params.args,
    },
    args: params.args,
    result: params.result ?? {
      content: [
        {
          type: "text",
          text: '{"status":"ok","deliveryStatus":"sent","sourceReplySink":"internal-ui"}',
        },
      ],
      details: {
        status: "ok",
        deliveryStatus: "sent",
        sourceReplySink: "internal-ui",
        sourceReply: { text: params.args.message },
      },
    },
    isError: params.isError ?? false,
    context: {
      systemPrompt: "",
      messages: [],
      tools: [],
    },
  };
}

function createDirectSendResult(params: { messageId: string }): AfterToolCallContext["result"] {
  const payload = {
    channel: "discord",
    to: "channel:source",
    via: "direct",
    mediaUrl: null,
    result: {
      channel: "discord",
      messageId: params.messageId,
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  };
}

function createSuppressedSendResult(): AfterToolCallContext["result"] {
  const payload = {
    channel: "discord",
    to: "channel:source",
    via: "direct",
    mediaUrl: null,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  };
}

function createToolCallAssistant(
  toolName: string,
  args: Record<string, unknown>,
): AfterToolCallContext["assistantMessage"] {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_message",
        name: toolName,
        arguments: args,
      },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
}
