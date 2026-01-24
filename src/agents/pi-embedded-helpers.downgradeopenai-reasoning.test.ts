import { describe, expect, it } from "vitest";
import { downgradeOpenAIReasoningBlocks } from "./pi-embedded-helpers.js";

describe("downgradeOpenAIReasoningBlocks", () => {
  it("downgrades orphaned reasoning signatures to text", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "internal reasoning",
            thinkingSignature: JSON.stringify({ id: "rs_123", type: "reasoning" }),
          },
          { type: "text", text: "answer" },
        ],
      },
    ];

    expect(downgradeOpenAIReasoningBlocks(input as any)).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "internal reasoning" }, { type: "text", text: "answer" }],
      },
    ]);
  });

  it("drops empty thinking blocks with orphaned signatures", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "   ",
            thinkingSignature: JSON.stringify({ id: "rs_abc", type: "reasoning" }),
          },
        ],
      },
      { role: "user", content: "next" },
    ];

    expect(downgradeOpenAIReasoningBlocks(input as any)).toEqual([{ role: "user", content: "next" }]);
  });

  it("keeps non-reasoning thinking signatures", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "t",
            thinkingSignature: "reasoning_content",
          },
        ],
      },
    ];

    expect(downgradeOpenAIReasoningBlocks(input as any)).toEqual(input);
  });
});
