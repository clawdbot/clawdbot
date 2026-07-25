// Slack tests cover actions.blocks plugin behavior.
import { describe, expect, it } from "vitest";
import { createSlackEditTestClient, createSlackSendTestClient } from "./blocks.test-helpers.js";

const { editSlackMessage, sendSlackMessage } = await import("./actions.js");
const SLACK_TEXT_LIMIT = 8000;
const SLACK_EDIT_TEXT_LIMIT = 4000;

function readFirstChatUpdatePayload(client: ReturnType<typeof createSlackEditTestClient>): {
  text?: string;
} {
  const [call] = client.chat.update.mock.calls;
  if (!call) {
    throw new Error("expected Slack chat.update call");
  }
  const [payload] = call;
  if (!payload || typeof payload !== "object") {
    throw new Error("expected Slack chat.update payload");
  }
  return payload as { text?: string };
}

describe("sendSlackMessage blocks", () => {
  it("uses the original action text once when a native table is rejected", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const blocks = [
      {
        type: "data_table",
        caption: "Pipeline",
        rows: [
          [
            { type: "raw_text", text: "Account" },
            { type: "raw_text", text: "ARR" },
          ],
          [
            { type: "raw_text", text: "Acme" },
            { type: "raw_number", value: 125000, text: "125000" },
          ],
        ],
      },
    ] as never;

    await sendSlackMessage(
      "channel:C123",
      "Pipeline summary\n\nPipeline (table)\n- Account: Acme; ARR: 125000",
      {
        cfg: { channels: { slack: { botToken: "xoxb-test" } } },
        token: "xoxb-test",
        client,
        blocks,
        nativeDataFallbackBaseText: "Pipeline summary",
      },
    );

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    const fallback = client.chat.postMessage.mock.calls[1]?.[0] as
      | { blocks?: unknown; mrkdwn?: boolean; text?: string }
      | undefined;
    expect(fallback).toMatchObject({
      mrkdwn: false,
      text: "Pipeline summary\n\nPipeline (table)\nAccount\tARR\nAcme\t125000",
    });
    expect(fallback?.blocks).toBeUndefined();
    expect(fallback?.text?.match(/Acme/gu)).toHaveLength(1);
  });
});

describe("editSlackMessage blocks", () => {
  it("preserves long plain-text edits", async () => {
    const client = createSlackEditTestClient();
    const text = "a".repeat(SLACK_TEXT_LIMIT + 500);

    await editSlackMessage("C123", "171234.567", text, {
      token: "xoxb-test",
      client,
    });

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "171234.567",
      text,
    });
  });

  it("preserves the empty-edit sentinel without blocks", async () => {
    const client = createSlackEditTestClient();

    await editSlackMessage("C123", "171234.567", "", {
      token: "xoxb-test",
      client,
    });

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "171234.567",
      text: " ",
    });
  });

  it("updates with valid blocks", async () => {
    const client = createSlackEditTestClient();

    await editSlackMessage("C123", "171234.567", "", {
      token: "xoxb-test",
      client,
      blocks: [{ type: "divider" }],
    });

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "171234.567",
      text: "Shared a Block Kit message",
      blocks: [{ type: "divider" }],
    });
  });

  it("uses image block text as edit fallback", async () => {
    const client = createSlackEditTestClient();

    await editSlackMessage("C123", "171234.567", "", {
      token: "xoxb-test",
      client,
      blocks: [{ type: "image", image_url: "https://example.com/a.png", alt_text: "Chart" }],
    });

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "171234.567",
      text: "Chart",
      blocks: [{ type: "image", image_url: "https://example.com/a.png", alt_text: "Chart" }],
    });
  });

  it("uses video block title as edit fallback", async () => {
    const client = createSlackEditTestClient();

    await editSlackMessage("C123", "171234.567", "", {
      token: "xoxb-test",
      client,
      blocks: [
        {
          type: "video",
          title: { type: "plain_text", text: "Walkthrough" },
          video_url: "https://example.com/demo.mp4",
          thumbnail_url: "https://example.com/thumb.jpg",
          alt_text: "demo",
        },
      ],
    });

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "171234.567",
      text: "Walkthrough",
      blocks: [
        {
          type: "video",
          title: { type: "plain_text", text: "Walkthrough" },
          video_url: "https://example.com/demo.mp4",
          thumbnail_url: "https://example.com/thumb.jpg",
          alt_text: "demo",
        },
      ],
    });
  });

  it("uses generic file fallback text for file blocks", async () => {
    const client = createSlackEditTestClient();

    await editSlackMessage("C123", "171234.567", "", {
      token: "xoxb-test",
      client,
      blocks: [{ type: "file", source: "remote", external_id: "F123" }],
    });

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "171234.567",
      text: "Shared a file",
      blocks: [{ type: "file", source: "remote", external_id: "F123" }],
    });
  });

  it("retries rejected native charts with text fallback and surviving blocks", async () => {
    const client = createSlackEditTestClient();
    client.chat.update.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
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

    await editSlackMessage("C123", "171234.567", "Overview", {
      token: "xoxb-test",
      client,
      blocks,
    });

    expect(client.chat.update).toHaveBeenCalledTimes(2);
    expect(client.chat.update).toHaveBeenNthCalledWith(1, {
      channel: "C123",
      ts: "171234.567",
      text: "Overview\n\nRevenue mix (pie chart)\n- Product: 60\n- Services: 40",
      blocks,
    });
    expect(client.chat.update).toHaveBeenNthCalledWith(2, {
      channel: "C123",
      ts: "171234.567",
      text: "Overview\n\nRevenue mix (pie chart)\n- Product: 60\n- Services: 40",
      blocks: [
        blocks[0],
        {
          type: "section",
          text: {
            type: "plain_text",
            text: "Revenue mix (pie chart)\n- Product: 60\n- Services: 40",
          },
        },
      ],
    });
  });

  it("retries rejected native tables once with complete text and surviving blocks", async () => {
    const client = createSlackEditTestClient();
    client.chat.update.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
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
            { type: "raw_text", text: "Acme" },
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
    const firstAttemptFallback = [
      "Overview",
      "",
      "Pipeline report (table)",
      "- Account: Acme; ARR: $125k",
      "- Account: Globex; ARR: $82k",
    ].join("\n");
    const retryFallback =
      "Overview\n\nPipeline report (table)\nAccount\tARR\nAcme\t$125k\nGlobex\t$82k";

    await editSlackMessage("C123", "171234.567", "Overview", {
      token: "xoxb-test",
      client,
      blocks,
    });

    expect(client.chat.update).toHaveBeenCalledTimes(2);
    expect(client.chat.update).toHaveBeenNthCalledWith(1, {
      channel: "C123",
      ts: "171234.567",
      text: firstAttemptFallback,
      blocks,
    });
    expect(client.chat.update).toHaveBeenNthCalledWith(2, {
      channel: "C123",
      ts: "171234.567",
      text: retryFallback,
      blocks: [
        blocks[0],
        {
          type: "section",
          text: {
            type: "plain_text",
            text: "Pipeline report (table)\nAccount\tARR\nAcme\t$125k\nGlobex\t$82k",
          },
        },
      ],
    });
  });

  it("rejects table edits whose complete fallback cannot fit one message", async () => {
    const client = createSlackEditTestClient();
    const header = "Account".padEnd(80, "x");
    const blocks = [
      {
        type: "data_table",
        caption: "Large pipeline",
        rows: [
          [{ type: "raw_text", text: header }],
          ...Array.from({ length: 100 }, (_entry, index) => [
            { type: "raw_text", text: `account-${String(index)}` },
          ]),
        ],
      },
    ] as never;

    await expect(
      editSlackMessage("C123", "171234.567", "", {
        token: "xoxb-test",
        client,
        blocks,
      }),
    ).rejects.toThrow("Slack native chart or table fallback exceeds the 4000-character edit limit");
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("rejects native chart edits whose complete fallback cannot fit one message", async () => {
    const client = createSlackEditTestClient();
    const categories = Array.from({ length: 20 }, (_entry, index) =>
      `Category-${String(index)}`.padEnd(20, "x"),
    );
    const blocks = [
      {
        type: "data_visualization",
        title: "Maximum series chart",
        chart: {
          type: "bar",
          series: Array.from({ length: 12 }, (_entry, seriesIndex) => ({
            name: `Series-${String(seriesIndex)}`.padEnd(20, "x"),
            data: categories.map((label) => ({ label, value: Number.MAX_VALUE })),
          })),
          axis_config: { categories },
        },
      },
    ] as never;

    await expect(
      editSlackMessage("C123", "171234.567", "", {
        token: "xoxb-test",
        client,
        blocks,
      }),
    ).rejects.toThrow("Slack native chart or table fallback exceeds the 4000-character edit limit");
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("caps long block fallback text while preserving edit blocks", async () => {
    const client = createSlackEditTestClient();
    const longContextText = "a".repeat(1500);
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

    await editSlackMessage("C123", "171234.567", "", {
      token: "xoxb-test",
      client,
      blocks,
    });

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "171234.567",
      text: `${longContextText} ${longContextText} ${"a".repeat(SLACK_EDIT_TEXT_LIMIT - longContextText.length * 2 - 3)}…`,
      blocks,
    });
    expect(readFirstChatUpdatePayload(client).text).toHaveLength(SLACK_EDIT_TEXT_LIMIT);
  });

  it("rejects empty blocks arrays", async () => {
    const client = createSlackEditTestClient();

    await expect(
      editSlackMessage("C123", "171234.567", "updated", {
        token: "xoxb-test",
        client,
        blocks: [],
      }),
    ).rejects.toThrow(/must contain at least one block/i);

    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("rejects blocks missing a type", async () => {
    const client = createSlackEditTestClient();

    await expect(
      editSlackMessage("C123", "171234.567", "updated", {
        token: "xoxb-test",
        client,
        blocks: [{} as { type: string }],
      }),
    ).rejects.toThrow(/non-empty string type/i);

    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("rejects blocks arrays above Slack max count", async () => {
    const client = createSlackEditTestClient();
    const blocks = Array.from({ length: 51 }, () => ({ type: "divider" }));

    await expect(
      editSlackMessage("C123", "171234.567", "updated", {
        token: "xoxb-test",
        client,
        blocks,
      }),
    ).rejects.toThrow(/cannot exceed 50 items/i);

    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("checks escaped native edit fallback text against Slack's edit limit", async () => {
    const client = createSlackEditTestClient();
    client.chat.update.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Overview" } },
      { type: "section", text: { type: "mrkdwn", text: "<".repeat(1000) } },
      {
        type: "data_visualization",
        title: "Chart",
        chart: { type: "bar", series: [] },
      },
    ];

    await expect(
      editSlackMessage("C123", "171234.567", "Overview", {
        token: "xoxb-test",
        client,
        blocks,
      }),
    ).rejects.toThrow(/fallback exceeds the 4000-character edit limit/u);

    expect(client.chat.update).toHaveBeenCalledTimes(1);
  });
});
