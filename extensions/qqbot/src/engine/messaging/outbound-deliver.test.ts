import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayAccount } from "../types.js";

const { sendTextMock, senderSendMediaMock } = vi.hoisted(() => ({
  sendTextMock: vi.fn(),
  senderSendMediaMock: vi.fn(),
}));

vi.mock("./sender.js", () => ({
  accountToCreds: (account: { appId: string; clientSecret: string }) => ({
    appId: account.appId,
    clientSecret: account.clientSecret,
  }),
  buildDeliveryTarget: (target: {
    type: string;
    senderId: string;
    groupOpenid?: string;
    guildId?: string;
    channelId?: string;
  }) => ({
    type: target.type === "group" ? "group" : target.type === "c2c" ? "c2c" : target.type,
    id:
      target.type === "group"
        ? target.groupOpenid
        : target.type === "dm"
          ? target.guildId
          : target.type === "guild"
            ? target.channelId
            : target.senderId,
  }),
  sendMedia: senderSendMediaMock,
  sendText: sendTextMock,
  withTokenRetry: async (_creds: unknown, fn: (token: string) => Promise<unknown>) =>
    await fn("token"),
}));

import { parseAndSendMediaTags, sendPlainReply } from "./outbound-deliver.js";
import { DEFAULT_MEDIA_SEND_ERROR } from "./outbound-types.js";

const account: GatewayAccount = {
  accountId: "qq-main",
  appId: "app",
  clientSecret: "secret",
  markdownSupport: false,
  config: {},
};

const event = {
  type: "c2c" as const,
  senderId: "user-openid",
  messageId: "msg-1",
};

const mediaAccess = {
  localRoots: ["/tmp/agent-workspace"],
  workspaceDir: "/tmp/agent-workspace",
};

function makeLog() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeMediaSender() {
  return {
    sendPhoto: vi.fn(async () => ({ channel: "qqbot", messageId: "image-1" })),
    sendVoice: vi.fn(async () => ({ channel: "qqbot", messageId: "voice-1" })),
    sendVideoMsg: vi.fn(async () => ({ channel: "qqbot", messageId: "video-1" })),
    sendDocument: vi.fn(async () => ({ channel: "qqbot", messageId: "file-1" })),
    sendMedia: vi.fn(
      async (_opts: {
        mediaUrl: string;
      }): Promise<
        { channel: "qqbot"; messageId: string } | { channel: "qqbot"; error: string }
      > => ({ channel: "qqbot", messageId: "media-1" }),
    ),
  };
}

function makeActx() {
  return {
    account,
    qualifiedTarget: "qqbot:c2c:user-openid",
    log: makeLog(),
    mediaAccess,
  };
}

const sendWithRetry = async <T>(sendFn: (token: string) => Promise<T>): Promise<T> =>
  await sendFn("token");

const chunkText = (text: string) => [text];

describe("outbound deliver sandbox media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendTextMock.mockResolvedValue({ id: "text-1", timestamp: 123 });
    senderSendMediaMock.mockResolvedValue({ id: "media-1", timestamp: 123 });
  });

  it("passes scoped media access for qqmedia tags and sends a sanitized fallback on failure", async () => {
    const mediaSender = makeMediaSender();
    mediaSender.sendMedia.mockResolvedValue({ channel: "qqbot", error: "upload failed" });

    const result = await parseAndSendMediaTags(
      "<qqmedia>/workspace/missing-report.pdf</qqmedia>",
      event,
      makeActx(),
      sendWithRetry,
      vi.fn(() => undefined),
      { mediaSender, chunkText },
    );

    expect(result.handled).toBe(true);
    expect(mediaSender.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "/workspace/missing-report.pdf",
        mediaAccess,
      }),
    );
    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([DEFAULT_MEDIA_SEND_ERROR]);
  });

  it("auto-routes relative payload media with scoped media access and a sanitized fallback", async () => {
    const mediaSender = makeMediaSender();
    mediaSender.sendMedia.mockResolvedValue({ channel: "qqbot", error: "upload failed" });

    await sendPlainReply(
      { mediaUrl: "missing-report.pdf" },
      "",
      event,
      makeActx(),
      sendWithRetry,
      vi.fn(() => undefined),
      [],
      { mediaSender, chunkText },
    );

    expect(mediaSender.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "missing-report.pdf",
        mediaAccess,
      }),
    );
    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([DEFAULT_MEDIA_SEND_ERROR]);
  });

  it("continues text chunk delivery after a failed chunk", async () => {
    const actx = makeActx();
    sendTextMock.mockRejectedValueOnce(new Error("first failed"));

    await sendPlainReply(
      {},
      "first second",
      event,
      actx,
      sendWithRetry,
      vi.fn(() => undefined),
      [],
      { mediaSender: makeMediaSender(), chunkText: () => ["first", "second"] },
    );

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual(["first", "second"]);
    expect(actx.log.error).toHaveBeenCalledWith("Send failed: first failed");
  });

  it("continues automatic media delivery after returned and thrown errors", async () => {
    const mediaSender = makeMediaSender();
    mediaSender.sendMedia
      .mockResolvedValueOnce({ channel: "qqbot", error: "rejected" })
      .mockRejectedValueOnce(new Error("network failed"))
      .mockResolvedValueOnce({ channel: "qqbot", messageId: "media-3" });

    await sendPlainReply(
      { mediaUrls: ["first.pdf", "second.pdf", "third.pdf"] },
      "",
      event,
      makeActx(),
      sendWithRetry,
      vi.fn(() => undefined),
      [],
      { mediaSender, chunkText },
    );

    expect(mediaSender.sendMedia.mock.calls.map((call) => call[0].mediaUrl)).toEqual([
      "first.pdf",
      "second.pdf",
      "third.pdf",
    ]);
    expect(sendTextMock).not.toHaveBeenCalled();
  });
});
