import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendMessageDiscord: vi.fn(async () => ({ messageId: "m1", channelId: "c1" })),
  sendMessageIMessage: vi.fn(async () => ({ messageId: "ok" })),
  sendMessageSignal: vi.fn(async () => ({ messageId: "t1" })),
  sendMessageSlack: vi.fn(async () => ({ messageId: "m1", channelId: "c1" })),
  sendMessageTelegram: vi.fn(async () => ({ messageId: "m1", chatId: "c1" })),
  sendMessageWhatsApp: vi.fn(async () => ({ messageId: "m1", toJid: "jid" })),
}));

vi.mock("../../discord/send.js", () => ({
  sendMessageDiscord: mocks.sendMessageDiscord,
}));
vi.mock("../../imessage/send.js", () => ({
  sendMessageIMessage: mocks.sendMessageIMessage,
}));
vi.mock("../../signal/send.js", () => ({
  sendMessageSignal: mocks.sendMessageSignal,
}));
vi.mock("../../slack/send.js", () => ({
  sendMessageSlack: mocks.sendMessageSlack,
}));
vi.mock("../../telegram/send.js", () => ({
  sendMessageTelegram: mocks.sendMessageTelegram,
}));
vi.mock("../../web/outbound.js", () => ({
  sendMessageWhatsApp: mocks.sendMessageWhatsApp,
}));

const { routeReply } = await import("./route-reply.js");

describe("routeReply", () => {
  it("no-ops on empty payload", async () => {
    mocks.sendMessageSlack.mockClear();
    const res = await routeReply({
      payload: {},
      channel: "slack",
      to: "channel:C123",
      cfg: {} as never,
    });
    expect(res.ok).toBe(true);
    expect(mocks.sendMessageSlack).not.toHaveBeenCalled();
  });

  it("passes thread id to Telegram sends", async () => {
    mocks.sendMessageTelegram.mockClear();
    await routeReply({
      payload: { text: "hi" },
      channel: "telegram",
      to: "telegram:123",
      threadId: 42,
      cfg: {} as never,
    });
    expect(mocks.sendMessageTelegram).toHaveBeenCalledWith(
      "telegram:123",
      "hi",
      expect.objectContaining({ messageThreadId: 42 }),
    );
  });

  it("passes replyToId to Telegram sends", async () => {
    mocks.sendMessageTelegram.mockClear();
    await routeReply({
      payload: { text: "hi", replyToId: "123" },
      channel: "telegram",
      to: "telegram:123",
      cfg: {} as never,
    });
    expect(mocks.sendMessageTelegram).toHaveBeenCalledWith(
      "telegram:123",
      "hi",
      expect.objectContaining({ replyToMessageId: 123 }),
    );
  });

  it("uses replyToId as threadTs for Slack", async () => {
    mocks.sendMessageSlack.mockClear();
    await routeReply({
      payload: { text: "hi", replyToId: "1710000000.0001" },
      channel: "slack",
      to: "channel:C123",
      cfg: {} as never,
    });
    expect(mocks.sendMessageSlack).toHaveBeenCalledWith(
      "channel:C123",
      "hi",
      expect.objectContaining({ threadTs: "1710000000.0001" }),
    );
  });

  it("sends multiple mediaUrls (caption only on first)", async () => {
    mocks.sendMessageSlack.mockClear();
    await routeReply({
      payload: { text: "caption", mediaUrls: ["a", "b"] },
      channel: "slack",
      to: "channel:C123",
      cfg: {} as never,
    });
    expect(mocks.sendMessageSlack).toHaveBeenCalledTimes(2);
    expect(mocks.sendMessageSlack).toHaveBeenNthCalledWith(
      1,
      "channel:C123",
      "caption",
      expect.objectContaining({ mediaUrl: "a" }),
    );
    expect(mocks.sendMessageSlack).toHaveBeenNthCalledWith(
      2,
      "channel:C123",
      "",
      expect.objectContaining({ mediaUrl: "b" }),
    );
  });

  it("routes WhatsApp via outbound sender (accountId honored)", async () => {
    mocks.sendMessageWhatsApp.mockClear();
    await routeReply({
      payload: { text: "hi" },
      channel: "whatsapp",
      to: "+15551234567",
      accountId: "acc-1",
      cfg: {} as never,
    });
    expect(mocks.sendMessageWhatsApp).toHaveBeenCalledWith(
      "+15551234567",
      "hi",
      expect.objectContaining({ accountId: "acc-1", verbose: false }),
    );
  });
});
