import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageSlackMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMessageSlackMock(...args),
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
        presentation: {
          blocks: [
            {
              type: "text",
              text: "Block body",
            },
          ],
        },
      },
      mediaLocalRoots: ["/tmp/workspace"],
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledTimes(3);
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(1, "C123", "", {
      cfg,
      threadTs: undefined,
      accountId: "default",
      mediaUrl: "https://example.com/1.png",
      mediaAccess: undefined,
      mediaLocalRoots: ["/tmp/workspace"],
      mediaReadFile: undefined,
    });
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(2, "C123", "", {
      cfg,
      threadTs: undefined,
      accountId: "default",
      mediaUrl: "https://example.com/2.png",
      mediaAccess: undefined,
      mediaLocalRoots: ["/tmp/workspace"],
      mediaReadFile: undefined,
    });
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(3, "C123", "final text", {
      cfg,
      threadTs: undefined,
      accountId: "default",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Block body" },
        },
      ],
    });
    expect(result).toEqual({ channel: "slack", messageId: "m-final" });
  });

  it("renders channelData Slack blocks on payload sends", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-blocks" });

    const result = await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      payload: {
        text: "fallback text",
        channelData: {
          slack: {
            blocks: [{ type: "divider" }],
          },
        },
      },
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledWith("C123", "fallback text", {
      cfg,
      threadTs: undefined,
      accountId: "default",
      blocks: [{ type: "divider" }],
    });
    expect(result).toEqual({ channel: "slack", messageId: "m-blocks" });
  });

  it("falls back to threadId when payload replyToId is not a Slack thread timestamp", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-blocks" });

    await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      replyToId: "msg-internal-1",
      threadId: "1712345678.123456",
      payload: {
        text: "fallback text",
        channelData: {
          slack: {
            blocks: [{ type: "divider" }],
          },
        },
      },
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledWith("C123", "fallback text", {
      cfg,
      threadTs: "1712345678.123456",
      accountId: "default",
      blocks: [{ type: "divider" }],
    });
  });

  it("does not thread payloads without a valid Slack thread timestamp", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-blocks" });

    await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      replyToId: "msg-internal-1",
      threadId: "thread-root",
      payload: {
        text: "fallback text",
        channelData: {
          slack: {
            blocks: [{ type: "divider" }],
          },
        },
      },
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledWith("C123", "fallback text", {
      cfg,
      threadTs: undefined,
      accountId: "default",
      blocks: [{ type: "divider" }],
    });
  });
});
