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

type MockCallSource = { mock: { calls: Array<Array<unknown>> } };

function mockObjectArg(
  source: MockCallSource,
  label: string,
  callIndex = 0,
  argIndex = 0,
): Record<string, unknown> {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected ${label} call ${callIndex} to exist`);
  }
  const value = call[argIndex];
  if (!value || typeof value !== "object") {
    throw new Error(`Expected ${label} call ${callIndex} argument ${argIndex} to be an object`);
  }
  return value as Record<string, unknown>;
}

function postedMessage(client: ReturnType<typeof createSlackSendTestClient>, callIndex = 0) {
  return mockObjectArg(client.chat.postMessage, "chat.postMessage", callIndex);
}

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
    expect(result.receipt.platformMessageIds).toStrictEqual([]);
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
    expect(postedMessage(client).channel).toBe("C123");
    expect(postedMessage(client).text).toBe(message);
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
    expect(
      postedTexts
        .map((text, index) => ({ index, length: typeof text === "string" ? text.length : null }))
        .filter((text) => text.length === null || text.length > 8000),
    ).toStrictEqual([]);
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
    const post = postedMessage(client);
    expect(post.channel).toBe("C123");
    expect(post.text).toBe("Shared a Block Kit message");
    expect(post.blocks).toEqual([{ type: "divider" }]);
    expect(result.messageId).toBe("171234.567");
    expect(result.channelId).toBe("C123");
    expect(result.receipt.primaryPlatformMessageId).toBe("171234.567");
    expect(result.receipt.platformMessageIds).toEqual(["171234.567"]);
    const receiptPart = result.receipt.parts[0];
    expect(receiptPart?.platformMessageId).toBe("171234.567");
    expect(receiptPart?.kind).toBe("card");
    expect((receiptPart?.raw as Record<string, unknown> | undefined)?.channel).toBe("slack");
    expect((receiptPart?.raw as Record<string, unknown> | undefined)?.channelId).toBe("C123");
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
    expect(postedMessage(client).channel).toBe("U123");
    expect(postedMessage(client).text).toBe("Shared a Block Kit message");
    expect(result.messageId).toBe("171234.567");
    expect(result.channelId).toBe("U123");
    expect(result.receipt.platformMessageIds).toEqual(["171234.567"]);
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
    expect(result.messageId).toBe("171234.999");
    expect(result.channelId).toBe("C123");
    expect(result.receipt.parts[0]?.platformMessageId).toBe("171234.999");
    expect(result.receipt.parts[0]?.kind).toBe("text");
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
    expect(postedMessage(client).channel).toBe("D123");
    expect(postedMessage(client).thread_ts).toBe("171234.100");
    expect(result.messageId).toBe("171234.567");
    expect(result.channelId).toBe("D123");
    expect(result.receipt.threadId).toBe("171234.100");
  });

  it("passes reply_broadcast for threaded text sends only on the first chunk", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "a".repeat(8500), {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      threadTs: "171234.100",
      replyBroadcast: true,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(postedMessage(client).thread_ts).toBe("171234.100");
    expect(postedMessage(client).reply_broadcast).toBe(true);
    expect(postedMessage(client, 1)).not.toHaveProperty("reply_broadcast");
  });

  it("does not pass reply_broadcast when no thread is selected", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      replyBroadcast: true,
    });

    expect(postedMessage(client)).not.toHaveProperty("reply_broadcast");
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

    expect(postedMessage(client).text).toBe("Build chart");
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

    expect(postedMessage(client).text).toBe("Release demo");
  });

  it("derives fallback text from file blocks", async () => {
    const client = createSlackSendTestClient();
    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks: [{ type: "file", source: "remote", external_id: "F123" }],
    });

    expect(postedMessage(client).text).toBe("Shared a file");
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

    const post = postedMessage(client);
    expect(String(post.text).endsWith("…")).toBe(true);
    expect(post.blocks).toBe(blocks);
    expect(post.text).toHaveLength(SLACK_TEXT_LIMIT);
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

  it("rejects replyBroadcast combined with mediaUrl", async () => {
    const client = createSlackSendTestClient();
    await expect(
      sendMessageSlack("channel:C123", "hi", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        mediaUrl: "https://example.com/image.png",
        threadTs: "171234.100",
        replyBroadcast: true,
      }),
    ).rejects.toThrow(/replyBroadcast is only supported for text or block thread replies/i);
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
