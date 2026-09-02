import { describe, expect, it } from "vitest";
import { msteamsContextTargetsMatch, resolveMSTeamsAutoThreadId } from "./action-threading.js";

describe("msteamsContextTargetsMatch", () => {
  it("matches conversation: targets against currentChannelId", () => {
    expect(
      msteamsContextTargetsMatch("conversation:19:channel@thread.tacv2", {
        currentChannelId: "conversation:19:channel@thread.tacv2",
      }),
    ).toBe(true);
  });

  it("matches bare conversation id against conversation: currentChannelId", () => {
    expect(
      msteamsContextTargetsMatch("19:channel@thread.tacv2", {
        currentChannelId: "conversation:19:channel@thread.tacv2",
      }),
    ).toBe(true);
  });

  it("matches when one side includes ;messageid=", () => {
    expect(
      msteamsContextTargetsMatch("conversation:19:channel@thread.tacv2;messageid=abc", {
        currentChannelId: "conversation:19:channel@thread.tacv2",
      }),
    ).toBe(true);
  });

  it("rejects a different conversation", () => {
    expect(
      msteamsContextTargetsMatch("conversation:19:other@thread.tacv2", {
        currentChannelId: "conversation:19:channel@thread.tacv2",
      }),
    ).toBe(false);
  });

  it("keeps opaque conversation ids case-sensitive", () => {
    expect(
      msteamsContextTargetsMatch("conversation:19:Channel@thread.tacv2", {
        currentChannelId: "conversation:19:channel@thread.tacv2",
      }),
    ).toBe(false);
  });

  it("matches Graph team/channel messaging targets", () => {
    expect(
      msteamsContextTargetsMatch("team-1/19:channel@thread.tacv2", {
        currentMessagingTarget: "team-1/19:channel@thread.tacv2",
      }),
    ).toBe(true);
  });

  it("matches Graph targets when one side includes ;messageid=", () => {
    expect(
      msteamsContextTargetsMatch("team-1/19:channel@thread.tacv2;messageid=root", {
        currentMessagingTarget: "team-1/19:channel@thread.tacv2",
      }),
    ).toBe(true);
  });

  it("keeps opaque Graph targets case-sensitive", () => {
    expect(
      msteamsContextTargetsMatch("team-1/19:Channel@thread.tacv2", {
        currentMessagingTarget: "team-1/19:channel@thread.tacv2",
      }),
    ).toBe(false);
  });

  it("rejects Graph messaging target against conversation channel id", () => {
    expect(
      msteamsContextTargetsMatch("team-1/19:channel@thread.tacv2", {
        currentChannelId: "conversation:19:channel@thread.tacv2",
      }),
    ).toBe(false);
  });
});

describe("resolveMSTeamsAutoThreadId", () => {
  const sameChannel = {
    currentChannelId: "conversation:19:channel@thread.tacv2",
    currentThreadTs: "thread-root",
    replyToMode: "all" as const,
  };

  it("returns ambient thread root for same conversation", () => {
    expect(
      resolveMSTeamsAutoThreadId({
        to: "conversation:19:channel@thread.tacv2",
        toolContext: sameChannel,
      }),
    ).toBe("thread-root");
  });

  it("returns ambient thread root for bare conversation id target", () => {
    expect(
      resolveMSTeamsAutoThreadId({
        to: "19:channel@thread.tacv2",
        toolContext: sameChannel,
      }),
    ).toBe("thread-root");
  });

  it("returns ambient thread root for matching Graph messaging target", () => {
    expect(
      resolveMSTeamsAutoThreadId({
        to: "team-1/19:channel@thread.tacv2",
        toolContext: {
          currentMessagingTarget: "team-1/19:channel@thread.tacv2",
          currentThreadTs: "thread-root",
          replyToMode: "all",
        },
      }),
    ).toBe("thread-root");
  });

  it("preserves an explicit message id instead of the ambient thread root", () => {
    expect(
      resolveMSTeamsAutoThreadId({
        to: "conversation:19:channel@thread.tacv2;messageid=explicit-root",
        toolContext: sameChannel,
      }),
    ).toBe("explicit-root");
  });

  it("preserves an explicit message id without ambient tool context", () => {
    expect(
      resolveMSTeamsAutoThreadId({
        to: "conversation:19:channel@thread.tacv2;messageid=explicit-root",
      }),
    ).toBe("explicit-root");
  });

  it("preserves an explicit message id outside the ambient conversation", () => {
    expect(
      resolveMSTeamsAutoThreadId({
        to: "conversation:19:other@thread.tacv2;messageid=explicit-root",
        toolContext: sameChannel,
      }),
    ).toBe("explicit-root");
  });

  it("returns undefined for a different conversation", () => {
    expect(
      resolveMSTeamsAutoThreadId({
        to: "conversation:19:other@thread.tacv2",
        toolContext: sameChannel,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when replyToMode is off", () => {
    expect(
      resolveMSTeamsAutoThreadId({
        to: "conversation:19:channel@thread.tacv2",
        toolContext: { ...sameChannel, replyToMode: "off" },
      }),
    ).toBeUndefined();
  });

  it("returns undefined after a single-use reply when already replied", () => {
    expect(
      resolveMSTeamsAutoThreadId({
        to: "conversation:19:channel@thread.tacv2",
        toolContext: {
          ...sameChannel,
          replyToMode: "first",
          hasRepliedRef: { value: true },
        },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when currentThreadTs is missing", () => {
    expect(
      resolveMSTeamsAutoThreadId({
        to: "conversation:19:channel@thread.tacv2",
        toolContext: {
          currentChannelId: "conversation:19:channel@thread.tacv2",
          replyToMode: "all",
        },
      }),
    ).toBeUndefined();
  });
});
