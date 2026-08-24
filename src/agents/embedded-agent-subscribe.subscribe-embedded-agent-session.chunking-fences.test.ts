// Markdown block-reply chunking and fence preservation.
import { describe, expect, it, vi } from "vitest";
import {
  createParagraphChunkedBlockReplyHarness,
  emitAssistantTextDeltaAndEnd,
  expectFencedChunks,
  extractTextPayloads,
} from "./embedded-agent-subscribe.e2e-harness.js";

describe("paragraph and whole-fence chunking", () => {
  const cases = [
    {
      name: "keeps indented fenced blocks intact",
      chunking: { minChars: 5, maxChars: 30 },
      text: "Intro\n\n  ```js\n  const x = 1;\n  ```\n\nOutro",
      expected: ["Intro", "  ```js\n  const x = 1;\n  ```", "Outro"],
    },
    {
      name: "accepts longer fence markers for close",
      chunking: { minChars: 10, maxChars: 30 },
      text: "Intro\n\n````md\nline1\nline2\n````\n\nOutro",
      expected: ["Intro", "````md\nline1\nline2\n````", "Outro"],
    },
    {
      name: "avoids splitting inside tilde fences",
      chunking: { minChars: 5, maxChars: 25 },
      text: "Intro\n\n~~~sh\nline1\nline2\n~~~\n\nOutro",
      expected: ["Intro", "~~~sh\nline1\nline2\n~~~", "Outro"],
    },
    {
      name: "streams soft chunks with paragraph preference",
      chunking: { minChars: 5, maxChars: 25 },
      text: "First block line\n\nSecond block line",
      expected: ["First block line", "Second block line"],
      expectAssistantTexts: true,
    },
    {
      name: "avoids splitting inside fenced code blocks",
      chunking: { minChars: 5, maxChars: 25 },
      text: "Intro\n\n```bash\nline1\nline2\n```\n\nOutro",
      expected: ["Intro", "```bash\nline1\nline2\n```", "Outro"],
    },
  ] as const;

  it.each(cases)("$name", ({ chunking, text, expected, ...testCase }) => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking,
    });
    emitAssistantTextDeltaAndEnd({ emit, text });

    expect(onBlockReply).toHaveBeenCalledTimes(expected.length);
    expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(expected);
    if ("expectAssistantTexts" in testCase) {
      expect(subscription.assistantTexts).toEqual(expected);
    }
  });
});

describe("oversized fenced block chunking", () => {
  const cases = [
    {
      name: "reopens fenced blocks when splitting inside them",
      chunking: { minChars: 10, maxChars: 30 },
      text: `\`\`\`txt\n${"a".repeat(80)}\n\`\`\``,
      prefix: "```txt",
    },
    {
      name: "splits long single-line fenced blocks with reopen/close",
      chunking: { minChars: 10, maxChars: 40 },
      text: `\`\`\`json\n${"x".repeat(120)}\n\`\`\``,
      prefix: "```json",
    },
  ] as const;

  it.each(cases)("$name", async ({ chunking, text, prefix }) => {
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({ onBlockReply, chunking });
    emitAssistantTextDeltaAndEnd({ emit, text });
    await Promise.resolve();
    expectFencedChunks(onBlockReply.mock.calls, prefix);
  });
});
