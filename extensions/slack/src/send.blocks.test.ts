import { describe, expect, it } from "vitest";
import { createSlackSendTestClient, installSlackBlockTestMocks } from "./blocks.test-helpers.js";
import {
  clearSlackThreadParticipationCache,
  hasSlackThreadParticipation,
} from "./sent-thread-cache.js";

installSlackBlockTestMocks();
const { sendMessageSlack } = await import("./send.js");
const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };
const SLACK_TEXT_LIMIT = 8000;

function slackDnsRequestError(): Error {
  return Object.assign(new Error("A request error occurred: getaddrinfo EAI_AGAIN slack.com"), {
    code: "slack_webapi_request_error",
    original: Object.assign(new Error("getaddrinfo EAI_AGAIN slack.com"), {
      code: "EAI_AGAIN",
      syscall: "getaddrinfo",
      hostname: "slack.com",
    }),
  });
}

describe("sendMessageSlack NO_REPLY guard", () => {
  it("suppresses NO_REPLY text before any Slack API call", async () => {
    const client = createSlackSendTestClient();
    const result = await sendMessageSlack("channel:C123", "NO_REPLY", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(result.messageId).toBe("suppressed");
  });

  it("suppresses NO_REPLY with surrounding whitespace", async () => {
    const client = createSlackSendTestClient();
    const result = await sendMessageSlack("channel:C123", "  NO_REPLY  ", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(result.messageId).toBe("suppressed");
  });

  it("does not suppress substantive text containing NO_REPLY", async () => {
    const client = createSlackSendTestClient();
    await sendMessageSlack("channel:C123", "This is not a NO_REPLY situation", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });

    expect(client.chat.postMessage).toHaveBeenCalled();
  });

  it("does not suppress NO_REPLY when blocks are attached", async () => {
    const client = createSlackSendTestClient();
    const result = await sendMessageSlack("channel:C123", "NO_REPLY", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "content" } }],
    });

    expect(client.chat.postMessage).toHaveBeenCalled();
    expect(result.messageId).toBe("171234.567");
  });
});

describe("sendMessageSlack thread participation", () => {
  it("records participation after a successful threaded send", async () => {
    clearSlackThreadParticipationCache();
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "hello thread", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      threadTs: "1712345678.123456",
    });

    expect(hasSlackThreadParticipation("default", "C123", "1712345678.123456")).toBe(true);
  });

  it("does not record participation for unthreaded sends", async () => {
    clearSlackThreadParticipationCache();
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "hello channel", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });

    expect(hasSlackThreadParticipation("default", "C123", "1712345678.123456")).toBe(false);
  });

  it("does not record participation for invalid thread ids", async () => {
    clearSlackThreadParticipationCache();
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "hello invalid thread", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      threadTs: "not-a-slack-thread",
    });

    expect(hasSlackThreadParticipation("default", "C123", "not-a-slack-thread")).toBe(false);
  });
});

describe("sendMessageSlack chunking", () => {
  it("keeps 4205-character text in a single Slack post by default", async () => {
    const client = createSlackSendTestClient();
    const message = "a".repeat(4205);

    await sendMessageSlack("channel:C123", message, {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        text: message,
      }),
    );
  });

  it("splits oversized fallback text through the normal Slack sender", async () => {
    const client = createSlackSendTestClient();
    const message = "a".repeat(8500);

    await sendMessageSlack("channel:C123", message, {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });

    const postedTexts = client.chat.postMessage.mock.calls.map((call) => call[0].text);

    expect(postedTexts).toHaveLength(2);
    expect(postedTexts.every((text) => typeof text === "string" && text.length <= 8000)).toBe(true);
    expect(postedTexts.join("")).toBe(message);
  });
});

describe("sendMessageSlack blocks", () => {
  it("posts blocks with fallback text when message is empty", async () => {
    const client = createSlackSendTestClient();
    const result = await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks: [{ type: "divider" }],
    });

    expect(client.conversations.open).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        text: "Shared a Block Kit message",
        blocks: [{ type: "divider" }],
      }),
    );
    expect(result).toEqual({ messageId: "171234.567", channelId: "C123" });
  });

  it("posts user-target block messages directly without conversations.open", async () => {
    const client = createSlackSendTestClient();
    client.conversations.open.mockRejectedValueOnce(new Error("missing_scope"));

    const result = await sendMessageSlack("user:U123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks: [{ type: "divider" }],
    });

    expect(client.conversations.open).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "U123",
        text: "Shared a Block Kit message",
      }),
    );
    expect(result).toEqual({ messageId: "171234.567", channelId: "U123" });
  });

  it("retries Slack postMessage DNS request errors without enabling broad write retries", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage
      .mockRejectedValueOnce(slackDnsRequestError())
      .mockResolvedValueOnce({ ts: "171234.999" });

    const result = await sendMessageSlack("channel:C123", "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ messageId: "171234.999", channelId: "C123" });
  });

  it("retries Slack conversations.open DNS request errors for threaded DMs", async () => {
    const client = createSlackSendTestClient();
    client.conversations.open
      .mockRejectedValueOnce(slackDnsRequestError())
      .mockResolvedValueOnce({ channel: { id: "D123" } });

    const result = await sendMessageSlack("user:U123", "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      threadTs: "171234.100",
    });

    expect(client.conversations.open).toHaveBeenCalledTimes(2);
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "D123", thread_ts: "171234.100" }),
    );
    expect(result).toEqual({ messageId: "171234.567", channelId: "D123" });
  });

  it("does not retry Slack platform errors", async () => {
    const client = createSlackSendTestClient();
    const platformError = Object.assign(
      new Error("An API error occurred: message_limit_exceeded"),
      {
        data: { ok: false, error: "message_limit_exceeded" },
      },
    );
    client.chat.postMessage.mockRejectedValue(platformError);

    await expect(
      sendMessageSlack("channel:C123", "hello", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
      }),
    ).rejects.toThrow("message_limit_exceeded");

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it("derives fallback text from image blocks", async () => {
    const client = createSlackSendTestClient();
    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks: [{ type: "image", image_url: "https://example.com/a.png", alt_text: "Build chart" }],
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Build chart",
      }),
    );
  });

  it("derives fallback text from video blocks", async () => {
    const client = createSlackSendTestClient();
    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks: [
        {
          type: "video",
          title: { type: "plain_text", text: "Release demo" },
          video_url: "https://example.com/demo.mp4",
          thumbnail_url: "https://example.com/thumb.jpg",
          alt_text: "demo",
        },
      ],
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Release demo",
      }),
    );
  });

  it("derives fallback text from file blocks", async () => {
    const client = createSlackSendTestClient();
    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks: [{ type: "file", source: "remote", external_id: "F123" }],
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Shared a file",
      }),
    );
  });

  it("caps long fallback text while preserving blocks", async () => {
    const client = createSlackSendTestClient();
    const longContextText = "a".repeat(3000);
    const blocks = [
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: longContextText },
          { type: "mrkdwn", text: longContextText },
          { type: "mrkdwn", text: longContextText },
        ],
      },
    ];

    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringMatching(/…$/),
        blocks,
      }),
    );
    expect(client.chat.postMessage.mock.calls[0]?.[0].text).toHaveLength(SLACK_TEXT_LIMIT);
  });

  it("rejects blocks combined with mediaUrl", async () => {
    const client = createSlackSendTestClient();
    await expect(
      sendMessageSlack("channel:C123", "hi", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        mediaUrl: "https://example.com/image.png",
        blocks: [{ type: "divider" }],
      }),
    ).rejects.toThrow(/does not support blocks with mediaUrl/i);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("rejects empty blocks arrays from runtime callers", async () => {
    const client = createSlackSendTestClient();
    await expect(
      sendMessageSlack("channel:C123", "hi", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        blocks: [],
      }),
    ).rejects.toThrow(/must contain at least one block/i);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("rejects blocks arrays above Slack max count", async () => {
    const client = createSlackSendTestClient();
    const blocks = Array.from({ length: 51 }, () => ({ type: "divider" }));
    await expect(
      sendMessageSlack("channel:C123", "hi", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        blocks,
      }),
    ).rejects.toThrow(/cannot exceed 50 items/i);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("rejects blocks missing type from runtime callers", async () => {
    const client = createSlackSendTestClient();
    await expect(
      sendMessageSlack("channel:C123", "hi", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        blocks: [{} as { type: string }],
      }),
    ).rejects.toThrow(/non-empty string type/i);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
});
