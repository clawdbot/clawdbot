/**
 * Tests chat stream text merging before gateway events reach clients.
 */
import { describe, expect, it } from "vitest";
import { resolveMergedAssistantText } from "./live-chat-projector.js";

const LIVE_CHAT_BUFFER_CHARS = 500_000;

describe("server chat stream text merge", () => {
  it.each([
    {
      name: "repeated digits",
      chunks: ["1", "1", "1"],
      expected: "111",
    },
    {
      name: "repeated CJK punctuation",
      chunks: ["。", "。", "。"],
      expected: "。。。",
    },
    {
      name: "repeated markdown emphasis tokens",
      chunks: ["**", "**"],
      expected: "****",
    },
    {
      name: "repeated markdown table separators",
      chunks: ["|", "|", "|"],
      expected: "|||",
    },
  ])("appends incremental deltas without collapsing $name", ({ chunks, expected }) => {
    const merged = chunks.reduce(
      (previousText, nextDelta) =>
        resolveMergedAssistantText({
          previousText,
          nextText: nextDelta,
          nextDelta,
        }),
      "",
    );

    expect(merged).toBe(expected);
  });

  it("keeps cumulative snapshots from duplicating already-buffered text", () => {
    expect(
      resolveMergedAssistantText({
        previousText: "Hello",
        nextText: "Hello world",
        nextDelta: " world",
      }),
    ).toBe("Hello world");
  });

  it("keeps non-prefix incremental segments after tool calls", () => {
    expect(
      resolveMergedAssistantText({
        previousText: "Before tool call",
        nextText: "After tool call",
        nextDelta: "\nAfter tool call",
      }),
    ).toBe("Before tool call\nAfter tool call");
  });

  it("replaces prior live text when Codex assistant item switches with empty delta", () => {
    const prior = "coordination draft";
    const replacement = resolveMergedAssistantText({
      previousText: prior,
      nextText: "final answer",
      nextDelta: "",
    });

    expect(replacement).toBe("final answer");
    expect(replacement).not.toContain(prior);
  });

  it("clears the live buffer for an explicit empty replacement", () => {
    expect(
      resolveMergedAssistantText({
        previousText: "Rejected draft",
        nextText: "",
        nextDelta: "",
        replace: true,
      }),
    ).toBe("");
  });

  it("would concatenate superseded text if replacement incorrectly included delta", () => {
    const prior = "coordination draft";
    const buggy = resolveMergedAssistantText({
      previousText: prior,
      nextText: "final ",
      nextDelta: "final ",
    });

    expect(buggy).toBe("coordination draftfinal ");
  });

  it("caps merged live text while preserving the newest assistant output", () => {
    const result = resolveMergedAssistantText({
      previousText: "a".repeat(LIVE_CHAT_BUFFER_CHARS - 2),
      nextText: "",
      nextDelta: "bbbb",
    });

    expect(result).toHaveLength(LIVE_CHAT_BUFFER_CHARS);
    expect(result.endsWith("bbbb")).toBe(true);
  });

  it("does not start the capped tail with the low half of a surrogate pair", () => {
    const safeTail = "y".repeat(LIVE_CHAT_BUFFER_CHARS - 1);
    const result = resolveMergedAssistantText({
      previousText: "",
      nextText: `x🚀${safeTail}`,
      nextDelta: "",
    });

    expect(result).toBe(safeTail);
  });
});
