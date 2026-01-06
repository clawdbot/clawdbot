import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

type SessionEventHandler = (evt: unknown) => void;

describe("subscribeEmbeddedPiSession", () => {
  it("filters to <final> and falls back when tags are malformed", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onPartialReply = vi.fn();
    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<
        typeof subscribeEmbeddedPiSession
      >[0]["session"],
      runId: "run",
      enforceFinalTag: true,
      onPartialReply,
      onAgentEvent,
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "<final>Hi there</final>",
      },
    });

    expect(onPartialReply).toHaveBeenCalled();
    const firstPayload = onPartialReply.mock.calls[0][0];
    expect(firstPayload.text).toBe("Hi there");

    onPartialReply.mockReset();

    handler?.({
      type: "message_end",
      message: { role: "assistant" },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "</final>Oops no start",
      },
    });

    const secondPayload = onPartialReply.mock.calls[0][0];
    expect(secondPayload.text).toContain("Oops no start");
  });

  it("does not require <final> when enforcement is off", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onPartialReply = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<
        typeof subscribeEmbeddedPiSession
      >[0]["session"],
      runId: "run",
      onPartialReply,
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Hello world",
      },
    });

    const payload = onPartialReply.mock.calls[0][0];
    expect(payload.text).toBe("Hello world");
  });

  it("emits block replies on message_end", () => {
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
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello block" }],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalled();
    const payload = onBlockReply.mock.calls[0][0];
    expect(payload.text).toBe("Hello block");
  });

  it("emits block replies on text_end and does not duplicate on message_end", () => {
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
      blockReplyBreak: "text_end",
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Hello block",
      },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
      },
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const payload = onBlockReply.mock.calls[0][0];
    expect(payload.text).toBe("Hello block");
    expect(subscription.assistantTexts).toEqual(["Hello block"]);

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello block" }],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);
  });

  it("does not duplicate when message_end flushes and a late text_end arrives", () => {
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
      blockReplyBreak: "text_end",
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Hello block",
      },
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello block" }],
    } as AssistantMessage;

    // Simulate a provider that ends the message without emitting text_end.
    handler?.({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);

    // Some providers can still emit a late text_end; this must not re-emit.
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Hello block",
      },
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);
  });

  it("clears block reply state on message_start", () => {
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
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "OK" },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_end" },
    });
    expect(onBlockReply).toHaveBeenCalledTimes(1);

    // New assistant message with identical output should still emit.
    handler?.({ type: "message_start", message: { role: "assistant" } });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "OK" },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_end" },
    });
    expect(onBlockReply).toHaveBeenCalledTimes(2);
  });

  it("does not emit duplicate block replies when text_end repeats", () => {
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
      blockReplyBreak: "text_end",
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Hello block",
      },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
      },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
      },
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);
  });

  it("does not duplicate assistantTexts when message_end repeats", () => {
    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<
        typeof subscribeEmbeddedPiSession
      >[0]["session"],
      runId: "run",
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: assistantMessage });
    handler?.({ type: "message_end", message: assistantMessage });

    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });

  it("does not append when text_end content is a prefix of deltas", () => {
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
      blockReplyBreak: "text_end",
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Hello world",
      },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Hello",
      },
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });

  it("does not append when text_end content is already contained", () => {
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
      blockReplyBreak: "text_end",
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Hello world",
      },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "world",
      },
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });

  it("appends suffix when text_end content extends deltas", () => {
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
      blockReplyBreak: "text_end",
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Hello",
      },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Hello world",
      },
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });

  it("does not duplicate when text_end repeats full content", () => {
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
      blockReplyBreak: "text_end",
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Good morning!",
      },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Good morning!",
      },
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Good morning!"]);
  });

  it("does not duplicate block chunks when text_end repeats full content", () => {
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
        maxChars: 40,
        breakPreference: "newline",
      },
    });

    const fullText = "First line\nSecond line\nThird line\n";

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: fullText,
      },
    });

    const callsAfterDelta = onBlockReply.mock.calls.length;
    expect(callsAfterDelta).toBeGreaterThan(0);

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: fullText,
      },
    });

    expect(onBlockReply).toHaveBeenCalledTimes(callsAfterDelta);
  });

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
        maxChars: 40,
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
        maxChars: 50,
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

  it("reopens fenced blocks when splitting inside them", () => {
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
        minChars: 10,
        maxChars: 30,
        breakPreference: "paragraph",
      },
    });

    const text = `\`\`\`txt\n${"a".repeat(80)}\n\`\`\``;

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

    expect(onBlockReply.mock.calls.length).toBeGreaterThan(1);
    for (const call of onBlockReply.mock.calls) {
      const chunk = call[0].text as string;
      expect(chunk.startsWith("```txt")).toBe(true);
      const fenceCount = chunk.match(/```/g)?.length ?? 0;
      expect(fenceCount).toBeGreaterThanOrEqual(2);
    }
  });

  it("avoids splitting inside tilde fences", () => {
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
        maxChars: 40,
        breakPreference: "paragraph",
      },
    });

    const text = "Intro\n\n~~~sh\nline1\nline2\n~~~\n\nOutro";

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
    expect(onBlockReply.mock.calls[1][0].text).toBe("~~~sh\nline1\nline2\n~~~");
  });

  it("keeps indented fenced blocks intact", () => {
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
        maxChars: 45,
        breakPreference: "paragraph",
      },
    });

    const text = "Intro\n\n  ```js\n  const x = 1;\n  ```\n\nOutro";

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
    expect(onBlockReply.mock.calls[1][0].text).toBe(
      "  ```js\n  const x = 1;\n  ```",
    );
  });

  it("accepts longer fence markers for close", () => {
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
        minChars: 10,
        maxChars: 50,
        breakPreference: "paragraph",
      },
    });

    const text = "Intro\n\n````md\nline1\nline2\n````\n\nOutro";

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
    expect(onBlockReply.mock.calls[1][0].text).toBe(
      "````md\nline1\nline2\n````",
    );
  });

  it("splits long single-line fenced blocks with reopen/close", () => {
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
        minChars: 10,
        maxChars: 40,
        breakPreference: "paragraph",
      },
    });

    const text = `\`\`\`json\n${"x".repeat(120)}\n\`\`\``;

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

    expect(onBlockReply.mock.calls.length).toBeGreaterThan(1);
    for (const call of onBlockReply.mock.calls) {
      const chunk = call[0].text as string;
      expect(chunk.startsWith("```json")).toBe(true);
      const fenceCount = chunk.match(/```/g)?.length ?? 0;
      expect(fenceCount).toBeGreaterThanOrEqual(2);
    }
  });

  it("waits for auto-compaction retry and clears buffered text", async () => {
    const listeners: SessionEventHandler[] = [];
    const session = {
      subscribe: (listener: SessionEventHandler) => {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index !== -1) listeners.splice(index, 1);
        };
      },
    } as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"];

    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run-1",
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "oops" }],
    } as AssistantMessage;

    for (const listener of listeners) {
      listener({ type: "message_end", message: assistantMessage });
    }

    expect(subscription.assistantTexts.length).toBe(1);

    for (const listener of listeners) {
      listener({
        type: "auto_compaction_end",
        willRetry: true,
      });
    }

    expect(subscription.isCompacting()).toBe(true);
    expect(subscription.assistantTexts.length).toBe(0);

    let resolved = false;
    const waitPromise = subscription.waitForCompactionRetry().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    for (const listener of listeners) {
      listener({ type: "agent_end" });
    }

    await waitPromise;
    expect(resolved).toBe(true);
  });

  it("resolves after compaction ends without retry", async () => {
    const listeners: SessionEventHandler[] = [];
    const session = {
      subscribe: (listener: SessionEventHandler) => {
        listeners.push(listener);
        return () => {};
      },
    } as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"];

    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run-2",
    });

    for (const listener of listeners) {
      listener({ type: "auto_compaction_start" });
    }

    expect(subscription.isCompacting()).toBe(true);

    let resolved = false;
    const waitPromise = subscription.waitForCompactionRetry().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    for (const listener of listeners) {
      listener({ type: "auto_compaction_end", willRetry: false });
    }

    await waitPromise;
    expect(resolved).toBe(true);
    expect(subscription.isCompacting()).toBe(false);
  });

  it("waits for multiple compaction retries before resolving", async () => {
    const listeners: SessionEventHandler[] = [];
    const session = {
      subscribe: (listener: SessionEventHandler) => {
        listeners.push(listener);
        return () => {};
      },
    } as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"];

    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run-3",
    });

    for (const listener of listeners) {
      listener({ type: "auto_compaction_end", willRetry: true });
      listener({ type: "auto_compaction_end", willRetry: true });
    }

    let resolved = false;
    const waitPromise = subscription.waitForCompactionRetry().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    for (const listener of listeners) {
      listener({ type: "agent_end" });
    }

    await Promise.resolve();
    expect(resolved).toBe(false);

    for (const listener of listeners) {
      listener({ type: "agent_end" });
    }

    await waitPromise;
    expect(resolved).toBe(true);
  });

  it("emits tool summaries at tool start when verbose is on", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onToolResult = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<
        typeof subscribeEmbeddedPiSession
      >[0]["session"],
      runId: "run-tool",
      verboseLevel: "on",
      onToolResult,
    });

    handler?.({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-1",
      args: { path: "/tmp/a.txt" },
    });

    expect(onToolResult).toHaveBeenCalledTimes(1);
    const payload = onToolResult.mock.calls[0][0];
    expect(payload.text).toContain("/tmp/a.txt");

    handler?.({
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "tool-1",
      isError: false,
      result: "ok",
    });

    expect(onToolResult).toHaveBeenCalledTimes(1);
  });

  it("skips tool summaries when shouldEmitToolResult is false", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onToolResult = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<
        typeof subscribeEmbeddedPiSession
      >[0]["session"],
      runId: "run-tool-off",
      shouldEmitToolResult: () => false,
      onToolResult,
    });

    handler?.({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-2",
      args: { path: "/tmp/b.txt" },
    });

    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("emits tool summaries when shouldEmitToolResult overrides verbose", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onToolResult = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<
        typeof subscribeEmbeddedPiSession
      >[0]["session"],
      runId: "run-tool-override",
      verboseLevel: "off",
      shouldEmitToolResult: () => true,
      onToolResult,
    });

    handler?.({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-3",
      args: { path: "/tmp/c.txt" },
    });

    expect(onToolResult).toHaveBeenCalledTimes(1);
  });
});
