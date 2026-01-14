import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

describe("subscribeEmbeddedPiSession", () => {
  const _THINKING_TAG_CASES = [
    { tag: "think", open: "<think>", close: "</think>" },
    { tag: "thinking", open: "<thinking>", close: "</thinking>" },
    { tag: "thought", open: "<thought>", close: "</thought>" },
    { tag: "antthinking", open: "<antthinking>", close: "</antthinking>" },
  ] as const;

  it("streams soft chunks with paragraph preference", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();

    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<
        typeof subscribeEmbeddedPiSession
      >[0]["session"],
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
      blockReplyChunking: {
        minChars: 5,
        maxChars: 25,
        breakPreference: "paragraph",
      },
    });

    const text = "First block line\n\nSecond block line";

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: text,
      },
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply.mock.calls[0][0].text).toBe("First block line");
    expect(onBlockReply.mock.calls[1][0].text).toBe("Second block line");
    expect(subscription.assistantTexts).toEqual([
      "First block line",
      "Second block line",
    ]);
  });
  it("avoids splitting inside fenced code blocks", () => {
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
      blockReplyBreak: "message_end",
      blockReplyChunking: {
        minChars: 5,
        maxChars: 25,
        breakPreference: "paragraph",
      },
    });

    const text = "Intro\n\n```bash\nline1\nline2\n```\n\nOutro";

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: text,
      },
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(3);
    expect(onBlockReply.mock.calls[0][0].text).toBe("Intro");
    expect(onBlockReply.mock.calls[1][0].text).toBe(
      "```bash\nline1\nline2\n```",
    );
    expect(onBlockReply.mock.calls[2][0].text).toBe("Outro");
  });
});
