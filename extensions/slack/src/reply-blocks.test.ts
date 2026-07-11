import { describe, expect, it } from "vitest";
import { resolveSlackReplyRenderPlan, resolveSlackReplyText } from "./reply-blocks.js";

describe("resolveSlackReplyText", () => {
  it("leaves long plain Markdown on the normal text chunking path", () => {
    const text = `[link](https://example.com) ${"x".repeat(8_100)}`;
    const plan = resolveSlackReplyRenderPlan({ text });

    expect(plan.mode).toBe("single");
    if (plan.mode !== "single") {
      return;
    }
    expect(plan.blocks).toBeUndefined();
    expect(plan.text).toBe(text);
    expect(plan.textIsSlackMrkdwn).toBeUndefined();
  });

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
        "- Run &lt;@U1&gt;: `/say &lt;!channel&gt;`",
        "",
        "Owner &lt;!channel&gt;:",
        "- &lt;@U2&gt;",
      ].join("\n"),
    );
  });

  it("marks non-native portable tables for text fallback while retaining native blocks", () => {
    const payload = {
      channelData: { slack: { blocks: [{ type: "divider" }] } },
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

    expect(resolveSlackReplyRenderPlan(payload)).toEqual({
      mode: "split",
      blockPart: {
        text: "- Refresh",
        blocks: [
          { type: "divider" },
          {
            type: "actions",
            block_id: "openclaw_reply_buttons_1",
            elements: [
              {
                type: "button",
                action_id: "openclaw:reply_button:1:1",
                text: { type: "plain_text", text: "Refresh", emoji: true },
                value: "refresh",
              },
            ],
          },
        ],
      },
      fallbackText: expect.stringContaining("- Account: account-99"),
      hookText: expect.stringContaining("- Account: account-99"),
    });
    expect(resolveSlackReplyText(payload)).toContain("- Account: account-99");
  });

  it("rejects over-limit table fallbacks instead of dropping authored blocks", () => {
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

    expect(() => resolveSlackReplyRenderPlan(payload)).toThrow(
      /Slack blocks cannot exceed 50 items/i,
    );
  });

  it("does not create an empty fallback message for non-textual overflow", () => {
    const plan = resolveSlackReplyRenderPlan({
      channelData: {
        slack: { blocks: Array.from({ length: 50 }, () => ({ type: "divider" })) },
      },
      presentation: { blocks: [{ type: "divider" }] },
    });

    expect(plan.mode).toBe("single");
    if (plan.mode !== "single") {
      return;
    }
    expect(plan.blocks).toHaveLength(50);
    expect(plan.text).toBe("Shared a Block Kit message");
  });

  it("keeps authored text visible before a native table", () => {
    const plan = resolveSlackReplyRenderPlan({
      text: "[Pipeline](https://example.com)",
      presentation: {
        blocks: [{ type: "table", caption: "Pipeline", headers: ["Account"], rows: [["Acme"]] }],
      },
    });

    expect(plan.mode).toBe("single");
    if (plan.mode !== "single") {
      return;
    }
    expect(plan.blocks?.[0]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "<https://example.com|Pipeline>",
        verbatim: true,
      },
    });
    expect(plan.blocks?.[1]).toMatchObject({ type: "data_table", caption: "Pipeline" });
  });

  it("moves long presentation text beside a table to complete fallback", () => {
    const longText = `start-${"x".repeat(3980)}-tail`;
    const plan = resolveSlackReplyRenderPlan({
      presentation: {
        blocks: [
          { type: "text", text: longText },
          { type: "table", caption: "Pipeline", headers: ["Account"], rows: [["Acme"]] },
        ],
      },
    });

    expect(plan.mode).toBe("split");
    if (plan.mode !== "split") {
      return;
    }
    expect(plan.blockPart).toBeUndefined();
    expect(plan.fallbackText).toContain("-tail");
    expect(plan.fallbackText).toContain("Pipeline (table)");
  });

  it("moves standalone overlong presentation text to complete fallback", () => {
    const longText = `standalone-${"x".repeat(3980)}-tail`;
    const plan = resolveSlackReplyRenderPlan({
      presentation: {
        blocks: [
          { type: "text", text: longText },
          { type: "buttons", buttons: [{ label: "Refresh", value: "refresh" }] },
        ],
      },
    });

    expect(plan.mode).toBe("split");
    if (plan.mode !== "split") {
      return;
    }
    expect(plan.blockPart?.text).toBe("- Refresh");
    expect(plan.fallbackText).toContain("-tail");
    expect(plan.fallbackText).not.toContain("- Refresh");
  });

  it("moves an over-limit presentation control row to text fallback", () => {
    const plan = resolveSlackReplyRenderPlan({
      presentation: {
        blocks: [
          { type: "table", caption: "Pipeline", headers: ["Account"], rows: [["Acme"]] },
          {
            type: "buttons",
            buttons: Array.from({ length: 26 }, (_entry, index) => ({
              label: `Action ${String(index + 1)}`,
              value: `action-${String(index + 1)}`,
            })),
          },
        ],
      },
    });

    expect(plan.mode).toBe("split");
    if (plan.mode !== "split") {
      return;
    }
    expect(plan.blockPart).toBeUndefined();
    expect(plan.fallbackText).toContain("- Action 26");
  });

  it("moves standalone over-limit controls to complete text fallback", () => {
    const plan = resolveSlackReplyRenderPlan({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: Array.from({ length: 26 }, (_entry, index) => ({
              label: `Action ${String(index + 1)}`,
              value: `action-${String(index + 1)}`,
            })),
          },
        ],
      },
    });

    expect(plan.mode).toBe("split");
    if (plan.mode !== "split") {
      return;
    }
    expect(plan.blockPart).toBeUndefined();
    expect(plan.fallbackText).toContain("- Action 26");
  });

  it("preserves safe command bytes and drops unsafe code-span fallbacks", () => {
    const plan = resolveSlackReplyRenderPlan({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Deny",
                action: {
                  type: "command",
                  command: "/approve req_1 deny & <@U123>",
                },
              },
              {
                label: "Backtick",
                action: { type: "command", command: "/run `unsafe` <!channel>" },
              },
              {
                label: "Multiline",
                action: { type: "command", command: "/run\n<!channel>" },
              },
              {
                label: "Overlong",
                action: { type: "command", command: `/${"x".repeat(3_000)}` },
              },
              {
                label: "Backslash",
                action: { type: "command", command: "/path\\" },
              },
              {
                label: "Line\nbreak",
                action: { type: "command", command: "/status" },
              },
              ...Array.from({ length: 20 }, (_entry, index) => ({
                label: `Action ${String(index + 7)}`,
                value: `action-${String(index + 7)}`,
              })),
            ],
          },
        ],
      },
    });

    expect(plan.mode).toBe("split");
    if (plan.mode !== "split") {
      return;
    }
    expect(plan.fallbackText).toContain("- Deny: `/approve req_1 deny &amp; &lt;@U123&gt;`");
    expect(plan.fallbackText).not.toContain("req\\_1");
    expect(plan.fallbackText).toContain("- Backtick");
    expect(plan.fallbackText).toContain("- Multiline");
    expect(plan.fallbackText).toContain("- Overlong");
    expect(plan.fallbackText).toContain("- Backslash");
    expect(plan.fallbackText).toContain("- Line\nbreak");
    expect(plan.fallbackText).not.toContain("`unsafe`");
    expect(plan.fallbackText).not.toContain("<!channel>");
    expect(plan.fallbackText).not.toContain("x".repeat(3_000));
    expect(plan.fallbackText).not.toContain("/path\\");
    expect(plan.fallbackText).not.toContain("`/status`");
  });

  it("splits a valid native chart when its complete fallback exceeds 8k", () => {
    const categories = Array.from({ length: 20 }, (_entry, index) =>
      `Category-${String(index)}`.padEnd(20, "x"),
    );
    const plan = resolveSlackReplyRenderPlan({
      presentation: {
        blocks: [
          {
            type: "chart",
            chartType: "bar",
            title: "Large revenue report",
            categories,
            series: Array.from({ length: 12 }, (_entry, index) => ({
              name: `Series-${String(index)}`.padEnd(20, "x"),
              values: categories.map(() => Number.MAX_VALUE),
            })),
          },
        ],
      },
    });

    expect(plan.mode).toBe("split");
    if (plan.mode !== "split") {
      return;
    }
    expect(plan.blockPart).toBeUndefined();
    expect(plan.fallbackText).toContain("Series-11");
    expect(plan.fallbackText.length).toBeGreaterThan(8_000);
  });

  it("keeps the first two charts native and falls back only the overflow", () => {
    const plan = resolveSlackReplyRenderPlan({
      presentation: {
        blocks: [
          {
            type: "chart",
            chartType: "pie",
            title: "Revenue mix",
            segments: [{ label: "Product", value: 60 }],
          },
          {
            type: "chart",
            chartType: "pie",
            title: "Active accounts",
            segments: [{ label: "Paid", value: 40 }],
          },
          {
            type: "chart",
            chartType: "pie",
            title: "Active sessions",
            segments: [{ label: "Desktop", value: 30 }],
          },
        ],
      },
    });

    expect(plan.mode).toBe("single");
    if (plan.mode !== "single") {
      return;
    }
    expect(plan.blocks?.map((block) => block.type)).toEqual([
      "data_visualization",
      "data_visualization",
      "context",
    ]);
    expect(plan.blocks?.[2]).toMatchObject({
      type: "context",
      elements: [{ text: expect.stringContaining("Active sessions") }],
    });
    expect(plan.text).toContain("Revenue mix");
    expect(plan.text).toContain("Active accounts");
    expect(plan.text).toContain("Active sessions");
  });

  it("counts raw charts before retaining portable charts", () => {
    const plan = resolveSlackReplyRenderPlan({
      channelData: {
        slack: {
          blocks: [
            {
              type: "data_visualization",
              title: "Raw traffic",
              chart: {
                type: "pie",
                segments: [{ label: "Direct", value: 50 }],
              },
            },
          ],
        },
      },
      presentation: {
        blocks: [
          {
            type: "chart",
            chartType: "pie",
            title: "Revenue mix",
            segments: [{ label: "Product", value: 60 }],
          },
          {
            type: "chart",
            chartType: "pie",
            title: "Active sessions",
            segments: [{ label: "Desktop", value: 30 }],
          },
        ],
      },
    });

    expect(plan.mode).toBe("single");
    if (plan.mode !== "single") {
      return;
    }
    expect(plan.blocks?.map((block) => block.type)).toEqual([
      "data_visualization",
      "data_visualization",
      "context",
    ]);
    expect(plan.blocks?.[2]).toMatchObject({
      type: "context",
      elements: [{ text: expect.stringContaining("Active sessions") }],
    });
    expect(plan.text).toContain("Raw traffic");
    expect(plan.text).toContain("Revenue mix");
    expect(plan.text).toContain("Active sessions");
  });

  it("keeps a native-eligible table when its rendered fallback exceeds 8k", () => {
    const rows = Array.from({ length: 100 }, (_entry, index) => [
      index === 0 ? "<@U123>" : `account-${String(index)} ${"x".repeat(65)}`,
    ]);
    const plan = resolveSlackReplyRenderPlan({
      text: "Pipeline summary",
      presentation: {
        title: "Quarterly report",
        blocks: [
          { type: "context", text: "Confidential" },
          { type: "table", caption: "Pipeline", headers: ["Account"], rows },
          { type: "buttons", buttons: [{ label: "Refresh", value: "refresh" }] },
        ],
      },
    });

    expect(plan.mode).toBe("split");
    if (plan.mode !== "split") {
      return;
    }
    expect(plan.blockPart?.blocks.map((block) => block.type)).toEqual(["data_table", "actions"]);
    expect(plan.blockPart?.text).toBe("Pipeline (table)\n\n- Refresh");
    expect(plan.blockPart?.text.length).toBeLessThanOrEqual(8_000);
    expect(plan.fallbackText).toContain("Quarterly report");
    expect(plan.fallbackText).toContain("Confidential");
    expect(plan.fallbackText).toContain("- Account: account-99");
    expect(plan.fallbackText.match(/Pipeline \(table\)/g)).toHaveLength(1);
    expect(plan.fallbackText).not.toContain("- Refresh");
  });

  it("compacts native table accessibility text at the active chunk limit", () => {
    const header = "H".repeat(1_000);
    const plan = resolveSlackReplyRenderPlan(
      {
        presentation: {
          blocks: [
            {
              type: "table",
              caption: "Pipeline",
              headers: [header],
              rows: Array.from({ length: 5 }, (_entry, index) => [String(index)]),
            },
          ],
        },
      },
      undefined,
      { textLimit: 4_000 },
    );

    expect(plan.mode).toBe("split");
    if (plan.mode !== "split") {
      return;
    }
    expect(plan.blockPart?.text).toBe("Pipeline (table)");
    expect(plan.blockPart?.text.length).toBeLessThanOrEqual(4_000);
    expect(plan.fallbackText).toContain(": 4");
  });

  it("falls back a native-eligible table when its compact caption exceeds 8k", () => {
    const caption = "c".repeat(8_100);
    const plan = resolveSlackReplyRenderPlan({
      presentation: {
        blocks: [
          { type: "table", caption, headers: ["Account"], rows: [["Acme"]] },
          { type: "buttons", buttons: [{ label: "Refresh", value: "refresh" }] },
        ],
      },
    });

    expect(plan.mode).toBe("split");
    if (plan.mode !== "split") {
      return;
    }
    expect(plan.blockPart?.blocks.map((block) => block.type)).toEqual(["actions"]);
    expect(plan.blockPart?.text).toBe("- Refresh");
    expect(plan.fallbackText).toContain(`${caption} (table)`);
    expect(plan.fallbackText).toContain("- Account: Acme");
  });

  it("escapes plain-text control labels in split accessibility fallbacks", () => {
    const plan = resolveSlackReplyRenderPlan({
      presentation: {
        blocks: [
          {
            type: "table",
            caption: "Pipeline",
            headers: ["Account"],
            rows: Array.from({ length: 100 }, (_entry, index) => [
              `account-${String(index)}-${"x".repeat(110)}`,
            ]),
          },
          { type: "buttons", buttons: [{ label: "<!here>", value: "refresh" }] },
        ],
      },
    });

    expect(plan.mode).toBe("split");
    if (plan.mode !== "split") {
      return;
    }
    expect(plan.blockPart?.text).toBe("- &lt;!here&gt;");
    expect(plan.blockPart?.text).not.toContain("<!here>");
  });

  it("keeps section fields and rich text in split accessibility fallbacks", () => {
    const plan = resolveSlackReplyRenderPlan({
      channelData: {
        slack: {
          blocks: [
            {
              type: "section",
              fields: [
                { type: "plain_text", text: "Owner <!here>" },
                { type: "mrkdwn", text: "*Ready*" },
              ],
            },
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    { type: "text", text: "Rich <!channel> " },
                    { type: "user", user_id: "U123" },
                  ],
                },
              ],
            },
            {
              type: "section",
              text: { type: "mrkdwn", text: "Overview" },
              accessory: {
                type: "button",
                action_id: "open",
                text: { type: "plain_text", text: "Open" },
                value: "open",
              },
            },
          ],
        },
      },
      presentation: {
        blocks: [
          {
            type: "table",
            caption: "Pipeline",
            headers: ["Account"],
            rows: Array.from({ length: 100 }, (_entry, index) => [
              `account-${String(index)}-${"x".repeat(110)}`,
            ]),
          },
        ],
      },
    });

    expect(plan.mode).toBe("split");
    if (plan.mode !== "split") {
      return;
    }
    expect(plan.blockPart?.text).toBe(
      "Owner &lt;!here&gt;\n*Ready*\n\nRich &lt;!channel&gt; <@U123>\n\nOverview\n- Open",
    );
  });

  it("fails closed when retained raw-block accessibility exceeds 8k", () => {
    const blocks = Array.from({ length: 3 }, (_entry, index) => ({
      type: "image",
      image_url: `https://example.com/${String(index)}.png`,
      alt_text: `${String(index)}${"x".repeat(2999)}`,
    }));

    expect(() =>
      resolveSlackReplyRenderPlan({
        channelData: { slack: { blocks } },
        presentation: {
          blocks: [
            {
              type: "table",
              caption: "Large pipeline",
              headers: ["Account"],
              rows: Array.from({ length: 100 }, (_entry, index) => [
                `account-${String(index)} ${"x".repeat(110)}`,
              ]),
            },
          ],
        },
      }),
    ).toThrow(/retained-block accessibility fallback exceeds/i);
  });

  it("moves overlong raw text blocks to visible fallback chunks", () => {
    const blocks = Array.from({ length: 3 }, (_entry, index) => ({
      type: "section",
      text: { type: "mrkdwn", text: `${String(index)}${"x".repeat(2999)}-tail` },
    }));

    const plan = resolveSlackReplyRenderPlan({ channelData: { slack: { blocks } } });

    expect(plan.mode).toBe("split");
    if (plan.mode !== "split") {
      return;
    }
    expect(plan.blockPart).toBeUndefined();
    expect(plan.fallbackText).toContain("2xxx");
    expect(plan.fallbackText).toContain("-tail");
    expect(plan.fallbackText.length).toBeGreaterThan(8_000);
  });

  it("retains image and mixed-media contexts when sibling text moves to fallback", () => {
    const imageOnlyContext = {
      type: "context",
      elements: [
        {
          type: "image",
          image_url: "https://example.com/status.png",
          alt_text: "Status",
        },
      ],
    };
    const mixedContext = {
      type: "context",
      elements: [
        { type: "mrkdwn", text: "Status summary" },
        {
          type: "image",
          image_url: "https://example.com/detail.png",
          alt_text: "Detail",
        },
      ],
    };
    const textBlocks = Array.from({ length: 3 }, (_entry, index) => ({
      type: "section",
      text: { type: "mrkdwn", text: `${String(index)}${"x".repeat(2994)}-tail` },
    }));

    const plan = resolveSlackReplyRenderPlan({
      channelData: {
        slack: { blocks: [imageOnlyContext, mixedContext, ...textBlocks] },
      },
    });

    expect(plan.mode).toBe("split");
    if (plan.mode !== "split") {
      return;
    }
    expect(plan.blockPart).toEqual({
      blocks: [imageOnlyContext, mixedContext],
      text: "Status summary",
    });
    expect(plan.fallbackText).toContain("2xxx");
    expect(plan.fallbackText).toContain("-tail");
    expect(plan.fallbackText).not.toContain("Status summary");
  });

  it("converts authored Markdown before splitting around raw blocks", () => {
    const plan = resolveSlackReplyRenderPlan({
      text: `[docs](https://example.com) ${"x".repeat(8_100)}`,
      channelData: {
        slack: {
          blocks: [
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  action_id: "refresh",
                  text: { type: "plain_text", text: "Refresh" },
                  value: "refresh",
                },
              ],
            },
          ],
        },
      },
    });

    expect(plan.mode).toBe("split");
    if (plan.mode !== "split") {
      return;
    }
    expect(plan.blockPart?.text).toBe("- Refresh");
    expect(plan.fallbackText).toContain("<https://example.com|docs>");
    expect(plan.fallbackText).not.toContain("[docs](https://example.com)");
  });

  it("keeps a long portable sibling complete beside a raw native table", () => {
    const longText = `raw-table-sibling-${"x".repeat(3980)}-tail`;
    const plan = resolveSlackReplyRenderPlan({
      channelData: {
        slack: {
          blocks: [
            {
              type: "data_table",
              caption: "Raw pipeline",
              rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
            },
          ],
        },
      },
      presentation: { blocks: [{ type: "text", text: longText }] },
    });

    expect(plan.mode).toBe("split");
    if (plan.mode !== "split") {
      return;
    }
    expect(plan.blockPart).toBeUndefined();
    expect(plan.fallbackText).toContain("-tail");
    expect(plan.fallbackText).toContain("Raw pipeline (table)");
    expect(plan.hookText).toContain("-tail");
  });
});
