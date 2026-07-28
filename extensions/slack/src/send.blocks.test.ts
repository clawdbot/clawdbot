// Slack tests cover send.blocks plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { createSlackSendTestClient } from "./blocks.test-helpers.js";
import {
  clearSlackThreadParticipationCache,
  hasSlackThreadParticipation,
} from "./sent-thread-cache.js";

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

function interleavedNativeDataBlocks(): Array<Record<string, unknown>> {
  return [
    { type: "section", text: { type: "mrkdwn", text: "Before" } },
    {
      type: "data_table",
      caption: "Pipeline report",
      rows: [
        [
          { type: "raw_text", text: "Account" },
          { type: "raw_text", text: "ARR" },
        ],
        [
          { type: "raw_text", text: "Acme" },
          { type: "raw_number", value: 125000, text: "$125k" },
        ],
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: "After" } },
    {
      type: "actions",
      block_id: "private-block",
      elements: [
        {
          type: "button",
          action_id: "private-button",
          text: { type: "plain_text", text: "Approve" },
          value: "private-value",
        },
        {
          type: "static_select",
          action_id: "private-select",
          placeholder: { type: "plain_text", text: "Choose owner" },
          options: [
            { text: { type: "plain_text", text: "Secret option" }, value: "private-option" },
          ],
        },
      ],
    },
  ];
}

const INTERLEAVED_NATIVE_DATA_ACCESSIBILITY = [
  "Outside",
  "Before",
  "Pipeline report (table)\nAccount\tARR\nAcme\t$125k",
  "After",
  "Approve\nChoose owner",
].join("\n\n");

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

    const result = await sendMessageSlack("channel:C123", "hello thread", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      threadTs: "1712345678.123456",
    });

    expect(result.threadTs).toBe("1712345678.123456");
    expect(result.receipt.threadId).toBe("1712345678.123456");
    expect(hasSlackThreadParticipation("default", "C123", "1712345678.123456")).toBe(true);
  });

  it("records canonical Slack response thread participation instead of requested child thread", async () => {
    clearSlackThreadParticipationCache();
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockResolvedValueOnce({
      ts: "1781932190.115869",
      channel: "C123",
      message: {
        ts: "1781932190.115869",
        thread_ts: "1781803536.235489",
      },
    });

    const result = await sendMessageSlack("channel:C123", "hello thread", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      threadTs: "1781932168.648159",
    });

    expect(postedMessage(client).thread_ts).toBe("1781932168.648159");
    expect(result.threadTs).toBe("1781803536.235489");
    expect(result.receipt.threadId).toBe("1781803536.235489");
    expect(hasSlackThreadParticipation("default", "C123", "1781803536.235489")).toBe(true);
    expect(hasSlackThreadParticipation("default", "C123", "1781932168.648159")).toBe(false);
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
  it("preserves boundary whitespace for formatting-disabled fallback text", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "  literal fallback  ", {
      cfg: SLACK_TEST_CFG,
      client,
      textIsSlackPlainText: true,
    });

    expect(postedMessage(client, 0)).toMatchObject({
      text: "  literal fallback  ",
      mrkdwn: false,
    });
  });

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

  it("keeps Slack mrkdwn code spans closed around protected tokens when chunking", async () => {
    const client = createSlackSendTestClient();
    const message = `\`${"a".repeat(SLACK_TEXT_LIMIT - 5)}<@U123>${"b".repeat(20)}\``;

    await sendMessageSlack("channel:C123", message, {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      textIsSlackMrkdwn: true,
    });

    const postedTexts = client.chat.postMessage.mock.calls.map((call) => call[0].text);

    expect(postedTexts.length).toBeGreaterThan(1);
    const mentionChunk = postedTexts.find((text) => text?.includes("<@U123>"));
    expect(mentionChunk).toBeDefined();
    expect(mentionChunk?.startsWith("`")).toBe(true);
    expect(mentionChunk?.endsWith("`")).toBe(true);
    expect(postedTexts.every((text) => (text?.match(/`/gu) ?? []).length % 2 === 0)).toBe(true);
  });

  it("reports the first Slack chunk before a later chunk fails", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage
      .mockResolvedValueOnce({ ts: "m1", channel: "C123" })
      .mockRejectedValueOnce(new Error("second chunk failed"));
    const onDeliveryResult = vi.fn();

    await expect(
      sendMessageSlack("channel:C123", "a".repeat(8500), {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        onDeliveryResult,
      }),
    ).rejects.toThrow("second chunk failed");

    expect(onDeliveryResult.mock.calls.map((call) => call[0]?.messageId)).toEqual(["m1"]);
  });

  it("preserves the first canonical response thread across chunked sends", async () => {
    clearSlackThreadParticipationCache();
    const client = createSlackSendTestClient();
    client.chat.postMessage
      .mockResolvedValueOnce({
        ts: "1781932190.115869",
        channel: "C123",
        message: {
          ts: "1781932190.115869",
          thread_ts: "1781803536.235489",
        },
      })
      .mockResolvedValueOnce({
        ts: "1781932191.000000",
        channel: "C123",
      });
    const message = "a".repeat(8500);

    const result = await sendMessageSlack("channel:C123", message, {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      threadTs: "1781932168.648159",
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(postedMessage(client).thread_ts).toBe("1781932168.648159");
    expect(postedMessage(client, 1).thread_ts).toBe("1781932168.648159");
    expect(result.threadTs).toBe("1781803536.235489");
    expect(result.receipt.threadId).toBe("1781803536.235489");
    expect(hasSlackThreadParticipation("default", "C123", "1781803536.235489")).toBe(true);
    expect(hasSlackThreadParticipation("default", "C123", "1781932168.648159")).toBe(false);
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

  it("includes sibling block text in top-level fallback for raw block sends", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "Summary", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "Details" } },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Approve" },
            },
          ],
        },
      ],
    });

    expect(postedMessage(client)).toMatchObject({
      text: "Summary\n\nDetails\n\nApprove",
    });
  });

  it("keeps interleaved native data and raw controls ordered in accepted accessibility text", async () => {
    const client = createSlackSendTestClient();
    const blocks = interleavedNativeDataBlocks();

    await sendMessageSlack("channel:C123", "Outside", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks: blocks as never,
      nativeDataFallbackBaseText: "Outside",
    });

    expect(client.chat.postMessage).toHaveBeenCalledOnce();
    expect(postedMessage(client)).toMatchObject({
      blocks: blocks as never,
      mrkdwn: false,
      text: INTERLEAVED_NATIVE_DATA_ACCESSIBILITY,
    });
    expect(postedMessage(client).text).not.toMatch(/private|Secret option/u);
  });

  it("keeps interleaved native data and raw controls ordered after invalid_blocks", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const blocks = interleavedNativeDataBlocks();

    await sendMessageSlack("channel:C123", "Outside", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks: blocks as never,
      nativeDataFallbackBaseText: "Outside",
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(postedMessage(client, 0).text).toBe(INTERLEAVED_NATIVE_DATA_ACCESSIBILITY);
    expect(postedMessage(client, 1)).toMatchObject({
      blocks: [
        { type: "section", text: { type: "plain_text", text: "Outside" } },
        blocks[0],
        {
          type: "section",
          text: {
            type: "plain_text",
            text: "Pipeline report (table)\nAccount\tARR\nAcme\t$125k",
          },
        },
        blocks[2],
        blocks[3],
      ],
      mrkdwn: false,
      text: INTERLEAVED_NATIVE_DATA_ACCESSIBILITY,
    });
    for (const index of [0, 1]) {
      expect(postedMessage(client, index).text).not.toMatch(/private|Secret option/u);
    }
  });

  it("retries rejected native charts as accessible text", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce(
      Object.assign(new Error("An API error occurred: invalid_blocks"), {
        data: { error: "invalid_blocks" },
      }),
    );
    const blocks = [
      {
        type: "data_visualization",
        title: "Revenue mix",
        chart: {
          type: "pie",
          segments: [
            { label: "Product", value: 60 },
            { label: "Services", value: 40 },
          ],
        },
      },
    ];

    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(postedMessage(client, 0).blocks).toEqual(blocks);
    expect(postedMessage(client, 0).text).toBe(
      "Revenue mix (pie chart)\n- Product: 60\n- Services: 40",
    );
    expect(postedMessage(client, 1).blocks).toBeUndefined();
    expect(postedMessage(client, 1).text).toBe(
      "Revenue mix (pie chart)\n- Product: 60\n- Services: 40",
    );
    expect(postedMessage(client, 1).mrkdwn).toBe(false);
  });

  it("uses 40k blockless chunks only for oversized native data with no survivors", async () => {
    const client = createSlackSendTestClient();
    const caption = "c".repeat(41_000);
    const blocks = [
      {
        type: "data_table",
        caption,
        rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
      },
    ] as never;

    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    const posts = [postedMessage(client, 0), postedMessage(client, 1)];
    expect(posts.every((post) => post.blocks === undefined)).toBe(true);
    expect(posts.every((post) => post.mrkdwn === false)).toBe(true);
    expect(posts.every((post) => String(post.text).length <= 40_000)).toBe(true);
    expect(posts.map((post) => post.text).join("")).toBe(`${caption} (table)\nAccount\nAcme`);
  });

  it("splits non-native blocks before their accessibility text exceeds 40k", async () => {
    const client = createSlackSendTestClient();
    const blocks = Array.from({ length: 20 }, (_entry, index) => ({
      type: "section",
      text: { type: "plain_text", text: `${String(index)}-${"x".repeat(2_990)}` },
    }));

    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
      authoredTextPlacement: "none",
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    const posts = [postedMessage(client, 0), postedMessage(client, 1)];
    expect(posts.every((post) => String(post.text).length <= 40_000)).toBe(true);
    expect(posts.every((post) => post.mrkdwn === false)).toBe(true);
    expect(posts.flatMap((post) => post.blocks as unknown[])).toEqual(blocks);
  });

  it("keeps ordered non-native accessibility complete above the normal 8k text limit", async () => {
    const client = createSlackSendTestClient();
    const blocks = Array.from({ length: 3 }, (_entry, index) => ({
      type: "section",
      text: { type: "plain_text", text: `${String(index)}-${"x".repeat(2_990)}` },
    }));

    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
      authoredTextPlacement: "none",
    });

    expect(client.chat.postMessage).toHaveBeenCalledOnce();
    expect(String(postedMessage(client, 0).text).length).toBeGreaterThan(8_000);
    expect(postedMessage(client, 0).blocks).toEqual(blocks);
  });

  it("retries rejected native tables once with complete accessible text", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Overview" } },
      {
        type: "data_table",
        caption: "Pipeline report",
        rows: [
          [
            { type: "raw_text", text: "Account" },
            { type: "raw_text", text: "ARR" },
          ],
          [
            { type: "raw_text", text: "<@U123>" },
            { type: "raw_number", value: 125000, text: "$125k" },
          ],
          [
            { type: "raw_text", text: "Globex" },
            { type: "raw_number", value: 82000, text: "$82k" },
          ],
        ],
        row_header_column_index: 0,
      },
    ] as never;
    const fallback = [
      "Overview",
      "",
      "Pipeline report (table)",
      "Account\tARR",
      "<@U123>\t$125k",
      "Globex\t$82k",
    ].join("\n");

    await sendMessageSlack("channel:C123", "Overview", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
      authoredTextPlacement: "blocks",
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(postedMessage(client, 0).blocks).toEqual(blocks);
    expect(postedMessage(client, 0).text).toBe(fallback);
    expect(postedMessage(client, 0).mrkdwn).toBe(false);
    expect(postedMessage(client, 1).blocks).toEqual([
      blocks[0],
      {
        type: "section",
        text: { type: "plain_text", text: fallback.split("\n\n")[1] },
      },
    ]);
    expect(postedMessage(client, 1)).toMatchObject({
      mrkdwn: false,
      text: fallback,
    });
  });

  it("preserves controls, delivery semantics, and complete mixed native-data fallback", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage
      .mockRejectedValueOnce({ data: { error: "invalid_blocks" } })
      .mockResolvedValueOnce({
        ts: "171234.568",
        channel: "C999",
        message: { thread_ts: "171111.100" },
      });
    const onPlatformSendDispatch = vi.fn(async () => undefined);
    const onDeliveryResult = vi.fn(async (_result: { messageId: string }) => undefined);
    const metadata = {
      event_type: "assistant_thread_context",
      event_payload: { team_id: "T123" },
    };
    const section = { type: "section", text: { type: "mrkdwn", text: "Overview" } };
    const actions = {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "approve",
          text: { type: "plain_text", text: "Approve" },
          value: "yes",
        },
      ],
    };
    const blocks = [
      section,
      {
        type: "data_visualization",
        title: "Revenue mix",
        chart: {
          type: "pie",
          segments: [
            { label: "Product", value: 60 },
            { label: "Services", value: 40 },
          ],
        },
      },
      {
        type: "data_table",
        caption: "Pipeline report",
        rows: [
          [
            { type: "raw_text", text: "Account" },
            { type: "raw_text", text: "ARR" },
          ],
          [
            { type: "raw_text", text: "Acme" },
            { type: "raw_number", value: 125000, text: "$125k" },
          ],
        ],
      },
      actions,
    ] as never;

    const result = await sendMessageSlack("channel:C123", "Overview", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
      authoredTextPlacement: "blocks",
      threadTs: "171000.100",
      replyBroadcast: true,
      identity: { username: "Claw", iconEmoji: ":crab:" },
      metadata,
      deliveryQueueId: "queue-1",
      onPlatformSendDispatch,
      onDeliveryResult,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(postedMessage(client, 0).blocks).toEqual(blocks);
    expect(postedMessage(client, 1)).toMatchObject({
      blocks: [
        section,
        {
          type: "section",
          text: {
            type: "plain_text",
            text: "Revenue mix (pie chart)\n- Product: 60\n- Services: 40",
          },
        },
        {
          type: "section",
          text: {
            type: "plain_text",
            text: "Pipeline report (table)\nAccount\tARR\nAcme\t$125k",
          },
        },
        actions,
      ],
      thread_ts: "171000.100",
      reply_broadcast: true,
      username: "Claw",
      icon_emoji: ":crab:",
      metadata: {
        event_type: "assistant_thread_context",
        event_payload: {
          team_id: "T123",
          openclaw_delivery_part_index: 0,
          openclaw_delivery_part_count: 1,
        },
      },
      mrkdwn: false,
    });
    expect(postedMessage(client, 1).text).toContain(
      "Revenue mix (pie chart)\n- Product: 60\n- Services: 40",
    );
    expect(postedMessage(client, 1).text).toContain(
      "Pipeline report (table)\nAccount\tARR\nAcme\t$125k",
    );
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(onDeliveryResult.mock.calls.map((call) => call[0]?.messageId)).toEqual(["171234.568"]);
    expect(result).toMatchObject({
      messageId: "171234.568",
      channelId: "C999",
      threadTs: "171111.100",
    });
    expect(result.receipt.platformMessageIds).toEqual(["171234.568"]);
  });

  it("propagates invalid_blocks when Slack also rejects the retained controls", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage
      .mockRejectedValueOnce({ data: { error: "invalid_blocks" } })
      .mockRejectedValueOnce(
        Object.assign(new Error("An API error occurred: invalid_blocks"), {
          data: { error: "invalid_blocks" },
        }),
      );
    const onPlatformSendDispatch = vi.fn(async () => undefined);
    const onDeliveryResult = vi.fn(async () => undefined);
    const actions = {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "approve",
          text: { type: "plain_text", text: "Approve" },
          value: "yes",
        },
      ],
    };
    const blocks = [
      {
        type: "data_table",
        caption: "Pipeline",
        rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
      },
      actions,
    ] as never;

    await expect(
      sendMessageSlack("channel:C123", "Pipeline", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        blocks,
        onPlatformSendDispatch,
        onDeliveryResult,
      }),
    ).rejects.toThrow("invalid_blocks");

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(postedMessage(client, 1).blocks).toEqual([
      { type: "section", text: { type: "plain_text", text: "Pipeline" } },
      {
        type: "section",
        text: { type: "plain_text", text: "Pipeline (table)\nAccount\nAcme" },
      },
      actions,
    ]);
    expect(postedMessage(client, 1).text).toBe(
      "Pipeline\n\nPipeline (table)\nAccount\nAcme\n\nApprove",
    );
    expect(postedMessage(client, 1).text).not.toContain("yes");
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(onDeliveryResult).not.toHaveBeenCalled();
  });

  it("uses a visible text fallback for a malformed rejected native table", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const onPlatformSendDispatch = vi.fn(async () => undefined);

    const result = await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks: [{ type: "data_table" }] as never,
      onPlatformSendDispatch,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(postedMessage(client, 1).blocks).toBeUndefined();
    expect(postedMessage(client, 1)).toMatchObject({
      text: "Slack could not render this chart or table data.",
      mrkdwn: false,
    });
    expect(result.receipt.platformMessageIds).toEqual(["171234.567"]);
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
  });

  it("posts a valid native table once when its accessibility fallback is overlong", async () => {
    const client = createSlackSendTestClient();
    const header = "Account".padEnd(80, "x");
    const accounts = Array.from({ length: 100 }, (_entry, index) =>
      (index === 0 ? "<@U123>" : `account-${String(index)}`).padEnd(99, "x"),
    );
    const blocks = [
      {
        type: "data_table",
        caption: "Large pipeline",
        rows: [
          [{ type: "raw_text", text: header }],
          ...accounts.map((text) => [{ type: "raw_text", text }]),
        ],
      },
    ] as never;

    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
    });

    expect(client.chat.postMessage).toHaveBeenCalledOnce();
    expect(postedMessage(client).blocks).toEqual(blocks);
    expect(postedMessage(client).text).toBe(
      ["Large pipeline (table)", header, ...accounts].join("\n"),
    );
    expect(String(postedMessage(client).text).length).toBeGreaterThan(SLACK_TEXT_LIMIT);
    expect(String(postedMessage(client).text).length).toBeLessThanOrEqual(40_000);
    expect(postedMessage(client).mrkdwn).toBe(false);
  });

  it("retries an overlong native table once as complete blockless text", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const onPlatformSendDispatch = vi.fn(async () => undefined);
    const header = "Account".padEnd(80, "x");
    const accounts = Array.from({ length: 100 }, (_entry, index) =>
      (index === 0 ? "<@U123>" : `account-${String(index)}`).padEnd(99, "x"),
    );
    const blocks = [
      {
        type: "data_table",
        caption: "Large pipeline",
        rows: [
          [{ type: "raw_text", text: header }],
          ...accounts.map((text) => [{ type: "raw_text", text }]),
        ],
      },
    ] as never;

    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
      onPlatformSendDispatch,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(postedMessage(client, 0).blocks).toEqual(blocks);
    expect(postedMessage(client, 0).text).toBe(
      ["Large pipeline (table)", header, ...accounts].join("\n"),
    );
    expect(postedMessage(client, 0).mrkdwn).toBe(false);
    const fallbackPost = postedMessage(client, 1);
    expect(fallbackPost.blocks).toBeUndefined();
    expect(fallbackPost.mrkdwn).toBe(false);
    expect(String(fallbackPost.text).length).toBeLessThanOrEqual(40_000);
    const deliveredText = fallbackPost.text;
    expect(deliveredText).toBe(["Large pipeline (table)", header, ...accounts].join("\n"));
    expect(deliveredText).toContain("<@U123>");
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
  });

  it("batches more than 50 ordered fallback blocks across Web API posts", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const onPlatformSendDispatch = vi.fn(async () => undefined);
    const caption = "c".repeat(9_000);
    const actions = {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "approve",
          text: { type: "plain_text", text: "Approve" },
          value: "yes",
        },
      ],
    };
    const blocks = [
      ...Array.from({ length: 48 }, () => ({ type: "divider" })),
      actions,
      {
        type: "data_table",
        caption,
        rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
      },
    ] as never;

    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
      onPlatformSendDispatch,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(3);
    expect(postedMessage(client, 0).blocks).toEqual(blocks);
    const fallbackPosts = client.chat.postMessage.mock.calls
      .slice(1)
      .map((_call, index) => postedMessage(client, index + 1));
    expect(fallbackPosts).toHaveLength(2);
    expect(fallbackPosts.every((post) => (post.blocks as unknown[]).length <= 50)).toBe(true);
    const firstFallbackBlocks = fallbackPosts[0]?.blocks as Array<{ type?: string }> | undefined;
    expect(firstFallbackBlocks?.[48]?.type).toBe("actions");
    expect(fallbackPosts.every((post) => post.mrkdwn === false)).toBe(true);
    expect(fallbackPosts.every((post) => String(post.text).length <= 40_000)).toBe(true);
    const fallbackSectionText = fallbackPosts
      .flatMap((post) => post.blocks as Array<{ text?: { type?: string; text?: string } }>)
      .flatMap((block) =>
        block.text?.type === "plain_text" && block.text.text ? [block.text.text] : [],
      )
      .join("");
    expect(fallbackSectionText).toBe(`${caption} (table)\nAccount\nAcme`);
    expect(fallbackPosts.map((post) => post.text).join("\n")).not.toContain("yes");
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
  });

  it("does not fall back from non-invalid_blocks native table errors", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce(
      Object.assign(new Error("An API error occurred: ratelimited"), {
        data: { error: "ratelimited" },
      }),
    );

    await expect(
      sendMessageSlack("channel:C123", "Overview", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        blocks: [
          {
            type: "data_table",
            caption: "Pipeline",
            rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
          },
        ] as never,
      }),
    ).rejects.toThrow("ratelimited");
    expect(client.chat.postMessage).toHaveBeenCalledOnce();
  });

  it("does not retry invalid non-data blocks", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce(
      Object.assign(new Error("An API error occurred: invalid_blocks"), {
        data: { error: "invalid_blocks" },
      }),
    );

    await expect(
      sendMessageSlack("channel:C123", "Overview", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        blocks: [{ type: "divider" }],
      }),
    ).rejects.toThrow("invalid_blocks");

    expect(client.chat.postMessage).toHaveBeenCalledOnce();
  });

  it("includes native chart data in successful mixed-block accessibility text", async () => {
    const client = createSlackSendTestClient();
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Overview" } },
      {
        type: "data_visualization",
        title: "Revenue mix",
        chart: {
          type: "pie",
          segments: [
            { label: "Product", value: 60 },
            { label: "Services", value: 40 },
          ],
        },
      },
    ];

    await sendMessageSlack("channel:C123", "Overview", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
      authoredTextPlacement: "blocks",
    });

    expect(postedMessage(client, 0).text).toBe(
      "Overview\n\nRevenue mix (pie chart)\n- Product: 60\n- Services: 40",
    );
    expect(postedMessage(client, 0).blocks).toEqual(blocks);
  });

  it("preserves non-data siblings and chart data when mixed blocks are rejected", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Overview" } },
      {
        type: "data_visualization",
        title: "Revenue mix",
        chart: {
          type: "pie",
          segments: [
            { label: "Product", value: 60 },
            { label: "Services", value: 40 },
          ],
        },
      },
    ];

    await sendMessageSlack("channel:C123", "Overview", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
      authoredTextPlacement: "blocks",
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(postedMessage(client, 0).blocks).toEqual(blocks);
    expect(postedMessage(client, 1).blocks).toEqual([
      blocks[0],
      {
        type: "section",
        text: {
          type: "plain_text",
          text: "Revenue mix (pie chart)\n- Product: 60\n- Services: 40",
        },
      },
    ]);
    expect(postedMessage(client, 1).text).toBe(
      "Overview\n\nRevenue mix (pie chart)\n- Product: 60\n- Services: 40",
    );
  });

  it("uses canonical Slack response thread for block receipts and participation", async () => {
    clearSlackThreadParticipationCache();
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockResolvedValueOnce({
      ts: "1781932190.115869",
      channel: "C123",
      message: {
        ts: "1781932190.115869",
        thread_ts: "1781803536.235489",
      },
    });

    const result = await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      threadTs: "1781932168.648159",
      blocks: [{ type: "divider" }],
    });

    expect(postedMessage(client).thread_ts).toBe("1781932168.648159");
    expect(result.threadTs).toBe("1781803536.235489");
    expect(result.receipt.threadId).toBe("1781803536.235489");
    expect(result.receipt.parts[0]?.kind).toBe("card");
    expect(hasSlackThreadParticipation("default", "C123", "1781803536.235489")).toBe(true);
    expect(hasSlackThreadParticipation("default", "C123", "1781932168.648159")).toBe(false);
  });

  it("posts user-target block messages directly without conversations.open", async () => {
    const client = createSlackSendTestClient();
    client.conversations.open.mockRejectedValueOnce(new Error("missing_scope"));
    client.chat.postMessage.mockResolvedValueOnce({ ts: "171234.567", channel: "D123" });

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
    expect(result.channelId).toBe("D123");
    expect(result.receipt.platformMessageIds).toEqual(["171234.567"]);
    expect(result.receipt.parts[0]?.raw).toMatchObject({ channelId: "D123" });
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
