import { describe, expect, it } from "vitest";
import { resolveSlackAutoThreadId } from "./action-threading.js";

type SlackThreadingToolContext = {
  currentChannelId?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
};

function createToolContext(
  overrides: Partial<SlackThreadingToolContext> = {},
): SlackThreadingToolContext {
  return {
    currentChannelId: "C123",
    currentThreadTs: "thread-1",
    replyToMode: "all",
    ...overrides,
  };
}

describe("resolveSlackAutoThreadId", () => {
  it("uses the active thread only for matching channel targets", () => {
    expect(
      resolveSlackAutoThreadId({
        to: "#c123",
        toolContext: createToolContext(),
      }),
    ).toBe("thread-1");
    expect(
      resolveSlackAutoThreadId({
        to: "channel:C999",
        toolContext: createToolContext(),
      }),
    ).toBeUndefined();
    expect(
      resolveSlackAutoThreadId({
        to: "user:U123",
        toolContext: createToolContext(),
      }),
    ).toBeUndefined();
  });

  it("skips auto-threading when reply mode or thread context blocks it", () => {
    expect(
      resolveSlackAutoThreadId({
        to: "C123",
        toolContext: createToolContext({
          replyToMode: "first",
          hasRepliedRef: { value: true },
        }),
      }),
    ).toBeUndefined();
    expect(
      resolveSlackAutoThreadId({
        to: "C123",
        toolContext: createToolContext({ replyToMode: "off" }),
      }),
    ).toBeUndefined();
    expect(
      resolveSlackAutoThreadId({
        to: "C123",
        toolContext: createToolContext({ currentThreadTs: undefined }),
      }),
    ).toBeUndefined();
  });
});
