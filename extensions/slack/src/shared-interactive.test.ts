// Slack tests cover shared interactive plugin behavior.
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { describe, expect, it } from "vitest";
import {
  buildSlackInteractiveBlocks,
  buildSlackPresentationBlocks,
  canRenderSlackPresentation,
  canRenderSlackPresentationTables,
  resolveSlackBlockOffsets,
  type SlackBlock,
} from "./blocks-render.js";
import { resolveSlackReplyBlocks } from "./reply-blocks.js";

describe("buildSlackInteractiveBlocks", () => {
  it("renders shared interactive blocks in authored order", () => {
    expect(
      buildSlackInteractiveBlocks({
        blocks: [
          {
            type: "select",
            placeholder: "Pick one",
            options: [{ label: "Alpha", value: "alpha" }],
          },
          { type: "text", text: "then" },
          { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
        ],
      }),
    ).toEqual([
      {
        type: "actions",
        block_id: "openclaw_reply_select_1",
        elements: [
          {
            type: "static_select",
            action_id: "openclaw:reply_select:1",
            placeholder: {
              type: "plain_text",
              text: "Pick one",
              emoji: true,
            },
            options: [
              {
                text: {
                  type: "plain_text",
                  text: "Alpha",
                  emoji: true,
                },
                value: "alpha",
              },
            ],
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "then",
        },
      },
      {
        type: "actions",
        block_id: "openclaw_reply_buttons_1",
        elements: [
          {
            type: "button",
            action_id: "openclaw:reply_button:1:1",
            text: {
              type: "plain_text",
              text: "Retry",
              emoji: true,
            },
            value: "retry",
          },
        ],
      },
    ]);
  });

  it("truncates Slack render strings to Block Kit limits", () => {
    const long = "x".repeat(120);
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        { type: "text", text: "y".repeat(3100) },
        { type: "select", placeholder: long, options: [{ label: long, value: "valid" }] },
        { type: "buttons", buttons: [{ label: long, value: long }] },
      ],
    });
    const section = blocks[0] as { text?: { text?: string } };
    const selectBlock = blocks[1] as {
      elements?: Array<{ placeholder?: { text?: string } }>;
    };
    const buttonBlock = blocks[2] as {
      elements?: Array<{ value?: string }>;
    };

    expect((section.text?.text ?? "").length).toBeLessThanOrEqual(3000);
    expect((selectBlock.elements?.[0]?.placeholder?.text ?? "").length).toBeLessThanOrEqual(75);
    expect(buttonBlock.elements?.[0]?.value).toBe(long);
  });

  it.each([
    {
      name: "button label",
      block: { type: "buttons" as const, buttons: [{ label: "x".repeat(76), value: "go" }] },
    },
    {
      name: "select placeholder",
      block: {
        type: "select" as const,
        placeholder: "x".repeat(76),
        options: [{ label: "Go", value: "go" }],
      },
    },
    {
      name: "select option label",
      block: {
        type: "select" as const,
        placeholder: "Choose",
        options: [{ label: "x".repeat(76), value: "go" }],
      },
    },
  ])("does not silently truncate an oversized portable $name", ({ block }) => {
    expect(canRenderSlackPresentation({ blocks: [block] })).toBe(false);
  });

  it("preserves original callback payloads for round-tripping", () => {
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Allow", value: "pluginbind:approval-123:o" }],
        },
        {
          type: "select",
          options: [{ label: "Approve", value: "codex:approve:thread-1" }],
        },
      ],
    });

    const buttonBlock = blocks[0] as {
      elements?: Array<{ action_id?: string; value?: string }>;
    };
    const selectBlock = blocks[1] as {
      elements?: Array<{
        action_id?: string;
        options?: Array<{ value?: string }>;
      }>;
    };

    expect(buttonBlock.elements?.[0]?.action_id).toBe("openclaw:reply_button:1:1");
    expect(buttonBlock.elements?.[0]?.value).toBe("pluginbind:approval-123:o");
    expect(selectBlock.elements?.[0]?.action_id).toBe("openclaw:reply_select:1");
    expect(selectBlock.elements?.[0]?.options?.[0]?.value).toBe("codex:approve:thread-1");
  });

  it("drops Slack select options with values beyond Block Kit limits", () => {
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        {
          type: "select",
          options: [
            { label: "Allowed", value: "a".repeat(150) },
            { label: "Too long", value: "b".repeat(151) },
          ],
        },
      ],
    });

    const selectBlock = blocks[0] as {
      elements?: Array<{ options?: Array<{ value?: string }> }>;
    };

    expect(selectBlock.elements?.[0]?.options).toHaveLength(1);
    expect(selectBlock.elements?.[0]?.options?.[0]?.value).toBe("a".repeat(150));
  });

  it("omits Slack select blocks when every option value exceeds Block Kit limits", () => {
    expect(
      buildSlackInteractiveBlocks({
        blocks: [
          {
            type: "select",
            options: [{ label: "Too long", value: "x".repeat(151) }],
          },
        ],
      }),
    ).toStrictEqual([]);
  });

  it("caps Slack static selects at the Block Kit option limit", () => {
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        {
          type: "select",
          options: Array.from({ length: 101 }, (_entry, index) => ({
            label: `Option ${index + 1}`,
            value: `v${index + 1}`,
          })),
        },
      ],
    });

    const selectBlock = blocks[0] as {
      elements?: Array<{ options?: Array<{ value?: string }> }>;
    };

    expect(selectBlock.elements?.[0]?.options).toHaveLength(100);
    expect(selectBlock.elements?.[0]?.options?.at(-1)?.value).toBe("v100");
  });

  it("drops value-only Slack buttons with values beyond Block Kit limits", () => {
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Allowed", value: "a".repeat(2000) },
            { label: "Too long", value: "b".repeat(2001) },
            { label: "Docs", value: "c".repeat(2001), url: "https://example.com/docs" },
          ],
        },
      ],
    });

    const buttonBlock = blocks[0] as {
      elements?: Array<{ value?: string; url?: string }>;
    };

    expect(buttonBlock.elements).toHaveLength(2);
    expect(buttonBlock.elements?.[0]?.value).toBe("a".repeat(2000));
    expect(buttonBlock.elements?.[1]).toEqual({
      type: "button",
      action_id: "openclaw:reply_link:1:3",
      text: {
        type: "plain_text",
        text: "Docs",
        emoji: true,
      },
      url: "https://example.com/docs",
    });
  });

  it("drops Slack button URLs beyond Block Kit limits", () => {
    const validUrl = `https://example.com/${"a".repeat(2980)}`;
    const longUrl = `https://example.com/${"b".repeat(2981)}`;
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Allowed", url: validUrl },
            { label: "Too long", url: longUrl },
            { label: "Fallback action", value: "fallback", url: longUrl },
          ],
        },
      ],
    });

    const buttonBlock = blocks[0] as {
      elements?: Array<{ value?: string; url?: string }>;
    };

    expect(validUrl).toHaveLength(3000);
    expect(longUrl).toHaveLength(3001);
    expect(buttonBlock.elements).toHaveLength(2);
    expect(buttonBlock.elements?.[0]?.url).toBe(validUrl);
    expect(buttonBlock.elements?.[1]?.value).toBe("fallback");
    expect(buttonBlock.elements?.[1]).not.toHaveProperty("url");
  });

  it("caps Slack actions blocks at the Block Kit element limit", () => {
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        {
          type: "buttons",
          buttons: Array.from({ length: 26 }, (_entry, index) => ({
            label: `Option ${index + 1}`,
            value: `v${index + 1}`,
          })),
        },
      ],
    });

    const buttonBlock = blocks[0] as {
      elements?: Array<{ value?: string }>;
    };

    expect(buttonBlock.elements).toHaveLength(25);
    expect(buttonBlock.elements?.at(-1)?.value).toBe("v25");
  });

  it("preserves URL-only buttons as Slack link buttons", () => {
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Docs", url: "https://example.com/docs" }],
        },
      ],
    });

    const buttonBlock = blocks[0] as {
      elements?: Array<{ value?: string; url?: string }>;
    };

    expect(buttonBlock.elements?.[0]).toEqual({
      type: "button",
      action_id: "openclaw:reply_link:1:1",
      text: {
        type: "plain_text",
        text: "Docs",
        emoji: true,
      },
      url: "https://example.com/docs",
    });
  });

  it("maps supported button styles to Slack Block Kit styles", () => {
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Approve", value: "approve", style: "primary" },
            { label: "Deny", value: "deny", style: "danger" },
            { label: "Confirm", value: "confirm", style: "success" },
            { label: "Skip", value: "skip", style: "secondary" },
          ],
        },
      ],
    });

    const buttonBlock = blocks[0] as {
      elements?: Array<{ style?: string }>;
    };

    expect(buttonBlock.elements?.[0]?.style).toBe("primary");
    expect(buttonBlock.elements?.[1]?.style).toBe("danger");
    expect(buttonBlock.elements?.[2]?.style).toBe("primary");
    expect(buttonBlock.elements?.[3]).not.toHaveProperty("style");
  });
});

describe("buildSlackPresentationBlocks", () => {
  it("renders presentation blocks in authored order", () => {
    const blocks = buildSlackPresentationBlocks({
      blocks: [
        { type: "text", text: "First" },
        { type: "buttons", buttons: [{ label: "Approve", value: "approve" }] },
        { type: "context", text: "After buttons" },
        { type: "divider" },
        {
          type: "select",
          options: [{ label: "One", value: "one" }],
        },
      ],
    });

    expect(blocks.map((block) => block.type)).toEqual([
      "section",
      "actions",
      "context",
      "divider",
      "actions",
    ]);
  });

  it("renders presentation controls without requiring legacy interactive payloads", () => {
    const blocks = buildSlackPresentationBlocks({
      blocks: [
        { type: "text", text: "Pick" },
        {
          type: "buttons",
          buttons: [
            {
              label: "Approve",
              action: { type: "callback", value: "approve" },
              style: "success",
            },
          ],
        },
      ],
    });

    expect(blocks).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: "Pick" },
      },
      {
        type: "actions",
        block_id: "openclaw_reply_buttons_1",
        elements: [
          {
            type: "button",
            action_id: "openclaw:callback_button:1:1",
            text: {
              type: "plain_text",
              text: "Approve",
              emoji: true,
            },
            value: "approve",
            style: "primary",
          },
        ],
      },
    ]);
  });

  it("encodes typed approvals with Slack-private action data", () => {
    const blocks = buildSlackPresentationBlocks({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Allow once",
              action: {
                type: "approval",
                approvalId: "plugin:req/😀",
                approvalKind: "plugin",
                decision: "allow-once",
              },
            },
          ],
        },
      ],
    });

    expect(blocks).toEqual([
      {
        type: "actions",
        block_id: "openclaw_reply_buttons_1",
        elements: [
          {
            type: "button",
            action_id: "openclaw:approval_button:1:1",
            text: {
              type: "plain_text",
              text: "Allow once",
              emoji: true,
            },
            value:
              'openclaw:approval:v1:{"approvalId":"plugin:req/😀","approvalKind":"plugin","decision":"allow-once"}',
          },
        ],
      },
    ]);
  });

  it("does not activate deprecated targets behind invalid explicit actions", () => {
    const presentation = {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Invalid",
              action: null,
              value: "legacy",
              url: "https://legacy.example",
            },
          ],
        },
        {
          type: "select",
          options: [{ label: "Invalid", action: null, value: "legacy" }],
        },
      ],
    } as unknown as MessagePresentation;

    expect(buildSlackPresentationBlocks(presentation)).toEqual([]);
  });

  it("does not render generic command actions that Slack cannot execute", () => {
    const blocks = buildSlackPresentationBlocks({
      blocks: [
        { type: "text", text: "Pick" },
        {
          type: "buttons",
          buttons: [{ label: "Plugins", action: { type: "command", command: "/codex plugins" } }],
        },
      ],
    });

    expect(blocks).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: "Pick" },
      },
    ]);
  });

  it("keeps legacy approval commands on the owner-neutral reply route", () => {
    const blocks = buildSlackPresentationBlocks({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Approve",
              action: { type: "command", command: "/approve req-1 allow-once" },
            },
          ],
        },
      ],
    });

    expect(blocks).toEqual([
      {
        type: "actions",
        block_id: "openclaw_reply_buttons_1",
        elements: [
          {
            type: "button",
            action_id: "openclaw:reply_button:1:1",
            text: {
              type: "plain_text",
              text: "Approve",
              emoji: true,
            },
            value: "/approve req-1 allow-once",
          },
        ],
      },
    ]);
  });

  it("renders Slack-incompatible charts as visible text", () => {
    const title = "A".repeat(51);

    expect(
      buildSlackPresentationBlocks({
        blocks: [
          {
            type: "chart",
            chartType: "pie",
            title,
            segments: [{ label: "Product", value: 60 }],
          },
        ],
      }),
    ).toEqual([
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `${title} (pie chart)\n- Product: 60`, verbatim: true }],
      },
    ]);
  });

  it("chunks Slack-incompatible chart fallback without truncating its data", () => {
    const categories = Array.from(
      { length: 4 },
      (_entry, index) => `category-${String(index)}-${"x".repeat(1_000)}`,
    );
    const blocks = buildSlackPresentationBlocks({
      blocks: [
        {
          type: "chart",
          chartType: "line",
          title: "Long labels",
          categories,
          series: [{ name: "Requests", values: [1, 2, 3, 4] }],
        },
      ],
    });
    const chunks = blocks.flatMap((block) => {
      const context = block as { type?: string; elements?: Array<{ text?: string }> };
      return context.type === "context"
        ? (context.elements ?? []).flatMap((element) => (element.text ? [element.text] : []))
        : [];
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 3_000)).toBe(true);
    expect(chunks.join("\n")).toContain(categories.at(-1));
    expect(chunks.join("\n")).toContain(": 4");
  });

  it("renders at most two native charts per message", () => {
    const blocks = buildSlackPresentationBlocks({
      blocks: [
        {
          type: "chart",
          chartType: "pie",
          title: "Issue share",
          segments: [{ label: "Open", value: 5 }],
        },
        {
          type: "chart",
          chartType: "bar",
          title: "Weekly volume",
          categories: ["Mon"],
          series: [{ name: "Messages", values: [12] }],
        },
        {
          type: "chart",
          chartType: "area",
          title: "Active sessions",
          categories: ["09:00"],
          series: [{ name: "Sessions", values: [3] }],
        },
      ],
    });

    expect(blocks.map((block) => block.type)).toEqual([
      "data_visualization",
      "data_visualization",
      "context",
    ]);
    expect(blocks[2]).toEqual({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Active sessions (area chart)\n- Sessions: 09:00: 3",
          verbatim: true,
        },
      ],
    });
  });

  it("counts existing native chart blocks toward Slack's per-message limit", () => {
    const nativeChart = {
      type: "data_visualization",
      title: "Existing chart",
      chart: { type: "pie", segments: [{ label: "Open", value: 5 }] },
    } as SlackBlock;
    const offsets = resolveSlackBlockOffsets([nativeChart, nativeChart]);

    const presentation = {
      blocks: [
        {
          type: "chart" as const,
          chartType: "pie" as const,
          title: "Presentation chart",
          segments: [{ label: "Closed", value: 8 }],
        },
      ],
    };
    expect(canRenderSlackPresentation(presentation, offsets)).toBe(false);
    expect(buildSlackPresentationBlocks(presentation, offsets)).toEqual([
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Presentation chart (pie chart)\n- Closed: 8",
            verbatim: true,
          },
        ],
      },
    ]);
  });

  it("renders portable tables as native data tables with typed numeric cells", () => {
    expect(
      buildSlackPresentationBlocks({
        blocks: [
          {
            type: "table",
            caption: "Pipeline report",
            headers: ["Account", "Stage", "ARR"],
            rows: [
              ["Acme", "Won", 125000],
              ["Globex", "Review", 82000],
            ],
            rowHeaderColumnIndex: 0,
          },
        ],
      }),
    ).toEqual([
      {
        type: "data_table",
        caption: "Pipeline report",
        row_header_column_index: 0,
        rows: [
          [
            { type: "raw_text", text: "Account" },
            { type: "raw_text", text: "Stage" },
            { type: "raw_text", text: "ARR" },
          ],
          [
            { type: "raw_text", text: "Acme" },
            { type: "raw_text", text: "Won" },
            { type: "raw_number", value: 125000, text: "125000" },
          ],
          [
            { type: "raw_text", text: "Globex" },
            { type: "raw_text", text: "Review" },
            { type: "raw_number", value: 82000, text: "82000" },
          ],
        ],
      },
    ]);
  });

  it("keeps over-budget tables out of the native block renderer", () => {
    const table = (caption: string, value: string) => ({
      type: "table" as const,
      caption,
      headers: ["Account"],
      rows: Array.from({ length: 100 }, (_entry, index) => [`${String(index)}-${value}`]),
    });
    const presentation = {
      blocks: [table("First", "a".repeat(45)), table("Second", "b".repeat(55))],
    };

    expect(canRenderSlackPresentation(presentation)).toBe(false);
    expect(canRenderSlackPresentationTables(presentation)).toBe(false);
    expect(buildSlackPresentationBlocks(presentation)).toEqual([]);
  });

  it("counts raw native tables against the aggregate Slack table budget", () => {
    const nativeTable = {
      type: "data_table",
      caption: "Existing",
      rows: [[{ type: "raw_text", text: "Name" }], [{ type: "raw_text", text: "x".repeat(9995) }]],
    } as SlackBlock;

    const blocks = buildSlackPresentationBlocks(
      {
        blocks: [
          {
            type: "table",
            caption: "Portable",
            headers: ["Name"],
            rows: [["Acme"]],
          },
        ],
      },
      resolveSlackBlockOffsets([nativeTable]),
    );

    expect(blocks).toEqual([]);
  });
});

describe("resolveSlackReplyBlocks", () => {
  it("offsets legacy interactive blocks after channel and presentation controls", () => {
    const blocks = resolveSlackReplyBlocks({
      channelData: {
        slack: {
          blocks: [
            {
              type: "actions",
              block_id: "openclaw_reply_buttons_1",
              elements: [],
            },
          ],
        },
      },
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Stage", value: "stage" }],
          },
        ],
      },
      interactive: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Approve", value: "approve" }],
          },
        ],
      },
    });

    const presentationButtonBlock = blocks?.[1] as
      | { elements?: Array<{ action_id?: string }> }
      | undefined;
    const legacyButtonBlock = blocks?.[2] as
      | { elements?: Array<{ action_id?: string }> }
      | undefined;
    expect(blocks?.[0]?.block_id).toBe("openclaw_reply_buttons_1");
    expect(blocks?.[1]?.block_id).toBe("openclaw_reply_buttons_2");
    expect(presentationButtonBlock?.elements?.[0]?.action_id).toBe("openclaw:reply_button:2:1");
    expect(blocks?.[2]?.block_id).toBe("openclaw_reply_buttons_3");
    expect(legacyButtonBlock?.elements?.[0]?.action_id).toBe("openclaw:reply_button:3:1");
  });
});
