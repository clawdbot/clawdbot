import { describe, expect, it } from "vitest";
import { chooseSlackPrimaryText, resolveSlackBlocksText } from "./block-text.js";

describe("resolveSlackBlocksText data visualizations", () => {
  it("uses the shared visible-text parser for rich text, fields, and controls", () => {
    const resolved = resolveSlackBlocksText([
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "text", text: "Ask " },
              { type: "user", user_id: "U123" },
            ],
          },
        ],
      },
      {
        type: "section",
        text: { type: "plain_text", text: "Deploy" },
        fields: [{ type: "plain_text", text: "Healthy" }],
      },
      {
        type: "actions",
        block_id: "private-block",
        elements: [
          {
            type: "workflow_button",
            text: { type: "plain_text", text: "Run workflow" },
            action_id: "private-action",
            workflow: { trigger: { url: "https://example.com/private" } },
          },
          {
            type: "static_select",
            placeholder: { type: "plain_text", text: "Choose owner" },
            action_id: "private-select",
            options: [
              { text: { type: "plain_text", text: "Hidden option" }, value: "private-value" },
            ],
          },
        ],
      },
    ]);

    expect(resolved).toEqual({
      text: "Ask &lt;@U123&gt;\nDeploy\nHealthy\nRun workflow\nChoose owner",
      hasRichText: true,
      hasNativeData: false,
    });
    expect(resolved?.text).not.toMatch(/private|Hidden option/u);
  });

  it("preserves native chart values in inbound conversation context", () => {
    expect(
      resolveSlackBlocksText([
        {
          type: "data_visualization",
          title: "Weekly latency",
          chart: {
            type: "line",
            series: [
              {
                name: "p95",
                data: [
                  { label: "Mon", value: 250 },
                  { label: "Tue", value: 230 },
                ],
              },
            ],
            axis_config: {
              categories: ["Mon", "Tue"],
              x_label: "Day",
              y_label: "Milliseconds",
            },
          },
        },
      ]),
    ).toEqual({
      text: [
        "Weekly latency (line chart)",
        "X axis: Day",
        "Y axis: Milliseconds",
        "- p95: Mon: 250; Tue: 230",
      ].join("\n"),
      hasRichText: false,
      hasNativeData: true,
    });
  });

  it("preserves native table values in inbound conversation context", () => {
    expect(
      resolveSlackBlocksText([
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
      ]),
    ).toEqual({
      text: "Pipeline report (table)\n- Account: Acme; ARR: $125k",
      hasRichText: false,
      hasNativeData: true,
    });
  });

  it("keeps top-level message text alongside native chart details", () => {
    const blocksText = resolveSlackBlocksText([
      {
        type: "data_visualization",
        title: "Weekly latency",
        chart: {
          type: "line",
          series: [
            {
              name: "p95",
              data: [
                { label: "Mon", value: 250 },
                { label: "Tue", value: 230 },
              ],
            },
          ],
          axis_config: { categories: ["Mon", "Tue"] },
        },
      },
    ]);

    expect(
      chooseSlackPrimaryText({
        messageText: "Here is the requested latency trend.",
        blocksText,
      }),
    ).toBe(
      [
        "Here is the requested latency trend.",
        "Weekly latency (line chart)",
        "- p95: Mon: 250; Tue: 230",
      ].join("\n"),
    );
  });

  it("does not duplicate top-level text already represented before a chart", () => {
    const blocksText = resolveSlackBlocksText([
      { type: "section", text: { type: "mrkdwn", text: "Latency report" } },
      {
        type: "data_visualization",
        title: "Weekly latency",
        chart: {
          type: "line",
          series: [{ name: "p95", data: [{ label: "Mon", value: 250 }] }],
          axis_config: { categories: ["Mon"] },
        },
      },
    ]);

    expect(chooseSlackPrimaryText({ messageText: "Latency report", blocksText })).toBe(
      "Latency report\nWeekly latency (line chart)\n- p95: Mon: 250",
    );
  });

  it("does not duplicate chart data when top-level text uses paragraph spacing", () => {
    const blocksText = resolveSlackBlocksText([
      { type: "section", text: { type: "mrkdwn", text: "Latency report" } },
      {
        type: "data_visualization",
        title: "Weekly latency",
        chart: {
          type: "line",
          series: [{ name: "p95", data: [{ label: "Mon", value: 250 }] }],
          axis_config: { categories: ["Mon"] },
        },
      },
    ]);
    const messageText = "Latency report\n\nWeekly latency (line chart)\n- p95: Mon: 250";

    expect(chooseSlackPrimaryText({ messageText, blocksText })).toBe(messageText);
  });
});
