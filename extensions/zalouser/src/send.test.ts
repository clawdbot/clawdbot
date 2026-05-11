import { beforeEach, describe, expect, it, vi } from "vitest";
import { createZalouserSendReceipt } from "./send-receipt.js";
import {
  sendDeliveredZalouser,
  sendImageZalouser,
  sendLinkZalouser,
  sendMessageZalouser,
  sendReactionZalouser,
  sendSeenZalouser,
  sendTypingZalouser,
} from "./send.js";
import { parseZalouserTextStyles } from "./text-styles.js";
import {
  sendZaloDeliveredEvent,
  sendZaloLink,
  sendZaloReaction,
  sendZaloSeenEvent,
  sendZaloTextMessage,
  sendZaloTypingEvent,
} from "./zalo-js.js";
import { TextStyle } from "./zca-constants.js";

vi.mock("./zalo-js.js", () => ({
  sendZaloTextMessage: vi.fn(),
  sendZaloLink: vi.fn(),
  sendZaloTypingEvent: vi.fn(),
  sendZaloReaction: vi.fn(),
  sendZaloDeliveredEvent: vi.fn(),
  sendZaloSeenEvent: vi.fn(),
}));

const mockSendText = vi.mocked(sendZaloTextMessage);
const mockSendLink = vi.mocked(sendZaloLink);
const mockSendTyping = vi.mocked(sendZaloTypingEvent);
const mockSendReaction = vi.mocked(sendZaloReaction);
const mockSendDelivered = vi.mocked(sendZaloDeliveredEvent);
const mockSendSeen = vi.mocked(sendZaloSeenEvent);

function sendResult(
  messageId: string,
  threadId = "thread",
): {
  ok: true;
  messageId: string;
  receipt: ReturnType<typeof createZalouserSendReceipt>;
} {
  return {
    ok: true,
    messageId,
    receipt: createZalouserSendReceipt({ messageId, threadId, kind: "text" }),
  };
}

function sendFailure(error: string, threadId = "thread") {
  return {
    ok: false,
    error,
    receipt: createZalouserSendReceipt({ threadId, kind: "unknown" }),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectResultFields(result: unknown, fields: Record<string, unknown>) {
  expectRecordFields(requireRecord(result, "send result"), fields);
}

function requireSendTextOptions(callIndex: number): Record<string, unknown> {
  const call = (mockSendText.mock.calls as unknown[][])[callIndex];
  return requireRecord(call?.[2], `send text call ${callIndex + 1} options`);
}

function expectSendTextOptions(callIndex: number, fields: Record<string, unknown>) {
  expectRecordFields(requireSendTextOptions(callIndex), fields);
}

describe("zalouser send helpers", () => {
  beforeEach(() => {
    mockSendText.mockReset();
    mockSendLink.mockReset();
    mockSendTyping.mockReset();
    mockSendReaction.mockReset();
    mockSendDelivered.mockReset();
    mockSendSeen.mockReset();
  });

  it("keeps plain text literal by default", async () => {
    mockSendText.mockResolvedValueOnce(sendResult("mid-1", "thread-1"));

    const result = await sendMessageZalouser("thread-1", "**hello**", {
      profile: "default",
      isGroup: true,
    });

    expect(mockSendText.mock.calls[0]?.[0]).toBe("thread-1");
    expect(mockSendText.mock.calls[0]?.[1]).toBe("**hello**");
    expectSendTextOptions(0, { profile: "default", isGroup: true });
    expectResultFields(result, { ok: true, messageId: "mid-1" });
    expect(result.receipt.primaryPlatformMessageId).toBe("mid-1");
  });

  it("formats markdown text when markdown mode is enabled", async () => {
    mockSendText.mockResolvedValueOnce(sendResult("mid-1b", "thread-1"));

    await sendMessageZalouser("thread-1", "**hello**", {
      profile: "default",
      isGroup: true,
      textMode: "markdown",
    });

    expect(mockSendText.mock.calls[0]?.[0]).toBe("thread-1");
    expect(mockSendText.mock.calls[0]?.[1]).toBe("hello");
    expectSendTextOptions(0, {
      profile: "default",
      isGroup: true,
      textMode: "markdown",
      textStyles: [{ start: 0, len: 5, st: TextStyle.Bold }],
    });
  });

  it("formats image captions in markdown mode", async () => {
    mockSendText.mockResolvedValueOnce(sendResult("mid-2", "thread-2"));

    await sendImageZalouser("thread-2", "https://example.com/a.png", {
      profile: "p2",
      caption: "_cap_",
      isGroup: false,
      textMode: "markdown",
    });

    expect(mockSendText.mock.calls[0]?.[0]).toBe("thread-2");
    expect(mockSendText.mock.calls[0]?.[1]).toBe("cap");
    expectSendTextOptions(0, {
      profile: "p2",
      caption: undefined,
      isGroup: false,
      mediaUrl: "https://example.com/a.png",
      textMode: "markdown",
      textStyles: [{ start: 0, len: 3, st: TextStyle.Italic }],
    });
  });

  it("does not keep the raw markdown caption as a media fallback after formatting", async () => {
    mockSendText.mockResolvedValueOnce(sendResult("mid-2b", "thread-2"));

    await sendImageZalouser("thread-2", "https://example.com/a.png", {
      profile: "p2",
      caption: "```\n```",
      isGroup: false,
      textMode: "markdown",
    });

    expect(mockSendText.mock.calls[0]?.[0]).toBe("thread-2");
    expect(mockSendText.mock.calls[0]?.[1]).toBe("");
    expectSendTextOptions(0, {
      profile: "p2",
      caption: undefined,
      isGroup: false,
      mediaUrl: "https://example.com/a.png",
      textMode: "markdown",
      textStyles: undefined,
    });
  });

  it("rechunks normalized markdown text before sending to avoid transport truncation", async () => {
    const text = "\t".repeat(500) + "a".repeat(1500);
    const formatted = parseZalouserTextStyles(text);
    mockSendText
      .mockResolvedValueOnce(sendResult("mid-2c-1", "thread-2c"))
      .mockResolvedValueOnce(sendResult("mid-2c-2", "thread-2c"));

    const result = await sendMessageZalouser("thread-2c", text, {
      profile: "p2c",
      isGroup: false,
      textMode: "markdown",
    });

    expect(formatted.text.length).toBeGreaterThan(2000);
    expect(mockSendText).toHaveBeenCalledTimes(2);
    expect(mockSendText.mock.calls.map((call) => call[1]).join("")).toBe(formatted.text);
    expect(
      mockSendText.mock.calls
        .map((call, index) => ({ index, length: call[1].length }))
        .filter((call) => call.length > 2000),
    ).toStrictEqual([]);
    expectResultFields(result, { ok: true, messageId: "mid-2c-2" });
  });

  it("preserves text styles when splitting long formatted markdown", async () => {
    const text = `**${"a".repeat(2501)}**`;
    mockSendText
      .mockResolvedValueOnce(sendResult("mid-2d-1", "thread-2d"))
      .mockResolvedValueOnce(sendResult("mid-2d-2", "thread-2d"));

    const result = await sendMessageZalouser("thread-2d", text, {
      profile: "p2d",
      isGroup: false,
      textMode: "markdown",
    });

    expect(mockSendText.mock.calls[0]?.[0]).toBe("thread-2d");
    expect(mockSendText.mock.calls[0]?.[1]).toBe("a".repeat(2000));
    expectSendTextOptions(0, {
      profile: "p2d",
      isGroup: false,
      textMode: "markdown",
      textStyles: [{ start: 0, len: 2000, st: TextStyle.Bold }],
    });
    expect(mockSendText.mock.calls[1]?.[0]).toBe("thread-2d");
    expect(mockSendText.mock.calls[1]?.[1]).toBe("a".repeat(501));
    expectSendTextOptions(1, {
      profile: "p2d",
      isGroup: false,
      textMode: "markdown",
      textStyles: [{ start: 0, len: 501, st: TextStyle.Bold }],
    });
    expectResultFields(result, { ok: true, messageId: "mid-2d-2" });
  });

  it("preserves formatted text and styles when newline chunk mode splits after parsing", async () => {
    const text = `**${"a".repeat(1995)}**\n\nsecond paragraph`;
    const formatted = parseZalouserTextStyles(text);
    mockSendText
      .mockResolvedValueOnce(sendResult("mid-2d-3", "thread-2d-2"))
      .mockResolvedValueOnce(sendResult("mid-2d-4", "thread-2d-2"));

    const result = await sendMessageZalouser("thread-2d-2", text, {
      profile: "p2d-2",
      isGroup: false,
      textMode: "markdown",
      textChunkMode: "newline",
    });

    expect(mockSendText).toHaveBeenCalledTimes(2);
    expect(mockSendText.mock.calls.map((call) => call[1]).join("")).toBe(formatted.text);
    expect(mockSendText.mock.calls[0]?.[0]).toBe("thread-2d-2");
    expect(mockSendText.mock.calls[0]?.[1]).toBe(`${"a".repeat(1995)}\n\n`);
    expectSendTextOptions(0, {
      profile: "p2d-2",
      isGroup: false,
      textMode: "markdown",
      textChunkMode: "newline",
      textStyles: [{ start: 0, len: 1995, st: TextStyle.Bold }],
    });
    expect(mockSendText.mock.calls[1]?.[0]).toBe("thread-2d-2");
    expect(mockSendText.mock.calls[1]?.[1]).toBe("second paragraph");
    expectSendTextOptions(1, {
      profile: "p2d-2",
      isGroup: false,
      textMode: "markdown",
      textChunkMode: "newline",
      textStyles: undefined,
    });
    expectResultFields(result, { ok: true, messageId: "mid-2d-4" });
  });

  it("respects an explicit text chunk limit when splitting formatted markdown", async () => {
    const text = `**${"a".repeat(1501)}**`;
    mockSendText
      .mockResolvedValueOnce(sendResult("mid-2d-5", "thread-2d-3"))
      .mockResolvedValueOnce(sendResult("mid-2d-6", "thread-2d-3"));

    const result = await sendMessageZalouser("thread-2d-3", text, {
      profile: "p2d-3",
      isGroup: false,
      textMode: "markdown",
      textChunkLimit: 1200,
    } as never);

    expect(mockSendText).toHaveBeenCalledTimes(2);
    expect(mockSendText.mock.calls[0]?.[0]).toBe("thread-2d-3");
    expect(mockSendText.mock.calls[0]?.[1]).toBe("a".repeat(1200));
    expectSendTextOptions(0, {
      profile: "p2d-3",
      isGroup: false,
      textMode: "markdown",
      textChunkLimit: 1200,
      textStyles: [{ start: 0, len: 1200, st: TextStyle.Bold }],
    });
    expect(mockSendText.mock.calls[1]?.[0]).toBe("thread-2d-3");
    expect(mockSendText.mock.calls[1]?.[1]).toBe("a".repeat(301));
    expectSendTextOptions(1, {
      profile: "p2d-3",
      isGroup: false,
      textMode: "markdown",
      textChunkLimit: 1200,
      textStyles: [{ start: 0, len: 301, st: TextStyle.Bold }],
    });
    expectResultFields(result, { ok: true, messageId: "mid-2d-6" });
  });

  it("sends overflow markdown captions as follow-up text after the media message", async () => {
    const caption = "\t".repeat(500) + "a".repeat(1500);
    const formatted = parseZalouserTextStyles(caption);
    mockSendText
      .mockResolvedValueOnce(sendResult("mid-2e-1", "thread-2e"))
      .mockResolvedValueOnce(sendResult("mid-2e-2", "thread-2e"));

    const result = await sendImageZalouser("thread-2e", "https://example.com/long.png", {
      profile: "p2e",
      caption,
      isGroup: false,
      textMode: "markdown",
    });

    expect(mockSendText).toHaveBeenCalledTimes(2);
    expect(mockSendText.mock.calls.map((call) => call[1]).join("")).toBe(formatted.text);
    expect(mockSendText.mock.calls[0]?.[0]).toBe("thread-2e");
    expect(typeof mockSendText.mock.calls[0]?.[1]).toBe("string");
    expectSendTextOptions(0, {
      profile: "p2e",
      caption: undefined,
      isGroup: false,
      mediaUrl: "https://example.com/long.png",
      textMode: "markdown",
    });
    expect(mockSendText.mock.calls[1]?.[0]).toBe("thread-2e");
    expect(typeof mockSendText.mock.calls[1]?.[1]).toBe("string");
    expect(requireSendTextOptions(1).mediaUrl).toBeUndefined();
    expectResultFields(result, { ok: true, messageId: "mid-2e-2" });
  });

  it("delegates link helper to JS transport", async () => {
    mockSendLink.mockResolvedValueOnce(sendFailure("boom", "thread-3"));

    const result = await sendLinkZalouser("thread-3", "https://openclaw.ai", {
      profile: "p3",
      isGroup: true,
    });

    expect(mockSendLink).toHaveBeenCalledWith("thread-3", "https://openclaw.ai", {
      profile: "p3",
      isGroup: true,
    });
    expectResultFields(result, { ok: false, error: "boom" });
  });

  it("delegates typing helper to JS transport", async () => {
    await sendTypingZalouser("thread-4", { profile: "p4", isGroup: true });

    expect(mockSendTyping).toHaveBeenCalledWith("thread-4", {
      profile: "p4",
      isGroup: true,
    });
  });

  it("delegates reaction helper to JS transport", async () => {
    mockSendReaction.mockResolvedValueOnce({ ok: true });

    const result = await sendReactionZalouser({
      threadId: "thread-5",
      profile: "p5",
      isGroup: true,
      msgId: "100",
      cliMsgId: "200",
      emoji: "👍",
    });

    expect(mockSendReaction).toHaveBeenCalledWith({
      profile: "p5",
      threadId: "thread-5",
      isGroup: true,
      msgId: "100",
      cliMsgId: "200",
      emoji: "👍",
      remove: undefined,
    });
    expectResultFields(result, { ok: true, error: undefined });
    expect(result.receipt.platformMessageIds).toStrictEqual([]);
  });

  it("delegates delivered+seen helpers to JS transport", async () => {
    mockSendDelivered.mockResolvedValueOnce();
    mockSendSeen.mockResolvedValueOnce();

    const message = {
      msgId: "100",
      cliMsgId: "200",
      uidFrom: "1",
      idTo: "2",
      msgType: "webchat",
      st: 1,
      at: 0,
      cmd: 0,
      ts: "123",
    };

    await sendDeliveredZalouser({ profile: "p6", isGroup: true, message, isSeen: false });
    await sendSeenZalouser({ profile: "p6", isGroup: true, message });

    expect(mockSendDelivered).toHaveBeenCalledWith({
      profile: "p6",
      isGroup: true,
      message,
      isSeen: false,
    });
    expect(mockSendSeen).toHaveBeenCalledWith({
      profile: "p6",
      isGroup: true,
      message,
    });
  });
});
