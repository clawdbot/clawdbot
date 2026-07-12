import {
  presentationToInteractiveControlsReply,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import { describe, expect, it } from "vitest";
import { resolveSlackReplyBlockResolution, resolveSlackReplyText } from "./reply-blocks.js";

describe("resolveSlackReplyText", () => {
  it("includes complete portable table data in Slack accessibility text", () => {
    expect(
      resolveSlackReplyText({
        text: "Pipeline summary",
        presentation: {
          blocks: [
            {
              type: "table",
              caption: "Pipeline",
              headers: ["Account", "Stage", "ARR"],
              rows: [
                ["Acme", "Won", 125000],
                ["Globex", "Review", 82000],
              ],
            },
          ],
        },
      }),
    ).toBe(
      "Pipeline summary\n\nPipeline (table)\n- Account: Acme; Stage: Won; ARR: 125000\n- Account: Globex; Stage: Review; ARR: 82000",
    );
  });

  it("keeps raw table values literal without changing authored Slack text", () => {
    expect(
      resolveSlackReplyText({
        text: "Intentional <!here>",
        presentation: {
          title: "Report <@U999>",
          blocks: [
            {
              type: "table",
              caption: "<!channel> *report*",
              headers: ["Owner_name"],
              rows: [["<@U123> & <https://example.com>"]],
            },
          ],
        },
      }),
    ).toBe(
      "Intentional <!here>\n\nReport &lt;@U999&gt;\n\n&lt;!channel&gt; \\*report\\* (table)\n- Owner\\_name: &lt;@U123&gt; &amp; &lt;https://example.com&gt;",
    );
  });

  it("keeps plain-text controls literal when they accompany structured data", () => {
    expect(
      resolveSlackReplyText({
        presentation: {
          blocks: [
            { type: "table", caption: "Data", headers: ["Value"], rows: [[1]] },
            {
              type: "buttons",
              buttons: [
                {
                  label: "Notify <!here>",
                  url: "https://example.com/?a=1&b=2",
                },
                {
                  label: "Run <@U1>",
                  action: { type: "command", command: "/say <!channel>" },
                },
              ],
            },
            {
              type: "select",
              placeholder: "Owner <!channel>",
              options: [{ label: "<@U2>", value: "owner" }],
            },
          ],
        },
      }),
    ).toBe(
      [
        "Data (table)",
        "- Value: 1",
        "",
        "- Notify &lt;!here&gt;: https://example.com/?a=1&amp;b=2",
        "- Run &lt;@U1&gt;: `/say <!channel>`",
        "",
        "Owner &lt;!channel&gt;:",
        "- &lt;@U2&gt;",
      ].join("\n"),
    );
  });

  it("marks command fallbacks with backticks as not copyable", () => {
    const rendered = resolveSlackReplyText({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Run",
                action: {
                  type: "command",
                  command: "/run foo_bar C:\\tools\\run ` <!channel> <@U1>",
                },
              },
            ],
          },
        ],
      },
    });

    const codeSpans = [...rendered.matchAll(/`([^`]*)`/gs)];
    expect(codeSpans).toHaveLength(1);
    expect(codeSpans[0]?.[1]).toBe("/run foo_bar C:\\tools\\run [backtick] <!channel> <@U1>");
    expect(rendered).toContain("Run [not copyable: contains backtick]");
    expect(rendered).not.toMatch(/[\u02cb\uff40]/u);
    expect(rendered.replace(/`[^`]*`/gs, "")).not.toMatch(/<!channel>|<@U1>/);
  });

  it("keeps safe command fallback bytes exact", () => {
    expect(
      resolveSlackReplyText({
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Run",
                  action: {
                    type: "command",
                    command: "/run foo_bar C:\\tools\\run <!channel> <@U1>",
                  },
                },
              ],
            },
          ],
        },
      }),
    ).toBe("- Run: `/run foo_bar C:\\tools\\run <!channel> <@U1>`");
  });

  it("keeps non-native table text between raw, portable, and legacy blocks", () => {
    const payload = {
      channelData: {
        slack: {
          blocks: [
            {
              type: "actions",
              block_id: "openclaw_reply_buttons_1",
              elements: [
                {
                  type: "button",
                  action_id: "existing_button",
                  text: { type: "plain_text", text: "Existing" },
                  value: "existing",
                },
              ],
            },
            {
              type: "actions",
              block_id: "openclaw_reply_select_1",
              elements: [
                {
                  type: "static_select",
                  action_id: "existing_select",
                  placeholder: { type: "plain_text", text: "Existing" },
                  options: [
                    {
                      text: { type: "plain_text", text: "Existing" },
                      value: "existing",
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      presentation: {
        blocks: [
          {
            type: "table" as const,
            caption: "Large pipeline",
            headers: ["Account"],
            rows: Array.from({ length: 100 }, (_entry, index) => [
              `account-${String(index)} ${"x".repeat(110)}`,
            ]),
          },
          {
            type: "buttons" as const,
            buttons: [{ label: "Stage", value: "stage" }],
          },
          {
            type: "select" as const,
            placeholder: "Lane",
            options: [{ label: "Production", value: "production" }],
          },
        ],
      },
      interactive: {
        blocks: [
          {
            type: "buttons" as const,
            buttons: [{ label: "Refresh", value: "refresh" }],
          },
          {
            type: "select" as const,
            placeholder: "Window",
            options: [{ label: "Recent", value: "recent" }],
          },
        ],
      },
    };

    const { segments } = resolveSlackReplyBlockResolution(payload);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({
      kind: "blocks",
      blocks: [
        { type: "actions", block_id: "openclaw_reply_buttons_1" },
        { type: "actions", block_id: "openclaw_reply_select_1" },
      ],
    });
    expect(segments[1]).toMatchObject({ kind: "text" });
    expect(segments[1]?.kind === "text" ? segments[1].text : "").toContain("- Account: account-99");
    expect(segments[2]).toMatchObject({
      kind: "blocks",
      blocks: [
        {
          type: "actions",
          block_id: "openclaw_reply_buttons_2",
          elements: [{ action_id: "openclaw:reply_button:2:1", value: "stage" }],
        },
        {
          type: "actions",
          block_id: "openclaw_reply_select_2",
          elements: [{ action_id: "openclaw:reply_select:2" }],
        },
        {
          type: "actions",
          block_id: "openclaw_reply_buttons_3",
          elements: [{ action_id: "openclaw:reply_button:3:1", value: "refresh" }],
        },
        {
          type: "actions",
          block_id: "openclaw_reply_select_3",
          elements: [{ action_id: "openclaw:reply_select:3" }],
        },
      ],
    });
    expect(resolveSlackReplyText(payload)).toContain("- Account: account-99");
  });

  it("coalesces adjacent fallbacks without changing their authored order", () => {
    const payload = {
      presentation: {
        blocks: [
          {
            type: "table" as const,
            caption: "Large pipeline",
            headers: ["Account"],
            rows: Array.from({ length: 100 }, (_entry, index) => [
              `account-${String(index)} ${"x".repeat(110)}`,
            ]),
          },
          {
            type: "buttons" as const,
            buttons: [
              {
                label: "Run",
                action: { type: "command" as const, command: "/say <@U1>_now" },
              },
            ],
          },
        ],
      },
    };

    const { segments } = resolveSlackReplyBlockResolution(payload);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe("text");
    const fallback = segments[0]?.kind === "text" ? segments[0].text : "";
    expect(fallback.indexOf("Large pipeline (table)")).toBeLessThan(fallback.indexOf("- Run"));
    expect(fallback).toContain("- Account: account-99");
    expect(fallback).toContain("- Run: `/say <@U1>_now`");
  });

  it("marks fallback segments as literal text without Slack entity escaping", () => {
    const headers = Array.from({ length: 21 }, (_entry, index) => `Column ${String(index)}`);
    const values = headers.map((_header, index) =>
      index === 20 ? "<@U1> & <!channel>" : `Value ${String(index)}`,
    );
    const { segments } = resolveSlackReplyBlockResolution({
      presentation: {
        blocks: [
          { type: "table", caption: "Owners", headers, rows: [values] },
          {
            type: "buttons",
            buttons: [
              {
                label: "Run",
                action: { type: "command", command: "/say ` <!channel>" },
              },
            ],
          },
        ],
      },
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ kind: "text", mrkdwn: false });
    const fallback = segments[0]?.kind === "text" ? segments[0].text : "";
    expect(fallback).toContain("<@U1> & <!channel>");
    expect(fallback).toContain("/say ` <!channel>");
    expect(fallback).not.toContain("&lt;");
  });

  it("recognizes authored text already carried by a fallback segment", () => {
    const title = "This chart title is too long for Slack native chart rendering";
    const text = `${title} (pie chart)\n- Open: 5`;
    const resolution = resolveSlackReplyBlockResolution({
      text,
      presentation: {
        blocks: [
          {
            type: "chart",
            chartType: "pie",
            title,
            segments: [{ label: "Open", value: 5 }],
          },
        ],
      },
    });

    expect(resolution.authoredTextPlacement).toBe("blocks");
    expect(resolution.segments).toContainEqual({ kind: "text", text, mrkdwn: false });
  });

  it("materializes authored text blocks as verbatim mrkdwn", () => {
    const resolution = resolveSlackReplyBlockResolution(
      {
        text: "<@U123> literal",
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "Refresh", value: "refresh" }] }],
        },
      },
      { materializeAuthoredText: true },
    );

    expect(resolution.segments[0]?.kind).toBe("blocks");
    const blocks = resolution.segments[0]?.kind === "blocks" ? resolution.segments[0].blocks : [];
    expect(blocks[0]).toMatchObject({
      type: "section",
      text: { type: "mrkdwn", text: "<@U123> literal", verbatim: true },
    });
  });

  it("recognizes authored text already represented by native chart data", () => {
    const resolution = resolveSlackReplyBlockResolution({
      text: "Revenue mix (pie chart)\n- Product: 60\n- Services: 40",
      presentation: {
        blocks: [
          {
            type: "chart",
            chartType: "pie",
            title: "Revenue mix",
            segments: [
              { label: "Product", value: 60 },
              { label: "Services", value: 40 },
            ],
          },
          { type: "buttons", buttons: [{ label: "Refresh", value: "refresh" }] },
        ],
      },
    });

    expect(resolution.authoredTextPlacement).toBe("blocks");
  });

  it("preserves mixed chart, table, and control order across native and text segments", () => {
    const headers = Array.from({ length: 21 }, (_entry, index) => `Column ${String(index)}`);
    const payload = {
      presentation: {
        blocks: [
          {
            type: "chart" as const,
            chartType: "pie" as const,
            title: "Issue share",
            segments: [{ label: "Open", value: 5 }],
          },
          {
            type: "table" as const,
            caption: "Wide pipeline",
            headers,
            rows: [headers.map((_header, index) => `Value ${String(index)}`)],
          },
          {
            type: "buttons" as const,
            buttons: [{ label: "Stage", value: "stage" }],
          },
          {
            type: "chart" as const,
            chartType: "pie" as const,
            title: "This chart title cannot fit Slack's native chart title limit",
            segments: [{ label: "Closed", value: 8 }],
          },
          {
            type: "select" as const,
            placeholder: "Lane",
            options: [{ label: "Production", value: "production" }],
          },
        ],
      },
      interactive: {
        blocks: [
          {
            type: "buttons" as const,
            buttons: [{ label: "Refresh", value: "refresh" }],
          },
        ],
      },
    };

    const { segments } = resolveSlackReplyBlockResolution(payload);
    expect(segments.map((segment) => segment.kind)).toEqual([
      "blocks",
      "text",
      "blocks",
      "text",
      "blocks",
    ]);
    expect(segments[0]).toMatchObject({
      kind: "blocks",
      blocks: [{ type: "data_visualization", title: "Issue share" }],
    });
    expect(segments[1]).toMatchObject({ kind: "text" });
    expect(segments[1]?.kind === "text" ? segments[1].text : "").toContain("Column 20: Value 20");
    expect(segments[2]).toMatchObject({
      kind: "blocks",
      blocks: [{ block_id: "openclaw_reply_buttons_1", elements: [{ value: "stage" }] }],
    });
    expect(segments[3]).toMatchObject({
      kind: "text",
      text: expect.stringContaining("Closed: 8"),
    });
    expect(segments[4]).toMatchObject({
      kind: "blocks",
      blocks: [
        { block_id: "openclaw_reply_select_1" },
        { block_id: "openclaw_reply_buttons_2", elements: [{ value: "refresh" }] },
      ],
    });
  });

  it("keeps complete unsupported chart data beyond Slack's section text limit", () => {
    const categories = Array.from(
      { length: 4 },
      (_entry, index) => `category-${String(index)}-${"x".repeat(1_000)}`,
    );
    const { segments } = resolveSlackReplyBlockResolution({
      presentation: {
        blocks: [
          {
            type: "chart",
            chartType: "line",
            title: "Long labels",
            categories,
            series: [{ name: "Requests", values: [1, 2, 3, 4] }],
          },
        ],
      },
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe("text");
    const fallback = segments[0]?.kind === "text" ? segments[0].text : "";
    expect(fallback.length).toBeGreaterThan(3_000);
    expect(fallback).toContain(categories.at(-1));
    expect(fallback).toContain("category-3-");
  });

  it("starts a new native segment instead of dropping blocks beyond the message budget", () => {
    const payload = {
      channelData: {
        slack: { blocks: Array.from({ length: 50 }, () => ({ type: "divider" })) },
      },
      presentation: {
        blocks: [
          {
            type: "table" as const,
            caption: "Accounts",
            headers: ["Account"],
            rows: [["Acme"]],
          },
        ],
      },
      interactive: {
        blocks: [
          {
            type: "buttons" as const,
            buttons: [{ label: "Refresh", value: "refresh" }],
          },
        ],
      },
    };

    const { segments } = resolveSlackReplyBlockResolution(payload);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ kind: "blocks" });
    expect(segments[0]?.kind === "blocks" ? segments[0].blocks : []).toHaveLength(50);
    expect(segments[1]).toMatchObject({
      kind: "blocks",
      blocks: [
        { type: "data_table", caption: "Accounts" },
        { block_id: "openclaw_reply_buttons_1", elements: [{ value: "refresh" }] },
      ],
    });
  });

  it("subtracts exact legacy mirrors for every typed action family", () => {
    const presentation = {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Command",
              action: { type: "command", command: "/approve req-1 allow-once" },
            },
            { label: "Callback", action: { type: "callback", value: "callback-button" } },
            {
              label: "Approval",
              action: {
                type: "approval",
                approvalId: "plugin:req-1",
                approvalKind: "plugin",
                decision: "allow-once",
              },
            },
            { label: "URL", action: { type: "url", url: "https://example.com/docs" } },
            {
              label: "Web app",
              action: { type: "web-app", url: "https://example.com/app" },
            },
          ],
        },
        {
          type: "select",
          placeholder: "Command select",
          options: [
            {
              label: "Deny",
              action: { type: "command", command: "/approve req-2 deny" },
            },
          ],
        },
        {
          type: "select",
          placeholder: "Callback select",
          options: [{ label: "Retry", action: { type: "callback", value: "callback-select" } }],
        },
      ],
    } satisfies MessagePresentation;

    const { segments } = resolveSlackReplyBlockResolution({
      presentation,
      interactive: presentationToInteractiveControlsReply(presentation),
    });
    const blocks = segments[0]?.kind === "blocks" ? segments[0].blocks : [];
    const actionIds = blocks.flatMap((block) =>
      block.type === "actions"
        ? ((block as { elements?: Array<{ action_id?: string }> }).elements ?? []).flatMap(
            (element) => (element.action_id ? [element.action_id] : []),
          )
        : [],
    );

    expect(segments).toHaveLength(1);
    expect(blocks).toHaveLength(3);
    expect(actionIds).toEqual([
      "openclaw:reply_button:1:1",
      "openclaw:callback_button:1:2",
      "openclaw:approval_button:1:3",
      "openclaw:reply_link:1:4",
      "openclaw:reply_link:1:5",
      "openclaw:reply_select:1",
      "openclaw:callback_select:2",
    ]);
  });

  it("keeps transport-distinct controls with the same visible content", () => {
    const { segments } = resolveSlackReplyBlockResolution({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Run", action: { type: "callback", value: "same" } }],
          },
        ],
      },
      interactive: {
        blocks: [{ type: "buttons", buttons: [{ label: "Run", value: "same" }] }],
      },
    });
    const blocks = segments[0]?.kind === "blocks" ? segments[0].blocks : [];

    expect(blocks).toHaveLength(2);
    expect(
      blocks.map(
        (block) => (block as { elements?: Array<{ action_id?: string }> }).elements?.[0]?.action_id,
      ),
    ).toEqual(["openclaw:callback_button:1:1", "openclaw:reply_button:2:1"]);
  });

  it("subtracts mirrors as a multiset and keeps surplus or changed rows", () => {
    const repeated = {
      type: "buttons" as const,
      buttons: [{ label: "Run", action: { type: "callback" as const, value: "same" } }],
    };
    const { segments } = resolveSlackReplyBlockResolution({
      presentation: { blocks: [repeated, repeated] },
      interactive: {
        blocks: [
          repeated,
          repeated,
          repeated,
          {
            type: "buttons",
            buttons: [
              {
                label: "Run",
                action: { type: "callback", value: "same" },
                style: "danger",
              },
            ],
          },
        ],
      },
    });
    const blocks = segments[0]?.kind === "blocks" ? segments[0].blocks : [];

    expect(blocks).toHaveLength(4);
    expect(
      blocks.map(
        (block) => (block as { elements?: Array<{ style?: string }> }).elements?.[0]?.style,
      ),
    ).toEqual([undefined, undefined, undefined, "danger"]);
  });

  it("keeps legacy controls when their presentation mirror falls back to text", () => {
    const presentation = {
      blocks: [
        {
          type: "buttons",
          buttons: Array.from({ length: 26 }, (_entry, index) => ({
            label: `Action ${String(index + 1)}`,
            action: { type: "callback" as const, value: `action-${String(index + 1)}` },
          })),
        },
      ],
    } satisfies MessagePresentation;
    const { segments } = resolveSlackReplyBlockResolution({
      presentation,
      interactive: presentationToInteractiveControlsReply(presentation),
    });

    expect(segments.map((segment) => segment.kind)).toEqual(["text", "blocks"]);
    const blocks = segments[1]?.kind === "blocks" ? segments[1].blocks : [];
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { elements?: unknown[] }).elements).toHaveLength(25);
  });

  it("subtracts mirrors before enforcing each Slack message block limit", () => {
    const presentation = {
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Approve", action: { type: "callback", value: "approve" } }],
        },
      ],
    } satisfies MessagePresentation;
    const interactive = presentationToInteractiveControlsReply(presentation);
    const channelData = {
      slack: { blocks: Array.from({ length: 49 }, () => ({ type: "divider" })) },
    };

    const exact = resolveSlackReplyBlockResolution({ channelData, presentation, interactive });
    expect(exact.segments).toHaveLength(1);
    expect(exact.segments[0]?.kind === "blocks" ? exact.segments[0].blocks : []).toHaveLength(50);

    const withUniqueRow = resolveSlackReplyBlockResolution({
      channelData,
      presentation,
      interactive: {
        blocks: [
          ...(interactive?.blocks ?? []),
          { type: "buttons", buttons: [{ label: "Later", value: "later" }] },
        ],
      },
    });
    expect(withUniqueRow.segments).toHaveLength(2);
    expect(
      withUniqueRow.segments[1]?.kind === "blocks" ? withUniqueRow.segments[1].blocks : [],
    ).toMatchObject([
      {
        block_id: "openclaw_reply_buttons_3",
        elements: [{ action_id: "openclaw:reply_button:3:1", value: "later" }],
      },
    ]);
  });
});
