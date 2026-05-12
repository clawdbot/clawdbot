// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildChatMarkdown } from "./export.ts";

describe("chat export", () => {
  it("returns null for empty history", () => {
    expect(buildChatMarkdown([], "Bot")).toBeNull();
  });

  it("renders markdown headings and strips assistant thinking tags", () => {
    const markdown = buildChatMarkdown(
      [
        {
          role: "assistant",
          content: "<thinking>scratchpad</thinking>Final answer",
          timestamp: Date.UTC(2026, 2, 11, 12, 0, 0),
        },
      ],
      "Bot",
    );

    expect(markdown).toBe(`# Chat with Bot

## Bot (2026-03-11T12:00:00.000Z)

Final answer
`);
  });
});
