// Fenced block chunking tests ensure indented and longer Markdown fences remain
// intact when paragraph block replies are split.
import { describe, expect, it, vi } from "vitest";
import {
  createParagraphChunkedBlockReplyHarness,
  emitAssistantTextDeltaAndEnd,
  extractTextPayloads,
} from "./embedded-agent-subscribe.e2e-harness.js";

describe("subscribeEmbeddedAgentSession", () => {
  it("keeps indented fenced blocks intact", () => {
    // Indented fences are still code blocks for block-reply chunking and should
    // not be split into malformed fragments.
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking: {
        minChars: 5,
        maxChars: 30,
      },
    });

    const text = "Intro\n\n  ```js\n  const x = 1;\n  ```\n\nOutro";

    emitAssistantTextDeltaAndEnd({ emit, text });

    expect(onBlockReply).toHaveBeenCalledTimes(3);
    expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual([
      "Intro",
      "  ```js\n  const x = 1;\n  ```",
      "Outro",
    ]);
  });
  it("accepts longer fence markers for close", () => {
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking: {
        minChars: 10,
        maxChars: 30,
      },
    });

    const text = "Intro\n\n````md\nline1\nline2\n````\n\nOutro";

    emitAssistantTextDeltaAndEnd({ emit, text });

    const payloadTexts = extractTextPayloads(onBlockReply.mock.calls);
    expect(payloadTexts).toEqual(["Intro", "````md\nline1\nline2\n````", "Outro"]);
  });
});
