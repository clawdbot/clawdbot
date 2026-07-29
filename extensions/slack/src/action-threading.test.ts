// Slack tests cover action threading plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveSlackAutoThreadId } from "./action-threading.js";

type SlackThreadingToolContext = {
  currentChannelId?: string;
  currentMessagingTarget?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
  sameChannelThreadRequired?: boolean;
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

  it("threads first matching prefixed channel target with bare current channel", () => {
    const hasRepliedRef = { value: false };

    expect(
      resolveSlackAutoThreadId({
        to: "channel:C123",
        toolContext: createToolContext({
          replyToMode: "first",
          hasRepliedRef,
        }),
      }),
    ).toBe("thread-1");
    expect(hasRepliedRef.value).toBe(false);
  });

  it("uses the active thread for matching user targets", () => {
    expect(
      resolveSlackAutoThreadId({
        to: "user:U123",
        toolContext: createToolContext({
          currentChannelId: "slack:U123",
        }),
      }),
    ).toBe("thread-1");
  });

  it("matches either native or routable DM targets", () => {
    const context = createToolContext({
      currentChannelId: "D123",
      currentMessagingTarget: "user:U123",
    });

    expect(resolveSlackAutoThreadId({ to: "user:U123", toolContext: context })).toBe("thread-1");
    expect(resolveSlackAutoThreadId({ to: "U123", toolContext: context })).toBe("thread-1");
    expect(resolveSlackAutoThreadId({ to: "D123", toolContext: context })).toBe("thread-1");
    expect(resolveSlackAutoThreadId({ to: "user:U999", toolContext: context })).toBeUndefined();
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

  it("fails closed for same-channel threaded replies when the thread timestamp is missing", () => {
    expect(() =>
      resolveSlackAutoThreadId({
        to: "C123",
        toolContext: createToolContext({
          currentThreadTs: undefined,
          sameChannelThreadRequired: true,
        }),
      }),
    ).toThrow("Slack thread context is required");
  });
});
