import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageSlackMock = vi.hoisted(() => vi.fn());
const hasHooksMock = vi.hoisted(() => vi.fn());
const runMessageSendingMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMessageSlackMock(...args),
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (...args: unknown[]) => hasHooksMock(...args),
    runMessageSending: (...args: unknown[]) => runMessageSendingMock(...args),
  }),
}));

let slackOutbound: typeof import("./outbound-adapter.js").slackOutbound;
({ slackOutbound } = await import("./outbound-adapter.js"));

describe("slackOutbound", () => {
  const cfg = {
    channels: {
      slack: {
        botToken: "xoxb-test",
        appToken: "xapp-test",
      },
    },
  };

  beforeEach(() => {
    sendMessageSlackMock.mockReset();
    hasHooksMock.mockReset();
    runMessageSendingMock.mockReset();
    hasHooksMock.mockReturnValue(false);
  });

  it("sends payload media first, then finalizes with blocks", async () => {
    sendMessageSlackMock
      .mockResolvedValueOnce({ messageId: "m-media-1" })
      .mockResolvedValueOnce({ messageId: "m-media-2" })
      .mockResolvedValueOnce({ messageId: "m-final" });

    const result = await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      payload: {
        text: "final text",
        mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
        channelData: {
          slack: {
            blocks: [
              {
                type: "section",
                text: { type: "plain_text", text: "Block body" },
              },
            ],
          },
        },
      },
      mediaLocalRoots: ["/tmp/workspace"],
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledTimes(3);
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(
      1,
      "C123",
      "",
      expect.objectContaining({
        cfg,
        mediaUrl: "https://example.com/1.png",
        mediaLocalRoots: ["/tmp/workspace"],
      }),
    );
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(
      2,
      "C123",
      "",
      expect.objectContaining({
        cfg,
        mediaUrl: "https://example.com/2.png",
        mediaLocalRoots: ["/tmp/workspace"],
      }),
    );
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(
      3,
      "C123",
      "final text",
      expect.objectContaining({
        cfg,
        blocks: [
          {
            type: "section",
            text: { type: "plain_text", text: "Block body" },
          },
        ],
      }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-final" });
  });

  it("cancels sendMedia when message_sending hooks block it", async () => {
    hasHooksMock.mockReturnValue(true);
    runMessageSendingMock.mockResolvedValue({ cancel: true });

    const result = await slackOutbound.sendMedia!({
      cfg,
      to: "C123",
      text: "caption",
      mediaUrl: "https://example.com/image.png",
      accountId: "default",
      replyToId: "1712000000.000001",
    });

    expect(runMessageSendingMock).toHaveBeenCalledWith(
      {
        to: "C123",
        content: "caption",
        metadata: {
          threadTs: "1712000000.000001",
          channelId: "C123",
          mediaUrl: "https://example.com/image.png",
        },
      },
      { channelId: "slack", accountId: "default" },
    );
    expect(sendMessageSlackMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      channel: "slack",
      messageId: "cancelled-by-hook",
      meta: { cancelled: true },
    });
  });
});
