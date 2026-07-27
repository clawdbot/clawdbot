// Final-tag enforcement tests cover suppression of leaked reasoning and safe
// extraction of <final> content across streamed code/fence boundaries.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
  emitMessageStartAndEndForAssistantText,
  extractAgentEventPayloads,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";

type ReplyMock = ReturnType<typeof vi.fn>;
type ReplyPayload = { text?: string };

function requireFirstReplyPayload(mock: ReplyMock): ReplyPayload {
  // Enforcement cases emit at most one visible reply before assertions inspect
  // whether the hidden prefix stayed suppressed.
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("expected first reply call");
  }
  const payload = call[0];
  if (!payload || typeof payload !== "object") {
    throw new Error("expected first reply payload");
  }
  return payload as ReplyPayload;
}

describe("subscribeEmbeddedAgentSession", () => {
  it("filters to <final> and suppresses output without a start tag", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();
    const onAgentEvent = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      enforceFinalTag: true,
      onPartialReply,
      onAgentEvent,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "<final>Hi there</final>" });

    expect(onPartialReply).toHaveBeenCalledTimes(1);
    const firstPayload = requireFirstReplyPayload(onPartialReply);
    expect(firstPayload?.text).toBe("Hi there");

    onPartialReply.mockClear();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "</final>Oops no start" });

    expect(onPartialReply).not.toHaveBeenCalled();
  });
  it("suppresses agent events on message_end without <final> tags when enforced", () => {
    const { session, emit } = createStubSessionHarness();

    const onAgentEvent = vi.fn();

    subscribeEmbeddedAgentSession({
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

    subscribeEmbeddedAgentSession({
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
    expect(requireFirstReplyPayload(onPartialReply).text).toBe("Hello world");
  });

  it("keeps final tag literals inside streamed fenced code while enforcement is on", () => {
    // Literal <final> tags inside code fences remain hidden until a real final
    // tag appears outside the fence.
    const { session, emit } = createStubSessionHarness();

    const onAgentEvent = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      enforceFinalTag: true,
      onAgentEvent,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "```xml\n" });
    emitAssistantTextDelta({ emit, delta: "<final>literal</final>\n" });
    emitAssistantTextDelta({ emit, delta: "```\n<final>Answer</final>" });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Answer");
  });

  it("does not keep stale fence state after a suppressed prefix closes before final text", () => {
    const { session, emit } = createStubSessionHarness();

    const onAgentEvent = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      enforceFinalTag: true,
      onAgentEvent,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "```xml\n" });
    emitAssistantTextDelta({ emit, delta: "```\n<final>Answer" });
    emitAssistantTextDelta({ emit, delta: "</final><think>secret</think>" });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Answer");
    expect(payloads.some((payload) => String(payload.text).includes("secret"))).toBe(false);
  });

  it("does not let suppressed inline code state hide later final tags", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      enforceFinalTag: true,
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "draft `" });
    emitAssistantTextDelta({ emit, delta: "<final>Answer</final>" });

    expect(onPartialReply).toHaveBeenCalledTimes(1);
    expect(requireFirstReplyPayload(onPartialReply).text).toBe("Answer");
  });

  it("closes hidden reasoning fences split across deltas before final text", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      enforceFinalTag: true,
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "<think>\n```ts\nconst hidden = true;\n``" });
    emitAssistantTextDelta({ emit, delta: "`\n</think><final>Answer</final>" });

    expect(onPartialReply).toHaveBeenCalledTimes(1);
    expect(requireFirstReplyPayload(onPartialReply).text).toBe("Answer");
  });

  it("strips nested final tag literals after suppressed fenced prefixes", () => {
    const { session, emit } = createStubSessionHarness();

    const onAgentEvent = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      enforceFinalTag: true,
      onAgentEvent,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "```xml\n" });
    emitAssistantTextDelta({
      emit,
      delta: "```\n<final>Answer <final>literal</final></final>",
    });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Answer literal");
  });

  it("strips final tags split across streamed deltas without emitting tag remnants", () => {
    const { session, emit } = createStubSessionHarness();

    const onAgentEvent = vi.fn();

    subscribeEmbeddedAgentSession({
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

  it("strips self-closing and attributed final tags from streamed deltas", () => {
    const { session, emit } = createStubSessionHarness();

    const onAgentEvent = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      onAgentEvent,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({
      emit,
      delta: "<final data-model=openrouter/google/gemini>Visible<final/>",
    });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    const streamedText = payloads.map((payload) => payload.delta).join("");
    expect(streamedText).toBe("Visible");
    expect(streamedText).not.toContain("<final");
  });

  it("strips attributed final tags split across streamed deltas", () => {
    const { session, emit } = createStubSessionHarness();

    const onAgentEvent = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      onAgentEvent,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    for (const delta of ["<final data-model='ge", "mini'>Visible</final>"]) {
      emitAssistantTextDelta({ emit, delta });
    }

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    const streamedText = payloads.map((payload) => payload.delta).join("");
    expect(streamedText).toBe("Visible");
    expect(streamedText).not.toContain("<final");
  });

  it("treats self-closing final tags as closers during enforced streaming", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      enforceFinalTag: true,
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({
      emit,
      delta: "<final data-model='gemma'>Visible<final data-model='x' />hidden",
    });

    const streamedText = onPartialReply.mock.calls
      .map((call) => (call[0] as { delta?: unknown }).delta)
      .filter((delta): delta is string => typeof delta === "string")
      .join("");
    expect(streamedText).toBe("Visible");
  });

  it("treats leading self-closing final tags as openers during enforced streaming", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      enforceFinalTag: true,
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({
      emit,
      delta: "<final data-model=openrouter/google/gemini/>Visible",
    });

    const streamedText = onPartialReply.mock.calls
      .map((call) => (call[0] as { delta?: unknown }).delta)
      .filter((delta): delta is string => typeof delta === "string")
      .join("");
    expect(streamedText).toBe("Visible");
  });

  it("preserves enforced final content when attributed final tags split across deltas", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      enforceFinalTag: true,
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    for (const delta of ["<final data-model=openrouter/google/ge", "mma>Visible</final>"]) {
      emitAssistantTextDelta({ emit, delta });
    }

    const streamedText = onPartialReply.mock.calls
      .map((call) => (call[0] as { delta?: unknown }).delta)
      .filter((delta): delta is string => typeof delta === "string")
      .join("");
    expect(streamedText).toBe("Visible");
  });

  it("does not treat custom or malformed final-like tags as enforced final blocks", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      enforceFinalTag: true,
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "<final-result>hidden" });
    emitAssistantTextDelta({ emit, delta: '<final reason="a>b">also hidden' });

    expect(onPartialReply).not.toHaveBeenCalled();
  });

  it("preserves final content when enforced final tags are split across streamed deltas", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedAgentSession({
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

    subscribeEmbeddedAgentSession({
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

    subscribeEmbeddedAgentSession({
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

    subscribeEmbeddedAgentSession({
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
    expect(requireFirstReplyPayload(onBlockReply).text).toBe("Answer ends with <fi");
  });

  it("keeps a trailing final-tag prefix when synchronous message_end drains chunked text_end replies", async () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReply = vi.fn();

    subscribeEmbeddedAgentSession({
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

    subscribeEmbeddedAgentSession({
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

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      onPartialReply,
    });

    emitAssistantTextDelta({ emit, delta: "Hello world" });

    const payload = requireFirstReplyPayload(onPartialReply);
    expect(payload?.text).toBe("Hello world");
  });
  it("emits block replies on message_end", async () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReply = vi.fn();

    subscribeEmbeddedAgentSession({
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
    const payload = requireFirstReplyPayload(onBlockReply);
    expect(payload?.text).toBe("Hello block");
  });
});
