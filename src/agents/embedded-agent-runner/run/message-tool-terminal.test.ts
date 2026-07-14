// Message-tool delivery tests cover message_tool_only delivery, where a
// successful source message send records source reply evidence without ending
// the run before the model can observe the tool result.
import type { Agent, AfterToolCallContext } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import { installMessageToolOnlyTerminalHook } from "./message-tool-terminal.js";

async function recordsDeliveredSourceReply(params: {
  sourceReplyDeliveryMode?: Parameters<
    typeof installMessageToolOnlyTerminalHook
  >[0]["sourceReplyDeliveryMode"];
  context: AfterToolCallContext;
  hookResult?: Awaited<ReturnType<NonNullable<Agent["afterToolCall"]>>>;
}): Promise<boolean> {
  const agent = (params.hookResult
    ? { afterToolCall: vi.fn(async () => params.hookResult) }
    : {}) as unknown as Agent;
  const onDeliveredSourceReply = vi.fn();
  installMessageToolOnlyTerminalHook({
    agent,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    onDeliveredSourceReply,
  });
  await agent.afterToolCall?.(params.context);
  return onDeliveredSourceReply.mock.calls.length > 0;
}

type TerminalHookCase = {
  label: string;
  sourceReplyDeliveryMode?: Parameters<
    typeof installMessageToolOnlyTerminalHook
  >[0]["sourceReplyDeliveryMode"];
  context: AfterToolCallContext;
  hookResult?: Awaited<ReturnType<NonNullable<Agent["afterToolCall"]>>>;
  expected: boolean;
};

describe("message-tool-only source replies", () => {
  it.each([
    {
      label: "implicit successful send",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "visible reply" },
      }),
      expected: true,
    },
    {
      label: "direct send result",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "visible reply" },
        result: createDirectSendResult({ messageId: "discord-message-1" }),
      }),
      expected: true,
    },
    {
      label: "hook result delivery evidence",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "visible reply" },
        result: createSuppressedSendResult(),
      }),
      hookResult: { details: { result: { messageId: "discord-message-2" } } },
      expected: true,
    },
    {
      label: "automatic delivery mode",
      sourceReplyDeliveryMode: "automatic",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "visible reply" },
      }),
      expected: false,
    },
    {
      label: "non-send action",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "reaction", emoji: "thumbsup" },
      }),
      expected: false,
    },
    {
      label: "explicit route",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", target: "channel:other", message: "cross-channel" },
      }),
      expected: false,
    },
    {
      label: "different tool",
      context: createAfterToolCallContext({
        toolName: "sessions_send",
        args: { message: "internal delegation" },
      }),
      expected: false,
    },
    {
      label: "failed send",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "failed reply" },
        isError: true,
      }),
      expected: false,
    },
    {
      label: "dry-run argument",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "preview reply", dryRun: true },
      }),
      expected: false,
    },
    {
      label: "dry-run result payload",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "preview reply" },
        result: {
          content: [{ type: "text", text: '{"ok":true}' }],
          details: { payload: { deliveryStatus: "dry_run", dryRun: true } },
        },
      }),
      expected: false,
    },
    {
      label: "dry-run hook result",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "preview reply" },
      }),
      hookResult: { details: { deliveryStatus: "dry_run" } },
      expected: false,
    },
    {
      label: "dry-run serialized result",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "preview reply" },
        result: {
          content: [{ type: "text", text: '{"deliveryStatus":"dry_run","dryRun":true}' }],
          details: { ok: true },
        },
      }),
      expected: false,
    },
    {
      label: "suppressed send",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "suppressed reply" },
        result: createSuppressedSendResult(),
      }),
      expected: false,
    },
  ] satisfies TerminalHookCase[])(
    "records $label through the installed hook",
    async ({ sourceReplyDeliveryMode, context, hookResult, expected }) => {
      await expect(
        recordsDeliveredSourceReply({
          sourceReplyDeliveryMode: sourceReplyDeliveryMode ?? "message_tool_only",
          context,
          hookResult,
        }),
      ).resolves.toBe(expected);
    },
  );

  it("preserves existing after-tool-call output while recording delivered source replies", async () => {
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
    });
    expect(previousAfterToolCall).toHaveBeenCalledTimes(1);
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(1);
  });

  it("records delivery evidence without rewriting the default result", async () => {
    const agent = {} as unknown as Agent;
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
    ).resolves.toBeUndefined();
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
  // A nested message id is the durable delivery proof used by the terminal
  // decision helper when the channel adapter wraps its result.
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
  // Same channel shape without message id: useful to prove suppression is not
  // mistaken for delivery.
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
