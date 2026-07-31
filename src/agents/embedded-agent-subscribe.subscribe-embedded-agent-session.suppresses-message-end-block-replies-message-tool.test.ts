// Message-tool suppression tests cover delivery tracking, source-reply mirrors,
// and duplicate reply prevention after message tool sends.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  createSubscribedSessionHarness,
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";

function createBlockReplyHarness(
  blockReplyBreak: "message_end" | "text_end",
  options: {
    sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    hasDeliveredMessageToolOnlySourceReply?: () => boolean;
    onDeliveredMessageToolOnlySourceReply?: () => void;
    reasoningMode?: "off" | "on" | "stream";
    onReasoningEnd?: () => void;
    onReasoningStream?: (payload: { text?: string }) => void;
  } = {},
) {
  // Harness exposes both emitted block replies and subscription state so tests
  // can distinguish suppression from missing delivery tracking.
  const { session, emit } = createStubSessionHarness();
  const onBlockReply = vi.fn();
  const onPartialReply = vi.fn();
  const onAgentEvent = vi.fn();
  const subscription = subscribeEmbeddedAgentSession({
    session,
    runId: "run",
    onBlockReply,
    onPartialReply,
    onAgentEvent,
    onReasoningEnd: options.onReasoningEnd,
    onReasoningStream: options.onReasoningStream,
    blockReplyBreak,
    reasoningMode: options.reasoningMode,
    sourceReplyDeliveryMode: options.sourceReplyDeliveryMode,
    hasDeliveredMessageToolOnlySourceReply: options.hasDeliveredMessageToolOnlySourceReply,
    onDeliveredMessageToolOnlySourceReply: options.onDeliveredMessageToolOnlySourceReply,
  });
  return { emit, onAgentEvent, onBlockReply, onPartialReply, subscription };
}

async function emitMessageToolLifecycle(params: {
  emit: (evt: unknown) => void;
  toolCallId: string;
  message: string;
  media?: string;
  to?: string | null;
  result: unknown;
}) {
  // Message tool sends are modeled as normal tool start/end events because the
  // subscription records pending send text at start and delivery at end.
  params.emit({
    type: "tool_execution_start",
    toolName: "message",
    toolCallId: params.toolCallId,
    args: {
      action: "send",
      ...(params.to === null ? {} : { to: params.to ?? "+1555" }),
      message: params.message,
      media: params.media,
    },
  });
  // Wait for async handler to complete.
  await Promise.resolve();
  params.emit({
    type: "tool_execution_end",
    toolName: "message",
    toolCallId: params.toolCallId,
    isError: false,
    result: params.result,
  });
}

function emitAssistantMessageEnd(
  emit: (evt: unknown) => void,
  text: string,
  overrides?: Partial<AssistantMessage>,
) {
  const assistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    ...overrides,
  } as AssistantMessage;
  emit({ type: "message_end", message: assistantMessage });
}

function emitAssistantTextEndBlock(emit: (evt: unknown) => void, text: string) {
  emit({ type: "message_start", message: { role: "assistant" } });
  emitAssistantTextDelta({ emit, delta: text });
  emitAssistantTextEnd({ emit });
}

describe("subscribeEmbeddedAgentSession", () => {
  it("suppresses message_end block replies when the message tool already sent", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end");

    const messageText = "This is the answer.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-1",
      message: messageText,
      result: { details: { deliveryStatus: "sent" } },
    });
    emitAssistantMessageEnd(emit, messageText);
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("suppresses later message_end block replies after message-tool-only delivery", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end", {
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-continue",
      message: "Starting the requested work.",
      to: null,
      result: { details: { deliveryStatus: "sent" } },
    });
    emitAssistantMessageEnd(emit, "Done.");
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("reports bridged message-tool-only source delivery to the attempt", async () => {
    const onDeliveredMessageToolOnlySourceReply = vi.fn();
    const { emit } = createBlockReplyHarness("message_end", {
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredMessageToolOnlySourceReply,
    });

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-bridged-source-reply",
      message: "Visible source reply from Code Mode.",
      to: null,
      result: { details: { deliveryStatus: "sent" } },
    });

    expect(onDeliveredMessageToolOnlySourceReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses later text_end block replies after message-tool-only delivery", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("text_end", {
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-text-end-continue",
      message: "Starting the requested work.",
      to: null,
      result: { details: { deliveryStatus: "sent" } },
    });
    emitAssistantTextEndBlock(emit, "Done.");
    await Promise.resolve();
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("does not suppress source replies after explicit routed message-tool-only sends", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end", {
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-routed",
      message: "Sent somewhere else.",
      to: "+1555",
      result: { details: { deliveryStatus: "sent" } },
    });
    emitAssistantMessageEnd(emit, "Reply to the current source.");
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
  });

  it("does not suppress source replies after non-message messaging tools send", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end", {
      sourceReplyDeliveryMode: "message_tool_only",
    });

    emit({
      type: "tool_execution_start",
      toolName: "sessions_send",
      toolCallId: "tool-sessions-send",
      args: { message: "Sent to a spawned session." },
    });
    await Promise.resolve();
    emit({
      type: "tool_execution_end",
      toolName: "sessions_send",
      toolCallId: "tool-sessions-send",
      isError: false,
      result: { details: { deliveryStatus: "sent" } },
    });
    emitAssistantMessageEnd(emit, "Reply to the current source.");
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
  });

  it("preserves source-reply suppression across compaction retries", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end", {
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-before-compaction",
      message: "Starting the requested work.",
      to: null,
      result: { details: { deliveryStatus: "sent" } },
    });
    emit({ type: "compaction_end", willRetry: true, result: { summary: "compacted" } });
    await Promise.resolve();
    emitAssistantMessageEnd(emit, "Done after compaction.");
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("preserves internal source-reply payloads across compaction retries", async () => {
    const { emit, subscription } = createBlockReplyHarness("message_end", {
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-internal-before-compaction",
      message: "Visible terminal answer.",
      result: {
        details: {
          status: "ok",
          deliveryStatus: "sent",
          sourceReplySink: "internal-ui",
          sourceReply: { text: "Visible terminal answer." },
        },
      },
    });
    emit({ type: "compaction_end", willRetry: true, result: { summary: "compacted" } });
    await Promise.resolve();

    expect(subscription.getMessagingToolSourceReplyPayloads()).toEqual([
      { text: "Visible terminal answer." },
    ]);
  });

  it("suppresses later assistant stream and partial replies after message-tool-only delivery", async () => {
    const { emit, onAgentEvent, onPartialReply } = createBlockReplyHarness("text_end", {
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-before-partial",
      message: "Starting the requested work.",
      to: null,
      result: { details: { deliveryStatus: "sent" } },
    });
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Done." });
    await Promise.resolve();

    expect(onPartialReply).not.toHaveBeenCalled();
    expect(onAgentEvent.mock.calls.some((call) => call[0]?.stream === "assistant")).toBe(false);
  });

  it("suppresses later reasoning streams after message-tool-only delivery", async () => {
    const onReasoningStream = vi.fn();
    const onReasoningEnd = vi.fn();
    const { emit } = createBlockReplyHarness("message_end", {
      sourceReplyDeliveryMode: "message_tool_only",
      reasoningMode: "stream",
      onReasoningEnd,
      onReasoningStream,
    });

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-before-reasoning",
      message: "Starting the requested work.",
      to: null,
      result: { details: { deliveryStatus: "sent" } },
    });
    emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }] },
      assistantMessageEvent: { type: "thinking_delta", delta: "private" },
    });
    emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }] },
      assistantMessageEvent: { type: "thinking_end" },
    });
    await Promise.resolve();

    expect(onReasoningStream).not.toHaveBeenCalled();
    expect(onReasoningEnd).not.toHaveBeenCalled();
  });

  it("suppresses later tagged reasoning streams after message-tool-only delivery", async () => {
    const onReasoningStream = vi.fn();
    const onReasoningEnd = vi.fn();
    const { emit } = createBlockReplyHarness("message_end", {
      sourceReplyDeliveryMode: "message_tool_only",
      reasoningMode: "stream",
      onReasoningEnd,
      onReasoningStream,
    });

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-before-tagged-reasoning",
      message: "Starting the requested work.",
      to: null,
      result: { details: { deliveryStatus: "sent" } },
    });
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "<think>private reasoning" });
    emitAssistantTextDelta({ emit, delta: "</think>Done." });
    await Promise.resolve();

    expect(onReasoningStream).not.toHaveBeenCalled();
    expect(onReasoningEnd).not.toHaveBeenCalled();
  });

  it("uses runner-level delivery evidence when tool result details were rewritten", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end", {
      sourceReplyDeliveryMode: "message_tool_only",
      hasDeliveredMessageToolOnlySourceReply: () => true,
    });

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-rewritten-result",
      message: "Starting the requested work.",
      to: null,
      result: { details: { rewritten: true } },
    });
    emitAssistantMessageEnd(emit, "Done after rewritten tool result.");
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("tracks media-only message tool sends as messaging delivery", async () => {
    const { emit, subscription } = createBlockReplyHarness("message_end");

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-media",
      message: "",
      media: "file:///tmp/render.mp4",
      result: { details: { deliveryStatus: "sent" } },
    });
    await Promise.resolve();

    expect(subscription.didSendViaMessagingTool()).toBe(true);
    expect(subscription.getMessagingToolSentMediaUrls()).toEqual(["file:///tmp/render.mp4"]);
  });

  it("tracks internal-ui source replies for message-tool-only final payloads", async () => {
    // internal-ui source replies are not ordinary channel sends; they are stored
    // for terminal payload mirroring in message_tool_only mode.
    const { emit, subscription } = createBlockReplyHarness("message_end");

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-source-reply",
      message: "Visible terminal answer.",
      result: {
        details: {
          status: "ok",
          deliveryStatus: "sent",
          sourceReplySink: "internal-ui",
          sourceReply: { text: "Visible terminal answer." },
        },
      },
    });
    await Promise.resolve();

    expect(subscription.getMessagingToolSourceReplyPayloads()).toEqual([
      { text: "Visible terminal answer." },
    ]);
  });

  it("suppresses text-only tool summaries after message-tool-only delivery", async () => {
    const onToolResult = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run-message-tool-progress",
      verboseLevel: "on",
      sourceReplyDeliveryMode: "message_tool_only",
      onToolResult,
    });

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-final",
      message: "Final answer sent through the message tool.",
      result: { details: { deliveryStatus: "sent" } },
    });
    onToolResult.mockClear();

    emit({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-exec-late",
      args: { command: "false" },
    });
    await Promise.resolve();

    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("does not suppress message_end replies when message tool reports error", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end");

    const messageText = "Please retry the send.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-err",
      message: messageText,
      result: { details: { status: "error" } },
    });
    emitAssistantMessageEnd(emit, messageText);
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
  });

  it("ignores delivery-mirror assistant messages", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end");

    emitAssistantMessageEnd(emit, "Mirrored transcript text", {
      provider: "openclaw",
      model: "delivery-mirror",
    });
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("ignores gateway-injected assistant messages", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end");

    emitAssistantMessageEnd(emit, "Injected transcript text", {
      provider: "openclaw",
      model: "gateway-injected",
    });
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("clears block reply state on message_start", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("text_end");
    emitAssistantTextEndBlock(emit, "OK");
    await Promise.resolve();
    expect(onBlockReply).toHaveBeenCalledTimes(1);

    // New assistant message with identical output should still emit.
    emitAssistantTextEndBlock(emit, "OK");
    await Promise.resolve();
    expect(onBlockReply).toHaveBeenCalledTimes(2);
  });
});
