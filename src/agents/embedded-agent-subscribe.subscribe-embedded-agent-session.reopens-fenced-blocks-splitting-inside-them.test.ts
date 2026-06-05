// Fenced block reopen tests cover safe Markdown chunking when code fences are
// too long to fit in one block reply.
import { describe, expect, it, vi } from "vitest";
import {
  createParagraphChunkedBlockReplyHarness,
  emitAssistantTextDeltaAndEnd,
  expectFencedChunks,
} from "./embedded-agent-subscribe.e2e-harness.js";

describe("subscribeEmbeddedAgentSession", () => {
  it("reopens fenced blocks when splitting inside them", () => {
    // Oversized code blocks are split with reopened fences so every emitted
    // chunk remains valid Markdown.
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking: {
        minChars: 10,
        maxChars: 30,
      },
    });

    const text = `\`\`\`txt\n${"a".repeat(80)}\n\`\`\``;
    emitAssistantTextDeltaAndEnd({ emit, text });
    expectFencedChunks(onBlockReply.mock.calls, "```txt");
  });
  it("avoids splitting inside tilde fences", () => {
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking: {
        minChars: 5,
        maxChars: 25,
      },
    });

    const text = "Intro\n\n~~~sh\nline1\nline2\n~~~\n\nOutro";
    emitAssistantTextDeltaAndEnd({ emit, text });

    expect(onBlockReply).toHaveBeenCalledTimes(3);
    expect(onBlockReply.mock.calls.at(1)?.[0].text).toBe("~~~sh\nline1\nline2\n~~~");
  });
});
