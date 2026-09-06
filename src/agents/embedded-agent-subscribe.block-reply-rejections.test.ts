// Block-reply rejection tests ensure async callback failures are contained and
// do not escape as process-level unhandled rejections.
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_RESPONSE_TOOL_NAME } from "../auto-reply/heartbeat-tool-response.js";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
  emitMessageStartAndEndForAssistantText,
} from "./embedded-agent-subscribe.e2e-harness.js";

const waitForAsyncCallbacks = async () => {
  // Block reply callbacks are scheduled asynchronously; this drains both
  // microtasks and the immediate queue before checking unhandled rejections.
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

function emitToolRun(params: {
  emit: (evt: unknown) => void;
  toolName: string;
  toolCallId: string;
  result: unknown;
}): void {
  params.emit({
    type: "tool_execution_start",
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    args: {},
  });
  params.emit({
    type: "tool_execution_end",
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    isError: false,
    result: params.result,
  });
}

describe("subscribeEmbeddedAgentSession block reply rejections", () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    // Capture process-level failures so tests prove callback containment.
    unhandledRejections.push(reason);
  };

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    unhandledRejections.length = 0;
  });

  it("contains rejected async text_end block replies", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const onBlockReply = vi.fn().mockRejectedValue(new Error("boom"));
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
    });

    emitAssistantTextDelta({ emit, delta: "Hello block" });
    emitAssistantTextEnd({ emit });
    await waitForAsyncCallbacks();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.getVisibleBlockReplyCount()).toBe(0);
    expect(unhandledRejections).toHaveLength(0);
  });

  it("contains rejected async message_end block replies", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const onBlockReply = vi.fn().mockRejectedValue(new Error("boom"));
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({ emit, text: "Hello block" });
    await waitForAsyncCallbacks();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.getVisibleBlockReplyCount()).toBe(0);
    expect(unhandledRejections).toHaveLength(0);
  });

  it("does not count deferred block replies rejected after terminal approval", async () => {
    const onBlockReply = vi.fn().mockRejectedValue(new Error("terminal transport failed"));
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "deferred-block-rejection",
      onBlockReply,
      onBeforeTerminalDelivery: async () => undefined,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({ emit, text: "Deferred answer" });
    emit({ type: "agent_end", messages: [], willRetry: false });
    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(subscription.getVisibleBlockReplyCount()).toBe(0);
  });

  it.each([
    { mode: "synchronous failure", failure: "throw" },
    { mode: "asynchronous failure", failure: "reject" },
    { mode: "successful delivery", failure: "none" },
  ] as const)("preserves accurate tool-media ownership after $mode", async ({ failure }) => {
    const onBlockReply = vi.fn(() => {
      if (failure === "throw") {
        throw new Error("synchronous media delivery failed");
      }
      if (failure === "reject") {
        return Promise.reject(new Error("asynchronous media delivery failed"));
      }
      return Promise.resolve();
    });
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: `tool-media-${failure}`,
      onBlockReply,
      builtinToolNames: new Set(["tts"]),
    });
    const expectedMedia = {
      mediaUrls: ["/tmp/reply.opus"],
      audioAsVoice: true,
    };

    emitToolRun({
      emit,
      toolName: "tts",
      toolCallId: `tts-${failure}`,
      result: { details: { media: { mediaUrl: "/tmp/reply.opus", audioAsVoice: true } } },
    });
    await subscription.waitForPendingEvents();
    expect(subscription.getPendingToolMediaReply()).toEqual(expectedMedia);

    emit({ type: "agent_end", messages: [], willRetry: false });
    await subscription.waitForPendingEvents();

    const delivered = failure === "none";
    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(subscription.getPendingToolMediaReply()).toEqual(delivered ? null : expectedMedia);
    expect(subscription.getVisibleBlockReplyCount()).toBe(delivered ? 1 : 0);
    expect(subscription.hasToolMediaBlockReply()).toBe(delivered);
  });

  it.each([false, true])(
    "retains rejected assistant media without retrying during terminal delivery (deferred: %s)",
    async (deferred) => {
      const onBlockReply = vi.fn().mockRejectedValue(new Error("assistant media rejected"));
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: `assistant-media-${deferred}`,
        onBlockReply,
        blockReplyBreak: "message_end",
        ...(deferred ? { onBeforeTerminalDelivery: async () => undefined } : {}),
        internalEvents: [
          {
            type: "task_completion",
            source: "music_generation",
            childSessionKey: "music_generate:task-123",
            announceType: "music generation task",
            taskLabel: "generated track",
            status: "ok",
            statusLabel: "completed successfully",
            result: "Generated a track.",
            mediaUrls: ["/tmp/generated.opus"],
            attachments: [
              { path: "/tmp/generated.opus", mimeType: "audio/ogg", name: "generated.opus" },
            ],
            replyInstruction: "Reply normally.",
          },
        ],
      });
      const expectedMedia = subscription.getPendingToolMediaReply();
      expect(expectedMedia).toEqual({
        mediaUrls: ["/tmp/generated.opus"],
        attachments: [
          {
            path: "/tmp/generated.opus",
            mimeType: "audio/ogg",
            name: "generated.opus",
            trustedLocalMedia: true,
          },
        ],
        audioAsVoice: undefined,
        trustedLocalMedia: true,
      });

      emitMessageStartAndEndForAssistantText({ emit, text: "Here is your track." });
      emit({ type: "agent_end", messages: [], willRetry: false });
      await subscription.waitForPendingEvents();

      expect(onBlockReply).toHaveBeenCalledOnce();
      expect(subscription.getPendingToolMediaReply()).toEqual(expectedMedia);
      expect(subscription.getVisibleBlockReplyCount()).toBe(0);
      expect(subscription.hasToolMediaBlockReply()).toBe(false);
    },
  );

  it("retains accepted delivery evidence when a later block is rejected", async () => {
    const onBlockReply = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second block rejected"));
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "partially-accepted-block-replies",
      onBlockReply,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({ emit, text: "First delivered answer." });
    await subscription.waitForPendingEvents();
    emitMessageStartAndEndForAssistantText({ emit, text: "Second rejected answer." });
    emit({ type: "agent_end", messages: [], willRetry: false });
    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(subscription.getVisibleBlockReplyCount()).toBe(1);
  });

  it("delivers queued media after an unrelated reasoning callback is rejected", async () => {
    const onBlockReply = vi
      .fn()
      .mockRejectedValueOnce(new Error("reasoning delivery failed"))
      .mockResolvedValueOnce(undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "failed-reasoning-pending-media",
      onBlockReply,
      reasoningMode: "on",
      thinkingLevel: "medium",
      blockReplyBreak: "message_end",
      builtinToolNames: new Set(["tts"]),
    });
    emitToolRun({
      emit,
      toolName: "tts",
      toolCallId: "reasoning-tts",
      result: { details: { media: { mediaUrl: "/tmp/reply.opus", audioAsVoice: true } } },
    });
    await subscription.waitForPendingEvents();

    const reasoningMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Considering the reply" }],
      stopReason: "stop",
    };
    emit({ type: "message_start", message: reasoningMessage });
    emit({ type: "message_end", message: reasoningMessage });
    emit({ type: "agent_end", messages: [reasoningMessage], willRetry: false });
    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply).toHaveBeenLastCalledWith({
      mediaUrls: ["/tmp/reply.opus"],
      audioAsVoice: true,
    });
    expect(subscription.getPendingToolMediaReply()).toBeNull();
    expect(subscription.getVisibleBlockReplyCount()).toBe(1);
    expect(subscription.hasToolMediaBlockReply()).toBe(true);
  });

  it("contains rejected assistant progress callbacks", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const rejectedCallback = vi.fn().mockRejectedValue(new Error("boom"));
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onAgentEvent: rejectedCallback,
      onPartialReply: rejectedCallback,
      onAssistantMessageStart: rejectedCallback,
      onReasoningStream: rejectedCallback,
      onReasoningEnd: rejectedCallback,
      reasoningMode: "stream",
    });

    emitMessageStartAndEndForAssistantText({ emit, text: "Hello" });
    emitAssistantTextDelta({ emit, delta: "Hello" });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", delta: "Because" },
    });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_end" },
    });
    await waitForAsyncCallbacks();

    expect(rejectedCallback).toHaveBeenCalled();
    expect(unhandledRejections).toHaveLength(0);
  });

  it("contains rejected tool presentation callbacks", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const onToolResult = vi.fn().mockRejectedValue(new Error("tool progress failed"));
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onToolResult,
      verboseLevel: "full",
    });

    emitToolRun({
      emit,
      toolName: "read",
      toolCallId: "tool-1",
      result: { content: [{ type: "text", text: "file contents" }] },
    });
    await waitForAsyncCallbacks();

    expect(onToolResult).toHaveBeenCalled();
    expect(unhandledRejections).toHaveLength(0);
  });

  it("contains rejected heartbeat response callbacks", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const onHeartbeatToolResponse = vi.fn().mockRejectedValue(new Error("heartbeat failed"));
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onHeartbeatToolResponse,
    });

    emitToolRun({
      emit,
      toolName: HEARTBEAT_RESPONSE_TOOL_NAME,
      toolCallId: "heartbeat-1",
      result: {
        details: {
          status: "accepted",
          outcome: "no_change",
          notify: false,
          summary: "Nothing needs attention.",
        },
      },
    });
    await waitForAsyncCallbacks();

    expect(onHeartbeatToolResponse).toHaveBeenCalledTimes(1);
    expect(unhandledRejections).toHaveLength(0);
  });
});
