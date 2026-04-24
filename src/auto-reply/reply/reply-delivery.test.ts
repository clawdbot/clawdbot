import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { createBlockReplyContentKey } from "./block-reply-pipeline.js";
import {
  createBlockReplyDeliveryHandler,
  normalizeReplyPayloadDirectives,
} from "./reply-delivery.js";
import type { TypingSignaler } from "./typing-mode.js";

type BlockReplyPipelineLike = NonNullable<
  Parameters<typeof createBlockReplyDeliveryHandler>[0]["blockReplyPipeline"]
>;

describe("createBlockReplyDeliveryHandler", () => {
  it("keeps captioned media-bearing block replies buffered when block streaming is disabled", async () => {
    const onBlockReply = vi.fn(async () => {});
    const normalizeStreamingText = vi.fn((payload: { text?: string }) => ({
      text: payload.text,
      skip: false,
    }));
    const directlySentBlockKeys = new Set<string>();
    const typingSignals = {
      signalTextDelta: vi.fn(async () => {}),
    } as unknown as TypingSignaler;

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply,
      normalizeStreamingText,
      applyReplyToMode: (payload) => payload,
      typingSignals,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      directlySentBlockKeys,
    });

    await handler({
      text: "here's the vibe",
      mediaUrls: ["/tmp/generated.png"],
      replyToCurrent: true,
    });

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(directlySentBlockKeys).toEqual(new Set());
    expect(typingSignals.signalTextDelta).toHaveBeenCalledWith("here's the vibe");
  });

  it("sends media-only block replies when block streaming is disabled", async () => {
    const onBlockReply = vi.fn(async () => {});
    const directlySentBlockKeys = new Set<string>();

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply,
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      directlySentBlockKeys,
    });

    await handler({
      mediaUrls: ["/tmp/generated.png"],
      replyToCurrent: true,
    });

    expect(onBlockReply).toHaveBeenCalledWith({
      mediaUrl: "/tmp/generated.png",
      mediaUrls: ["/tmp/generated.png"],
      replyToCurrent: true,
      replyToId: undefined,
      replyToTag: undefined,
      audioAsVoice: false,
      text: undefined,
    });
    expect(directlySentBlockKeys).toEqual(
      new Set([
        createBlockReplyContentKey({
          mediaUrls: ["/tmp/generated.png"],
          replyToCurrent: true,
        }),
      ]),
    );
  });

  it("keeps text-only block replies buffered when block streaming is disabled", async () => {
    const onBlockReply = vi.fn(async () => {});

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply,
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      directlySentBlockKeys: new Set(),
    });

    await handler({ text: "text only" });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("trims leading whitespace in block-streamed replies", async () => {
    const blockReplyPipeline = {
      enqueue: vi.fn(),
    } as unknown as BlockReplyPipelineLike;

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: vi.fn(async () => {}),
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: true,
      blockReplyPipeline,
      directlySentBlockKeys: new Set(),
    });

    await handler({ text: "\n\n  Hello from stream" });

    expect(blockReplyPipeline.enqueue).toHaveBeenCalledWith({
      text: "Hello from stream",
      mediaUrl: undefined,
      replyToId: undefined,
      replyToCurrent: undefined,
      replyToTag: undefined,
      audioAsVoice: false,
      mediaUrls: undefined,
    });
  });

  it("suppresses implicit current-message threading for block replies when reply threading denies it", async () => {
    const blockReplyPipeline = {
      enqueue: vi.fn(),
    } as unknown as BlockReplyPipelineLike;

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: vi.fn(async () => {}),
      currentMessageId: "msg-123",
      replyThreading: { implicitCurrentMessage: "deny" },
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: true,
      blockReplyPipeline,
      directlySentBlockKeys: new Set(),
    });

    await handler({ text: "reset intro" });

    expect(blockReplyPipeline.enqueue).toHaveBeenCalledWith({
      text: "reset intro",
      mediaUrl: undefined,
      replyToId: undefined,
      replyToCurrent: undefined,
      replyToTag: undefined,
      audioAsVoice: false,
      mediaUrls: undefined,
    });
  });

  it("parses media directives in block replies before path normalization", () => {
    const normalized = normalizeReplyPayloadDirectives({
      payload: { text: "Result\nMEDIA: ./image.png" },
      trimLeadingWhitespace: true,
      parseMode: "auto",
    });

    expect(normalized.payload).toMatchObject({
      text: "Result",
      mediaUrl: "./image.png",
      mediaUrls: ["./image.png"],
    });
  });

  it("parses lowercase media directives in block replies before path normalization", () => {
    const normalized = normalizeReplyPayloadDirectives({
      payload: { text: "media: ./report.pdf" },
      trimLeadingWhitespace: true,
      parseMode: "auto",
    });

    expect(normalized.payload).toMatchObject({
      text: undefined,
      mediaUrl: "./report.pdf",
      mediaUrls: ["./report.pdf"],
    });
  });

  it("does not mark plain replies as explicit reply_to_current opt-outs", () => {
    const normalized = normalizeReplyPayloadDirectives({
      payload: { text: "plain reply" },
      trimLeadingWhitespace: true,
      parseMode: "auto",
    });

    expect(normalized.payload.replyToCurrent).toBeUndefined();
  });

  it("passes normalized media block replies through media path normalization", async () => {
    const blockReplyPipeline = {
      enqueue: vi.fn(),
    } as unknown as BlockReplyPipelineLike;
    const absPath = path.join("/tmp/home", "openclaw", "image.png");

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: vi.fn(async () => {}),
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      normalizeMediaPaths: async (payload) => ({
        ...payload,
        mediaUrl: absPath,
        mediaUrls: [absPath],
      }),
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: true,
      blockReplyPipeline,
      directlySentBlockKeys: new Set(),
    });

    await handler({ text: "Result\nMEDIA: ./image.png" });

    expect(blockReplyPipeline.enqueue).toHaveBeenCalledWith({
      text: "Result",
      mediaUrl: absPath,
      mediaUrls: [absPath],
      replyToId: undefined,
      replyToCurrent: undefined,
      replyToTag: false,
      audioAsVoice: false,
    });
  });

  it("preserves reply payload metadata across block-reply normalization", async () => {
    const enqueue = vi.fn();
    const blockReplyPipeline = {
      enqueue,
    } as unknown as BlockReplyPipelineLike;

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: vi.fn(async () => {}),
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => ({ ...payload, replyToTag: true }),
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: true,
      blockReplyPipeline,
      directlySentBlockKeys: new Set(),
    });

    const payload = setReplyPayloadMetadata({ text: "Alpha" }, { assistantMessageIndex: 7 });

    await handler(payload);

    const enqueuedPayload = enqueue.mock.calls[0]?.[0];
    expect(enqueuedPayload).toEqual({
      text: "Alpha",
      mediaUrl: undefined,
      replyToId: undefined,
      replyToCurrent: undefined,
      replyToTag: true,
      audioAsVoice: false,
      mediaUrls: undefined,
    });
    expect(getReplyPayloadMetadata(enqueuedPayload)).toEqual({
      assistantMessageIndex: 7,
    });
  });
});
