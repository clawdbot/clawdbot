import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
  emitMessageStartAndEndForAssistantText,
  extractAgentEventPayloads,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession", () => {
  it("filters to <final> and suppresses output without a start tag", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();
    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      enforceFinalTag: true,
      onPartialReply,
      onAgentEvent,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "<final>Hi there</final>" });

    expect(onPartialReply).toHaveBeenCalledTimes(1);
    const firstPayload = onPartialReply.mock.calls.at(0)?.[0];
    expect(firstPayload?.text).toBe("Hi there");

    onPartialReply.mockClear();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "</final>Oops no start" });

    expect(onPartialReply).not.toHaveBeenCalled();
  });
  it("suppresses agent events on message_end without <final> tags when enforced", () => {
    const { session, emit } = createStubSessionHarness();

    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      enforceFinalTag: true,
      onAgentEvent,
    });
    emitMessageStartAndEndForAssistantText({ emit, text: "Hello world" });
    // With enforceFinalTag, text without <final> tags is treated as leaked
    // reasoning and should NOT be recovered by the message_end fallback.
    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(0);
  });
  it("emits via streaming when <final> tags are present and enforcement is on", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();
    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      enforceFinalTag: true,
      onPartialReply,
      onAgentEvent,
    });

    // With enforceFinalTag, content is emitted via streaming (text_delta path),
    // NOT recovered from message_end fallback. extractAssistantText strips
    // <final> tags, so message_end would see plain text with no <final> markers
    // and correctly suppress it (treated as reasoning leak).
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "<final>Hello world</final>" });

    expect(onPartialReply).toHaveBeenCalledTimes(1);
    expect(onPartialReply.mock.calls.at(0)?.[0]?.text).toBe("Hello world");
  });

  it("strips final tags split across streamed deltas without emitting tag remnants", () => {
    const { session, emit } = createStubSessionHarness();

    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onAgentEvent,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    for (const delta of ["<", "final>Title\n", "Line one\nLine two</", "final>"]) {
      emitAssistantTextDelta({ emit, delta });
    }

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    const streamedText = payloads.map((payload) => payload.delta).join("");
    expect(streamedText).toBe("Title\nLine one\nLine two");
    expect(streamedText).not.toContain("<");
    expect(streamedText).not.toContain("final>");
    expect(payloads.some((payload) => payload.replace)).toBe(false);
  });

  it("preserves final content when enforced final tags are split across streamed deltas", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      enforceFinalTag: true,
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    for (const delta of ["<fi", "nal>Visible", " content</fi", "nal>"]) {
      emitAssistantTextDelta({ emit, delta });
    }

    const streamedText = onPartialReply.mock.calls
      .map((call) => (call[0] as { delta?: unknown }).delta)
      .filter((delta): delta is string => typeof delta === "string")
      .join("");
    expect(streamedText).toBe("Visible content");
  });

  it("does not buffer ordinary trailing less-than text as a tag fragment", () => {
    const { session, emit } = createStubSessionHarness();

    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onAgentEvent,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "1 < 2" });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads.map((payload) => payload.delta).join("")).toBe("1 < 2");
  });

  it("flushes a literal trailing final-tag prefix when the text stream ends", () => {
    const { session, emit } = createStubSessionHarness();

    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onAgentEvent,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Answer ends with <fi" });
    emitAssistantTextEnd({ emit });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads.map((payload) => payload.delta).join("")).toBe("Answer ends with <fi");
  });

  it("flushes a literal trailing final-tag prefix in text_end block replies", async () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Answer ends with <fi" });
    emitAssistantTextEnd({ emit });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls.at(0)?.[0]?.text).toBe("Answer ends with <fi");
  });

  it("keeps a trailing final-tag prefix when synchronous message_end drains chunked text_end replies", async () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 1, maxChars: 200 },
    });

    const text = "Answer ends with <fi";
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
    } as AssistantMessage;

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: text });
    emitAssistantTextEnd({ emit });
    emit({ type: "message_end", message: assistantMessage });
    await Promise.resolve();

    expect(onBlockReply.mock.calls.map((call) => call[0]?.text)).toEqual([
      "Answer ends with",
      "<fi",
    ]);
  });

  it("preserves literal trailing tag-prefix text from message end fallback", () => {
    const { session, emit } = createStubSessionHarness();

    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onAgentEvent,
    });

    emitMessageStartAndEndForAssistantText({ emit, text: "Answer ends with <" });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads.map((payload) => payload.delta).join("")).toBe("Answer ends with <");
  });
  it("does not require <final> when enforcement is off", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onPartialReply,
    });

    emitAssistantTextDelta({ emit, delta: "Hello world" });

    const payload = onPartialReply.mock.calls.at(0)?.[0];
    expect(payload?.text).toBe("Hello world");
  });
  it("emits block replies on message_end", async () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello block" }],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessage });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const payload = onBlockReply.mock.calls.at(0)?.[0];
    expect(payload?.text).toBe("Hello block");
  });
});
