import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

function createBlockReplyHarness(blockReplyBreak: "message_end" | "text_end") {
  const { session, emit } = createStubSessionHarness();
  const onBlockReply = vi.fn();
  const subscription = subscribeEmbeddedPiSession({
    session,
    runId: "run",
    onBlockReply,
    blockReplyBreak,
  });
  return { emit, onBlockReply, subscription };
}

async function emitMessageToolLifecycle(params: {
  emit: (evt: unknown) => void;
  toolCallId: string;
  message: string;
  media?: string;
  result: unknown;
}) {
  params.emit({
    type: "tool_execution_start",
    toolName: "message",
    toolCallId: params.toolCallId,
    args: { action: "send", to: "+1555", message: params.message, media: params.media },
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

describe("subscribeEmbeddedPiSession", () => {
  it("suppresses message_end block replies when the message tool already sent", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end");

    const messageText = "This is the answer.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-1",
      message: messageText,
      result: "ok",
    });
    emitAssistantMessageEnd(emit, messageText);
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
      result: "ok",
    });
    await Promise.resolve();

    expect(subscription.didSendViaMessagingTool()).toBe(true);
    expect(subscription.getMessagingToolSentMediaUrls()).toEqual(["file:///tmp/render.mp4"]);
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
