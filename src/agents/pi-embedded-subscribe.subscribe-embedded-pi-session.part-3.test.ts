import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

describe("subscribeEmbeddedPiSession", () => {
  const THINKING_TAG_CASES = [
    { tag: "think", open: "<think>", close: "</think>" },
    { tag: "thinking", open: "<thinking>", close: "</thinking>" },
    { tag: "thought", open: "<thought>", close: "</thought>" },
    { tag: "antthinking", open: "<antthinking>", close: "</antthinking>" },
  ] as const;

  it.each(
    THINKING_TAG_CASES,
  )("streams <%s> reasoning via onReasoningStream without leaking into final text", ({
    open,
    close,
  }) => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onReasoningStream = vi.fn();
    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<
        typeof subscribeEmbeddedPiSession
      >[0]["session"],
      runId: "run",
      onReasoningStream,
      onBlockReply,
      blockReplyBreak: "message_end",
      reasoningMode: "stream",
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: `${open}\nBecause`,
      },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: ` it helps\n${close}\n\nFinal answer`,
      },
    });

    const assistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `${open}\nBecause it helps\n${close}\n\nFinal answer`,
        },
      ],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0][0].text).toBe("Final answer");

    const streamTexts = onReasoningStream.mock.calls
      .map((call) => call[0]?.text)
      .filter((value): value is string => typeof value === "string");
    expect(streamTexts.at(-1)).toBe("Reasoning:\n_Because it helps_");

    expect(assistantMessage.content).toEqual([
      { type: "thinking", thinking: "Because it helps" },
      { type: "text", text: "Final answer" },
    ]);
  });
  it.each(
    THINKING_TAG_CASES,
  )("suppresses <%s> blocks across chunk boundaries", ({ open, close }) => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<
        typeof subscribeEmbeddedPiSession
      >[0]["session"],
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
      blockReplyChunking: {
        minChars: 5,
        maxChars: 50,
        breakPreference: "newline",
      },
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: `${open}Reasoning chunk that should not leak`,
      },
    });

    expect(onBlockReply).not.toHaveBeenCalled();

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: `${close}\n\nFinal answer`,
      },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_end" },
    });

    const payloadTexts = onBlockReply.mock.calls
      .map((call) => call[0]?.text)
      .filter((value): value is string => typeof value === "string");
    expect(payloadTexts.length).toBeGreaterThan(0);
    for (const text of payloadTexts) {
      expect(text).not.toContain("Reasoning");
      expect(text).not.toContain(open);
    }
    const combined = payloadTexts.join(" ").replace(/\s+/g, " ").trim();
    expect(combined).toBe("Final answer");
  });
});
