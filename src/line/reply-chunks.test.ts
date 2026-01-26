import { describe, expect, it, vi } from "vitest";
import { sendLineReplyChunks } from "./reply-chunks.js";

describe("sendLineReplyChunks", () => {
  it("uses reply token for all chunks when possible", async () => {
    const replyMessageLine = vi.fn(async () => ({}));
    const pushMessageLine = vi.fn(async () => ({}));
    const pushTextMessageWithQuickReplies = vi.fn(async () => ({}));
    const createTextMessageWithQuickReplies = vi.fn((text: string, _quickReplies: string[]) => ({
      type: "text" as const,
      text,
    }));

    const result = await sendLineReplyChunks({
      to: "line:group:1",
      chunks: ["one", "two", "three"],
      quickReplies: ["A", "B"],
      replyToken: "token",
      replyTokenUsed: false,
      accountId: "default",
      replyMessageLine,
      pushMessageLine,
      pushTextMessageWithQuickReplies,
      createTextMessageWithQuickReplies,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(replyMessageLine).toHaveBeenCalledTimes(1);
    expect(createTextMessageWithQuickReplies).toHaveBeenCalledWith("three", ["A", "B"]);
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
        { type: "text", text: "three" },
      ],
      { accountId: "default" },
    );
    expect(pushMessageLine).not.toHaveBeenCalled();
    expect(pushTextMessageWithQuickReplies).not.toHaveBeenCalled();
  });

  it("attaches quick replies to a single reply chunk", async () => {
    const replyMessageLine = vi.fn(async () => ({}));
    const pushMessageLine = vi.fn(async () => ({}));
    const pushTextMessageWithQuickReplies = vi.fn(async () => ({}));
    const createTextMessageWithQuickReplies = vi.fn((text: string, _quickReplies: string[]) => ({
      type: "text" as const,
      text,
      quickReply: { items: [] },
    }));

    const result = await sendLineReplyChunks({
      to: "line:user:1",
      chunks: ["only"],
      quickReplies: ["A"],
      replyToken: "token",
      replyTokenUsed: false,
      replyMessageLine,
      pushMessageLine,
      pushTextMessageWithQuickReplies,
      createTextMessageWithQuickReplies,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(createTextMessageWithQuickReplies).toHaveBeenCalledWith("only", ["A"]);
    expect(replyMessageLine).toHaveBeenCalledTimes(1);
    expect(pushMessageLine).not.toHaveBeenCalled();
    expect(pushTextMessageWithQuickReplies).not.toHaveBeenCalled();
  });

  it("replies with up to five chunks before pushing the rest", async () => {
    const replyMessageLine = vi.fn(async () => ({}));
    const pushMessageLine = vi.fn(async () => ({}));
    const pushTextMessageWithQuickReplies = vi.fn(async () => ({}));
    const createTextMessageWithQuickReplies = vi.fn((text: string, _quickReplies: string[]) => ({
      type: "text" as const,
      text,
    }));

    const chunks = ["1", "2", "3", "4", "5", "6", "7"];
    const result = await sendLineReplyChunks({
      to: "line:group:1",
      chunks,
      quickReplies: ["A"],
      replyToken: "token",
      replyTokenUsed: false,
      replyMessageLine,
      pushMessageLine,
      pushTextMessageWithQuickReplies,
      createTextMessageWithQuickReplies,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(replyMessageLine).toHaveBeenCalledTimes(1);
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [
        { type: "text", text: "1" },
        { type: "text", text: "2" },
        { type: "text", text: "3" },
        { type: "text", text: "4" },
        { type: "text", text: "5" },
      ],
      { accountId: undefined },
    );
    expect(pushMessageLine).toHaveBeenCalledTimes(1);
    expect(pushMessageLine).toHaveBeenCalledWith("line:group:1", "6", { accountId: undefined });
    expect(pushTextMessageWithQuickReplies).toHaveBeenCalledTimes(1);
    expect(pushTextMessageWithQuickReplies).toHaveBeenCalledWith("line:group:1", "7", ["A"], {
      accountId: undefined,
    });
    expect(createTextMessageWithQuickReplies).not.toHaveBeenCalled();
  });
});
