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

function postedText(message: Record<string, unknown>): string {
  const text = message.text;
  if (text == null) {
    return "";
  }
  if (typeof text !== "string") {
    throw new Error("Expected chat.postMessage text to be a string");
  }
  return text;
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

  it("keeps normal word boundaries for raw mrkdwn without protected tokens", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "alpha beta", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      textIsSlackMrkdwn: true,
      textLimit: 8,
    });

    const postedTexts = client.chat.postMessage.mock.calls.map((call) => String(call[0].text));
    expect(postedTexts).toEqual(["alpha", "beta"]);
  });

  it("keeps native Slack angle tokens atomic across raw mrkdwn chunks", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "abc <@U123>", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      textIsSlackMrkdwn: true,
      textLimit: 8,
    });

    const postedTexts = client.chat.postMessage.mock.calls.map((call) => String(call[0].text));
    expect(postedTexts).toEqual(["abc ", "<@U123>"]);
    expect(postedTexts.join("")).toBe("abc <@U123>");
  });

  it("keeps oversized Slack angle tokens inert inside chunked code", async () => {
    const client = createSlackSendTestClient();
    const message = "`<@U123>`x";

    await sendMessageSlack("channel:C123", message, {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      textIsSlackMrkdwn: true,
      textLimit: 8,
    });

    const postedTexts = client.chat.postMessage.mock.calls.map((call) => String(call[0].text));
    expect(postedTexts.length).toBeGreaterThan(1);
    expect(postedTexts.every((text) => text.length <= 8)).toBe(true);
    expect(postedTexts.every((text) => (text.match(/`/gu)?.length ?? 0) % 2 === 0)).toBe(true);
    expect(postedTexts.every((text) => !text.includes("<@U123>"))).toBe(true);
    expect(postedTexts.join("").replaceAll("`", "")).toBe(message.replaceAll("`", ""));
  });

  it("preserves spaces while fragmenting an oversized Slack link inside code", async () => {
    const client = createSlackSendTestClient();
    const message = "`<https://x|two words>`z";

    await sendMessageSlack("channel:C123", message, {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      textIsSlackMrkdwn: true,
      textLimit: 10,
    });

    const postedTexts = client.chat.postMessage.mock.calls.map((call) => String(call[0].text));
    expect(postedTexts.every((text) => text.length <= 10)).toBe(true);
    expect(postedTexts.every((text) => (text.match(/`/gu)?.length ?? 0) % 2 === 0)).toBe(true);
    expect(postedTexts.every((text) => !text.includes("<https://x|two words>"))).toBe(true);
    expect(postedTexts.join("").replaceAll("`", "")).toBe(message.replaceAll("`", ""));
  });

  it("preserves short unmatched mrkdwn backticks byte-for-byte", async () => {
    const client = createSlackSendTestClient();
    const message = "literal ` marker";

    await sendMessageSlack("channel:C123", message, {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      textIsSlackMrkdwn: true,
      textLimit: 100,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(postedMessage(client).text).toBe(message);
  });

  it("preserves code spans and entities across small mrkdwn chunks", async () => {
    const client = createSlackSendTestClient();
    const message = "- Deny: `/approve req_1 deny &amp; &lt;@U123&gt;`";

    await sendMessageSlack("channel:C123", message, {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      textIsSlackMrkdwn: true,
      textLimit: 5,
    });

    const postedTexts = client.chat.postMessage.mock.calls.map((call) => String(call[0].text));
    expect(postedTexts.length).toBeGreaterThan(1);
    expect(postedTexts.every((text) => text.length <= 5)).toBe(true);
    expect(postedTexts.every((text) => (text.match(/`/gu)?.length ?? 0) % 2 === 0)).toBe(true);
    expect(postedTexts.every((text) => !/&(?:a|am|l|g|gt|lt)?$/u.test(text))).toBe(true);
    expect(postedTexts.every((text) => !/^(?:amp;|lt;|gt;)/u.test(text))).toBe(true);
    expect(postedTexts.join("").replaceAll("`", "")).toBe(message.replaceAll("`", ""));
    expect(postedTexts.join("")).not.toContain("<@U123>");
  });

  it("preserves fenced code markers across raw mrkdwn chunks", async () => {
    const client = createSlackSendTestClient();
    const message = "```sql\nselect \\`name\\` from users;\n```";

    await sendMessageSlack("channel:C123", message, {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      textIsSlackMrkdwn: true,
      textLimit: 12,
    });

    const postedTexts = client.chat.postMessage.mock.calls.map((call) => String(call[0].text));
    expect(postedTexts.length).toBeGreaterThan(1);
    expect(postedTexts.every((text) => text.length <= 12)).toBe(true);
    expect(postedTexts.every((text) => (text.match(/```/gu)?.length ?? 0) % 2 === 0)).toBe(true);
    expect(postedTexts.join("").replaceAll("```", "")).toBe(message.replaceAll("```", ""));
  });

  it("balances fenced code at the smallest wrapped chunk limit", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "```abcd```", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      textIsSlackMrkdwn: true,
      textLimit: 7,
    });

    const postedTexts = client.chat.postMessage.mock.calls.map((call) => String(call[0].text));
    expect(postedTexts).toEqual(["```a```", "```b```", "```c```", "```d```"]);
  });

  it("degrades fenced code to bounded plain text when wrappers cannot fit", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "```abcdefg```", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      textIsSlackMrkdwn: true,
      textLimit: 6,
    });

    const postedTexts = client.chat.postMessage.mock.calls.map((call) => String(call[0].text));
    expect(postedTexts).toEqual(["abcdef", "g"]);
    expect(postedTexts.every((text) => !text.includes("```"))).toBe(true);
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

  it("retries rejected native charts as visible accessible fallback blocks", async () => {
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
    expect(postedMessage(client, 1).blocks).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Revenue mix (pie chart)\n- Product: 60\n- Services: 40",
          verbatim: true,
        },
      },
    ]);
    expect(postedMessage(client, 1).text).toBe(
      "Revenue mix (pie chart)\n- Product: 60\n- Services: 40",
    );
  });

  it("chunks overlong chart fallbacks instead of truncating screen-reader text", async () => {
    const client = createSlackSendTestClient();
    const categories = Array.from({ length: 20 }, (_point, pointIndex) =>
      `Category-${String(pointIndex)}`.padEnd(20, "x"),
    );
    const blocks = [
      {
        type: "data_visualization",
        title: "Large revenue report",
        chart: {
          type: "bar",
          series: Array.from({ length: 12 }, (_series, seriesIndex) => ({
            name: `Series-${String(seriesIndex)}`.padEnd(20, "x"),
            data: categories.map((label) => ({
              label,
              value: Number.MAX_VALUE,
            })),
          })),
          axis_config: { categories },
        },
      },
    ];

    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
    });

    const posts = client.chat.postMessage.mock.calls.map((_call, index) =>
      postedMessage(client, index),
    );
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.every((post) => post.blocks === undefined)).toBe(true);
    expect(
      posts.every((post) => Array.from(postedText(post)).length <= SLACK_TEXT_LIMIT),
    ).toBe(true);
    expect(posts.map(postedText).join("\n")).toContain("Series-11");
  });

  it("chunks overlong chart fallback sent separately from authored text", async () => {
    const client = createSlackSendTestClient();
    const categories = Array.from({ length: 20 }, (_point, pointIndex) =>
      `Category-${String(pointIndex)}`.padEnd(20, "x"),
    );
    const blocks = [
      {
        type: "data_visualization",
        title: "Large revenue report",
        chart: {
          type: "bar",
          series: Array.from({ length: 12 }, (_series, seriesIndex) => ({
            name: `Series-${String(seriesIndex)}`.padEnd(20, "x"),
            data: categories.map((label) => ({ label, value: Number.MAX_VALUE })),
          })),
          axis_config: { categories },
        },
      },
    ];

    await sendMessageSlack("channel:C123", "**Summary**", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
      separateTextAndBlocks: true,
    });

    const posts = client.chat.postMessage.mock.calls.map((_call, index) =>
      postedMessage(client, index),
    );
    expect(posts.length).toBeGreaterThan(2);
    expect(posts[0]).toMatchObject({
      text: "Large revenue report (bar chart)",
      blocks,
    });
    expect(posts.slice(1).every((post) => post.blocks === undefined)).toBe(true);
    expect(
      posts.every((post) => Array.from(postedText(post)).length <= SLACK_TEXT_LIMIT),
    ).toBe(true);
    const fallbackText = posts.slice(1).map(postedText).join("\n");
    expect(fallbackText).toContain("*Summary*");
    expect(fallbackText.match(/Series-11/g)).toHaveLength(1);
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
      "- Account: &lt;@U123&gt;; ARR: $125k",
      "- Account: Globex; ARR: $82k",
    ].join("\n");

    await sendMessageSlack("channel:C123", "Overview", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(postedMessage(client, 0).blocks).toEqual(blocks);
    expect(postedMessage(client, 0).text).toBe(fallback);
    expect(postedMessage(client, 1).blocks).toEqual([
      blocks[0],
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            "Pipeline report (table)",
            "- Account: &lt;@U123&gt;; ARR: $125k",
            "- Account: Globex; ARR: $82k",
          ].join("\n"),
          verbatim: true,
        },
      },
    ]);
    expect(postedMessage(client, 1).text).toBe(fallback);
  });

  it("marks data-derived fallback mrkdwn verbatim", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });

    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks: [
        {
          type: "data_table",
          caption: "Alerts",
          rows: [[{ type: "raw_text", text: "Owner" }], [{ type: "raw_text", text: "@here" }]],
        },
      ] as never,
    });

    expect(postedMessage(client, 1).blocks).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Alerts (table)\n- Owner: @here",
          verbatim: true,
        },
      },
    ]);
  });

  it("chunks overlong table fallbacks while preserving the native table and controls", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const header = "Account".padEnd(80, "x");
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Overview" } },
      {
        type: "data_table",
        caption: "Large pipeline",
        rows: [
          [{ type: "raw_text", text: header }],
          ...Array.from({ length: 100 }, (_entry, index) => [
            {
              type: "raw_text",
              text: index === 0 ? "<@U123>" : `account-${String(index)}`,
            },
          ]),
        ],
      },
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
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Refresh" },
            action_id: "refresh",
            value: "refresh",
          },
        ],
      },
    ] as never;

    const result = await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
      threadTs: "171234.100",
      replyBroadcast: true,
    });

    expect(client.chat.postMessage.mock.calls.length).toBeGreaterThan(2);
    const posts = client.chat.postMessage.mock.calls.map((_call, index) =>
      postedMessage(client, index),
    );
    expect(posts[0]?.blocks).toEqual([blocks[1], blocks[3]]);
    expect(posts[0]?.text).toBe("Large pipeline (table)\n\n- Refresh");
    expect(posts[1]).toMatchObject({ text: "- Refresh", blocks: [blocks[3]] });
    expect(posts.slice(2).every((post) => post.blocks === undefined)).toBe(true);
    expect(
      posts.every((post) => Array.from(postedText(post)).length <= SLACK_TEXT_LIMIT),
    ).toBe(true);
    expect(posts[0]?.reply_broadcast).toBeUndefined();
    expect(posts[2]?.reply_broadcast).toBe(true);
    expect(posts.every((post) => post.thread_ts === "171234.100")).toBe(true);
    expect(result.receipt.parts[0]?.kind).toBe("card");
    expect(result.receipt.parts.slice(1).every((part) => part.kind === "text")).toBe(true);
    expect(result.receipt.parts.map((part) => part.index)).toEqual(
      Array.from({ length: result.receipt.parts.length }, (_entry, index) => index),
    );
    const fallbackText = posts
      .slice(2)
      .map((post) => post.text)
      .join("\n");
    expect(fallbackText).toContain(`- ${header}: &lt;@U123&gt;`);
    expect(fallbackText).toContain(`- ${header}: account-99`);
    expect(fallbackText).toContain("Revenue mix (pie chart)");
    expect(fallbackText.match(/Overview/g)).toHaveLength(1);
    expect(fallbackText.match(/Large pipeline \(table\)/g)).toHaveLength(1);
    expect(fallbackText).not.toContain("<@U123>");
  });

  it("renders rejected native table rows when separate text is unrelated", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const blocks = [
      {
        type: "data_table",
        caption: "Pipeline",
        rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
      },
    ] as never;

    await sendMessageSlack("channel:C123", "Unrelated follow-up", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
      separateTextAndBlocks: true,
      textIsSlackMrkdwn: true,
    });

    const posts = client.chat.postMessage.mock.calls.map((_call, index) =>
      postedMessage(client, index),
    );
    expect(posts).toHaveLength(3);
    expect(posts[0]?.blocks).toEqual(blocks);
    expect(posts[1]).toMatchObject({
      text: "Pipeline (table)\n- Account: Acme",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Pipeline (table)\n- Account: Acme",
            verbatim: true,
          },
        },
      ],
    });
    expect(posts[2]).toMatchObject({ text: "Unrelated follow-up" });
    expect(posts[2]?.blocks).toBeUndefined();
    expect(
      posts.slice(1).filter((post) => JSON.stringify(post).includes("- Account: Acme")),
    ).toHaveLength(1);
  });

  it("chunks overlong separate table fallbacks before native rejection retry", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const authoredMarkdown = "**Important** [Docs](https://example.com)";
    const header = "Account".padEnd(80, "x");
    const blocks = [
      {
        type: "data_table",
        caption: "Pipeline",
        rows: [
          [{ type: "raw_text", text: header }],
          ...Array.from({ length: 100 }, (_entry, index) => [
            { type: "raw_text", text: `account-${String(index)}` },
          ]),
        ],
      },
      {
        type: "data_visualization",
        title: "Revenue",
        chart: {
          type: "pie",
          segments: [
            { label: "A", value: 1 },
            { label: "B", value: 2 },
          ],
        },
      },
    ] as never;

    await sendMessageSlack("channel:C123", authoredMarkdown, {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
      separateTextAndBlocks: true,
    });

    const posts = client.chat.postMessage.mock.calls.map((_call, index) =>
      postedMessage(client, index),
    );
    expect(posts.length).toBeGreaterThan(3);
    const compactFallback = "Pipeline (table)\n\nRevenue (pie chart)";
    expect(posts[0]).toMatchObject({ text: compactFallback, blocks });
    expect(posts[1]).toMatchObject({ text: compactFallback });
    expect(posts[1]?.blocks).toBeUndefined();
    expect(posts.slice(2).every((post) => post.blocks === undefined)).toBe(true);
    expect(
      posts.every((post) => Array.from(postedText(post)).length <= SLACK_TEXT_LIMIT),
    ).toBe(true);
    const fallbackText = posts
      .slice(2)
      .map((post) => post.text)
      .join("\n");
    expect(fallbackText).toContain("*Important* <https://example.com|Docs>");
    expect(fallbackText).not.toContain("**Important**");
    expect(fallbackText).toContain(`- ${header}: account-99`);
    expect(fallbackText.match(/Pipeline \(table\)/g)).toHaveLength(1);
    const deliveredText = posts
      .slice(1)
      .map((post) => post.text)
      .join("\n");
    expect(deliveredText.match(/- A: 1/g)).toHaveLength(1);
    expect(deliveredText.match(/- B: 2/g)).toHaveLength(1);
  });

  it("chunks a long-caption table fallback instead of throwing", async () => {
    const client = createSlackSendTestClient();
    const caption = "c".repeat(8_100);
    const blocks = [
      {
        type: "data_table",
        caption,
        rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Refresh" },
            action_id: "refresh",
            value: "refresh",
          },
        ],
      },
    ] as never;

    await sendMessageSlack("channel:C123", "Summary", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
      textIsSlackMrkdwn: true,
    });

    const posts = client.chat.postMessage.mock.calls.map((_call, index) =>
      postedMessage(client, index),
    );
    expect(posts[0]?.blocks).toEqual([blocks[1]]);
    expect(posts.slice(1).every((post) => post.blocks === undefined)).toBe(true);
    const fallbackText = posts
      .slice(1)
      .map((post) => post.text)
      .join("");
    expect(fallbackText).toContain(`${caption} (table)`);
    expect(fallbackText).toContain("- Account: Acme");
  });

  it("drops an overlong separate table while compacting retained native siblings", async () => {
    const client = createSlackSendTestClient();
    const caption = "c".repeat(8_100);
    const blocks = [
      {
        type: "data_table",
        caption,
        rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
      },
      {
        type: "data_visualization",
        title: "Revenue",
        chart: {
          type: "pie",
          segments: [
            { label: "A", value: 1 },
            { label: "B", value: 2 },
          ],
        },
      },
    ] as never;

    await sendMessageSlack("channel:C123", "Summary", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
      separateTextAndBlocks: true,
    });

    const posts = client.chat.postMessage.mock.calls.map((_call, index) =>
      postedMessage(client, index),
    );
    expect(posts.length).toBeGreaterThan(1);
    expect(posts[0]).toMatchObject({ text: "Revenue (pie chart)", blocks: [blocks[1]] });
    expect(posts.slice(1).every((post) => post.blocks === undefined)).toBe(true);
    expect(
      posts.every((post) => Array.from(postedText(post)).length <= SLACK_TEXT_LIMIT),
    ).toBe(true);
    const fallbackText = posts
      .slice(1)
      .map((post) => post.text)
      .join("");
    expect(fallbackText).toContain("Summary");
    expect(fallbackText).toContain(`${caption} (table)`);
    expect(fallbackText).toContain("- Account: Acme");
    expect(fallbackText.match(/- A: 1/g)).toHaveLength(1);
    expect(fallbackText.match(/- B: 2/g)).toHaveLength(1);
  });

  it("uses the account text limit when deciding whether to retain a native table", async () => {
    const client = createSlackSendTestClient();
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          textChunkLimit: 100,
          accounts: { default: { textChunkLimit: 20 } },
        },
      },
    };
    const blocks = [
      {
        type: "data_table",
        caption: "Quarterly pipeline",
        rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
      },
    ] as never;

    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg,
      client,
      blocks,
    });

    const posts = client.chat.postMessage.mock.calls.map((_call, index) =>
      postedMessage(client, index),
    );
    expect(posts.every((post) => post.blocks === undefined)).toBe(true);
    expect(posts.every((post) => postedText(post).length <= 20)).toBe(true);
    expect(
      posts
        .map((post) => post.text)
        .join("")
        .replace(/\s+/gu, ""),
    ).toContain("Quarterlypipeline(table)-Account:Acme");
  });

  it("uses an explicit text limit for separate native fallback and rejection retry", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const blocks = [
      {
        type: "data_table",
        caption: "Pipeline",
        rows: [
          [{ type: "raw_text", text: "Account" }],
          ...Array.from({ length: 10 }, (_entry, index) => [
            { type: "raw_text", text: `account-${String(index)}` },
          ]),
        ],
      },
    ] as never;

    await sendMessageSlack("channel:C123", "Summary", {
      token: "xoxb-test",
      cfg: { channels: { slack: { botToken: "xoxb-test", textChunkLimit: 100 } } },
      client,
      blocks,
      separateTextAndBlocks: true,
      textLimit: 40,
    });

    const posts = client.chat.postMessage.mock.calls.map((_call, index) =>
      postedMessage(client, index),
    );
    expect(posts[0]).toMatchObject({ text: "Pipeline (table)", blocks });
    expect(posts[1]).toMatchObject({ text: "Pipeline (table)" });
    expect(posts[1]?.blocks).toBeUndefined();
    expect(posts.every((post) => postedText(post).length <= 40)).toBe(true);
    expect(
      posts
        .slice(1)
        .map((post) => post.text)
        .join("\n")
        .match(/- Account: account-9/g),
    ).toHaveLength(1);
  });

  it("does not repeat retained block text in long separate text sends", async () => {
    const client = createSlackSendTestClient();
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Visible summary" } },
    ] as const;
    const authoredText = `start-${"x".repeat(8_100)}-tail`;

    await sendMessageSlack("channel:C123", authoredText, {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks: [...blocks],
      separateTextAndBlocks: true,
      textIsSlackMrkdwn: true,
    });

    const posts = client.chat.postMessage.mock.calls.map((_call, index) =>
      postedMessage(client, index),
    );
    expect(posts[0]?.blocks).toEqual(blocks);
    expect(posts[0]?.text).toBe("Visible summary");
    expect(posts.slice(1).every((post) => post.blocks === undefined)).toBe(true);
    const chunkedText = posts.slice(1).map(postedText).join("\n");
    expect(chunkedText).toContain("start-");
    expect(chunkedText).toContain("-tail");
    expect(chunkedText).not.toContain("Visible summary");
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
    });

    expect(postedMessage(client, 0).text).toBe(
      "Overview\n\nRevenue mix (pie chart)\n- Product: 60\n- Services: 40",
    );
    expect(postedMessage(client, 0).blocks).toEqual(blocks);
  });

  it("includes every raw block and control in successful accessibility text", async () => {
    const client = createSlackSendTestClient();
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Details" } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "approve",
            text: { type: "plain_text", text: "Approve" },
            value: "approve",
          },
        ],
      },
    ];

    await sendMessageSlack("channel:C123", "Summary", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
    });

    expect(postedMessage(client, 0).text).toBe("Summary\n\nDetails\n\n- Approve");
    expect(postedMessage(client, 0).blocks).toEqual(blocks);
  });

  it("chunks overlong raw text blocks without truncating accessibility text", async () => {
    const client = createSlackSendTestClient();
    const blocks = Array.from({ length: 3 }, (_entry, index) => ({
      type: "section",
      text: { type: "mrkdwn", text: `${String(index)}${"x".repeat(2999)}-tail` },
    }));

    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      blocks,
    });

    const posts = client.chat.postMessage.mock.calls.map((_call, index) =>
      postedMessage(client, index),
    );
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.every((post) => post.blocks === undefined)).toBe(true);
    expect(posts.map(postedText).join("\n")).toContain("2xxx");
    expect(posts.map(postedText).join("\n")).toContain("-tail");
  });

  it("replaces rejected native charts while preserving sibling blocks", async () => {
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
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(postedMessage(client, 0).blocks).toEqual(blocks);
    expect(postedMessage(client, 1).blocks).toEqual([
      blocks[0],
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Revenue mix (pie chart)\n- Product: 60\n- Services: 40",
          verbatim: true,
        },
      },
    ]);
    expect(postedMessage(client, 1).text).toBe(
      "Overview\n\nRevenue mix (pie chart)\n- Product: 60\n- Services: 40",
    );
  });

  it("propagates invalid_blocks when a retained sibling is also invalid", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValue({ data: { error: "invalid_blocks" } });

    await expect(
      sendMessageSlack("channel:C123", "Overview", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "Invalid sibling" } },
          {
            type: "data_visualization",
            title: "Revenue mix",
            chart: {
              type: "pie",
              segments: [{ label: "Product", value: 60 }],
            },
          },
        ] as never,
      }),
    ).rejects.toMatchObject({ data: { error: "invalid_blocks" } });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(postedMessage(client, 1).blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Invalid sibling" } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Revenue mix (pie chart)\n- Product: 60",
          verbatim: true,
        },
      },
    ]);
  });

  it("fails closed when native fallback expansion would drop 49 siblings", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const categories = Array.from(
      { length: 20 },
      (_entry, index) => `category-${String(index)}-${"x".repeat(80)}`,
    );

    await expect(
      sendMessageSlack("channel:C123", "", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        blocks: [
          ...Array.from({ length: 49 }, () => ({ type: "divider" })),
          {
            type: "data_visualization",
            title: "Large chart",
            chart: {
              type: "bar",
              axis_config: { categories },
              series: Array.from({ length: 2 }, (_entry, index) => ({
                name: `Series ${String(index)}`,
                data: categories.map((label) => ({ label, value: index })),
              })),
            },
          },
        ] as never,
      }),
    ).rejects.toThrow(/fallback requires .* blocks to retain every sibling/i);
    expect(client.chat.postMessage).toHaveBeenCalledOnce();
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

  it("chunks long block fallback text without truncation", async () => {
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

    const posts = client.chat.postMessage.mock.calls.map((_call, index) =>
      postedMessage(client, index),
    );
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.every((post) => post.blocks === undefined)).toBe(true);
    expect(posts.every((post) => Array.from(String(post.text)).length <= SLACK_TEXT_LIMIT)).toBe(
      true,
    );
    expect(posts.map((post) => String(post.text)).join("")).toContain(longContextText);
    expect(posts.map((post) => String(post.text)).join("")).not.toContain("…");
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
