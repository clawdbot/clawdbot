import { describe, expect, it, vi } from "vitest";
import {
  createParagraphChunkedBlockReplyHarness,
  emitAssistantTextDeltaAndEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";

function blockReplyTexts(onBlockReply: ReturnType<typeof vi.fn>): string[] {
  return onBlockReply.mock.calls.map(([payload]) => (payload as { text?: string }).text ?? "");
}

describe("subscribeEmbeddedPiSession", () => {
  it("streams soft chunks with paragraph preference", () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking: {
        minChars: 5,
        maxChars: 25,
      },
    });

    const text = "First block line\n\nSecond block line";

    emitAssistantTextDeltaAndEnd({ emit, text });

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(blockReplyTexts(onBlockReply)).toEqual(["First block line", "Second block line"]);
    expect(subscription.assistantTexts).toEqual(["First block line", "Second block line"]);
  });
  it("avoids splitting inside fenced code blocks", () => {
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking: {
        minChars: 5,
        maxChars: 25,
      },
    });

    const text = "Intro\n\n```bash\nline1\nline2\n```\n\nOutro";

    emitAssistantTextDeltaAndEnd({ emit, text });

    expect(onBlockReply).toHaveBeenCalledTimes(3);
    expect(blockReplyTexts(onBlockReply)).toEqual(["Intro", "```bash\nline1\nline2\n```", "Outro"]);
  });
});
