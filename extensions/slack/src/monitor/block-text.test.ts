import { describe, expect, it } from "vitest";
import { chooseSlackPrimaryText, resolveSlackBlocksText } from "./block-text.js";

describe("resolveSlackBlocksText data visualizations", () => {
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
      hasDataVisualization: true,
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
