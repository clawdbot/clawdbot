// Slack tests cover actions.blocks plugin behavior.
import { describe, expect, it } from "vitest";
import { createSlackEditTestClient } from "./blocks.test-helpers.js";

const { editSlackMessage } = await import("./actions.js");
const SLACK_TEXT_LIMIT = 8000;

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

  it("retries rejected native charts as visible fallback blocks", async () => {
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
            type: "mrkdwn",
            text: "Revenue mix (pie chart)\n- Product: 60\n- Services: 40",
            verbatim: true,
          },
        },
      ],
    });
  });

  it("retries rejected native tables once with visible complete fallback blocks", async () => {
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
    const fallback = [
      "Overview",
      "",
      "Pipeline report (table)",
      "- Account: Acme; ARR: $125k",
      "- Account: Globex; ARR: $82k",
    ].join("\n");

    await editSlackMessage("C123", "171234.567", "Overview", {
      token: "xoxb-test",
      client,
      blocks,
    });

    expect(client.chat.update).toHaveBeenCalledTimes(2);
    expect(client.chat.update).toHaveBeenNthCalledWith(1, {
      channel: "C123",
      ts: "171234.567",
      text: fallback,
      blocks,
    });
    expect(client.chat.update).toHaveBeenNthCalledWith(2, {
      channel: "C123",
      ts: "171234.567",
      text: fallback,
      blocks: [
        blocks[0],
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              "Pipeline report (table)",
              "- Account: Acme; ARR: $125k",
              "- Account: Globex; ARR: $82k",
            ].join("\n"),
            verbatim: true,
          },
        },
      ],
    });
  });

  it("includes every raw block and control in edit accessibility text", async () => {
    const client = createSlackEditTestClient();
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

    await editSlackMessage("C123", "171234.567", "Summary", {
      token: "xoxb-test",
      client,
      blocks,
    });

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "171234.567",
      text: "Summary\n\nDetails\n\n- Approve",
      blocks,
    });
  });

  it("fails closed when edit fallback expansion would drop 48 siblings", async () => {
    const client = createSlackEditTestClient();
    client.chat.update.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const categories = Array.from(
      { length: 20 },
      (_entry, index) => `category-${String(index)}-${"x".repeat(80)}`,
    );

    await expect(
      editSlackMessage("C123", "171234.567", "", {
        token: "xoxb-test",
        client,
        blocks: [
          ...Array.from({ length: 48 }, () => ({ type: "divider" })),
          {
            type: "data_visualization",
            title: "Large chart",
            chart: {
              type: "bar",
              axis_config: { categories },
              series: Array.from({ length: 4 }, (_entry, index) => ({
                name: `Series ${String(index)}`,
                data: categories.map((label) => ({ label, value: index })),
              })),
            },
          },
        ] as never,
      }),
    ).rejects.toThrow(/fallback requires .* blocks to retain every sibling/i);
    expect(client.chat.update).toHaveBeenCalledOnce();
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
    ).rejects.toThrow(
      "Slack block accessibility fallback exceeds OpenClaw's 8000-character per-edit limit",
    );
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("rejects chart edits whose complete fallback cannot fit one message", async () => {
    const client = createSlackEditTestClient();
    const categories = Array.from({ length: 20 }, (_entry, index) =>
      `Category-${String(index)}`.padEnd(20, "x"),
    );

    await expect(
      editSlackMessage("C123", "171234.567", "", {
        token: "xoxb-test",
        client,
        blocks: [
          {
            type: "data_visualization",
            title: "Large revenue report",
            chart: {
              type: "bar",
              axis_config: { categories },
              series: Array.from({ length: 12 }, (_entry, index) => ({
                name: `Series-${String(index)}`.padEnd(20, "x"),
                data: categories.map((label) => ({ label, value: Number.MAX_VALUE })),
              })),
            },
          },
        ] as never,
      }),
    ).rejects.toThrow(
      "Slack block accessibility fallback exceeds OpenClaw's 8000-character per-edit limit",
    );
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("rejects raw-block edits whose accessibility text cannot fit one message", async () => {
    const client = createSlackEditTestClient();
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

    await expect(
      editSlackMessage("C123", "171234.567", "", {
        token: "xoxb-test",
        client,
        blocks,
      }),
    ).rejects.toThrow(
      `Slack block accessibility fallback exceeds OpenClaw's ${String(SLACK_TEXT_LIMIT)}-character per-edit limit`,
    );
    expect(client.chat.update).not.toHaveBeenCalled();
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
});
