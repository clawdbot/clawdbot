import { describe, expect, it } from "vitest";
import {
  attachChannelToResult,
  attachChannelToResults,
  buildChannelSendResult,
  createAttachedChannelResultAdapter,
  createEmptyChannelResult,
  createRawChannelSendResultAdapter,
} from "./channel-send-result.js";

describe("attachChannelToResult(s)", () => {
  it("stamps channel metadata on single and batch results", () => {
    expect(
      attachChannelToResult("discord", {
        messageId: "m1",
        ok: true,
        extra: "value",
      }),
    ).toEqual({
      channel: "discord",
      messageId: "m1",
      ok: true,
      extra: "value",
    });

    expect(
      attachChannelToResults("signal", [
        { messageId: "m1", timestamp: 1 },
        { messageId: "m2", timestamp: 2 },
      ]),
    ).toEqual([
      { channel: "signal", messageId: "m1", timestamp: 1 },
      { channel: "signal", messageId: "m2", timestamp: 2 },
    ]);
  });
});

describe("buildChannelSendResult", () => {
  it("normalizes raw send results directly", () => {
    const result = buildChannelSendResult("zalo", {
      ok: false,
      messageId: null,
      error: "boom",
    });

    expect(result.channel).toBe("zalo");
    expect(result.ok).toBe(false);
    expect(result.messageId).toBe("");
    expect(result.error).toEqual(new Error("boom"));
  });
});

describe("createEmptyChannelResult", () => {
  it("builds an empty outbound result with channel metadata", () => {
    expect(createEmptyChannelResult("line", { chatId: "u1" })).toEqual({
      channel: "line",
      messageId: "",
      chatId: "u1",
    });
  });
});

describe("createAttachedChannelResultAdapter", () => {
  it("wraps outbound delivery and poll results", async () => {
    const adapter = createAttachedChannelResultAdapter({
      channel: "discord",
      sendText: async () => ({ messageId: "m1", channelId: "c1" }),
      sendMedia: async () => ({ messageId: "m2" }),
      sendPoll: async () => ({ messageId: "m3", pollId: "p1" }),
    });

    const sendCases = [
      {
        name: "sendText",
        run: () => adapter.sendText!({ cfg: {} as never, to: "x", text: "hi" }),
        expected: {
          channel: "discord",
          messageId: "m1",
          channelId: "c1",
        },
      },
      {
        name: "sendMedia",
        run: () => adapter.sendMedia!({ cfg: {} as never, to: "x", text: "hi" }),
        expected: {
          channel: "discord",
          messageId: "m2",
        },
      },
      {
        name: "sendPoll",
        run: () =>
          adapter.sendPoll!({
            cfg: {} as never,
            to: "x",
            poll: { question: "t", options: ["a", "b"] },
          }),
        expected: {
          channel: "discord",
          messageId: "m3",
          pollId: "p1",
        },
      },
    ];

    for (const testCase of sendCases) {
      await expect(testCase.run()).resolves.toEqual(testCase.expected);
    }
  });
});

describe("createRawChannelSendResultAdapter", () => {
  it("normalizes raw send results through adapter methods", async () => {
    const adapter = createRawChannelSendResultAdapter({
      channel: "zalo",
      sendText: async () => ({ ok: true, messageId: "m1" }),
      sendMedia: async () => ({ ok: false, error: "boom" }),
    });

    const sendCases = [
      {
        name: "sendText",
        run: () => adapter.sendText!({ cfg: {} as never, to: "x", text: "hi" }),
        expected: {
          channel: "zalo",
          ok: true,
          messageId: "m1",
          error: undefined,
        },
      },
      {
        name: "sendMedia",
        run: () => adapter.sendMedia!({ cfg: {} as never, to: "x", text: "hi" }),
        expected: {
          channel: "zalo",
          ok: false,
          messageId: "",
          error: new Error("boom"),
        },
      },
    ];

    for (const testCase of sendCases) {
      await expect(testCase.run()).resolves.toEqual(testCase.expected);
    }
  });
});
