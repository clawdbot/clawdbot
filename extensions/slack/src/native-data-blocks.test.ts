import { describe, expect, it } from "vitest";
import {
  appendSlackNativeDataFallbackText,
  buildSlackNativeDataAccessibilityText,
  hasSlackNativeDataBlock,
  isSlackInvalidBlocksError,
  renderSlackNativeDataFallbackText,
} from "./native-data-blocks.js";

const chart = {
  type: "data_visualization",
  title: "Revenue mix",
  chart: {
    type: "pie",
    segments: [
      { label: "Product", value: 60 },
      { label: "Services", value: 40 },
    ],
  },
};

const table = {
  type: "data_table",
  caption: "Pipeline report",
  rows: [
    [
      { type: "raw_text", text: "Account" },
      { type: "raw_text", text: "ARR" },
    ],
    [
      { type: "raw_text", text: "Acme" },
      { type: "raw_number", value: 125_000, text: "$125k" },
    ],
  ],
  row_header_column_index: 0,
};

describe("Slack native data blocks", () => {
  it("detects charts and current data tables", () => {
    expect(hasSlackNativeDataBlock([{ type: "section" }])).toBe(false);
    expect(hasSlackNativeDataBlock([chart])).toBe(true);
    expect(hasSlackNativeDataBlock([table])).toBe(true);
  });

  it("matches structural invalid_blocks error responses", () => {
    expect(isSlackInvalidBlocksError({ data: { error: "invalid_blocks" } })).toBe(true);
    expect(isSlackInvalidBlocksError({ data: "invalid_blocks" })).toBe(true);
    expect(isSlackInvalidBlocksError({ response: { data: { error: "invalid_blocks" } } })).toBe(
      true,
    );
    expect(isSlackInvalidBlocksError({ response: { data: "invalid_blocks" } })).toBe(true);
    expect(isSlackInvalidBlocksError({ error: "INVALID_BLOCKS" })).toBe(true);
    expect(isSlackInvalidBlocksError(new Error("invalid_blocks"))).toBe(false);
  });

  it("routes supported blocks to their complete fallback renderers", () => {
    expect(renderSlackNativeDataFallbackText(chart)).toBe(
      "Revenue mix (pie chart)\n- Product: 60\n- Services: 40",
    );
    expect(renderSlackNativeDataFallbackText(table)).toBe(
      "Pipeline report (table)\n- Account: Acme; ARR: $125k",
    );
    expect(renderSlackNativeDataFallbackText({ type: "section" })).toBeUndefined();
  });

  it("escapes raw structured-data tokens before rendering mrkdwn fallbacks", () => {
    expect(
      renderSlackNativeDataFallbackText({
        type: "data_table",
        caption: "<!channel> pipeline",
        rows: [[{ type: "raw_text", text: "Owner" }], [{ type: "raw_text", text: "<@U123>" }]],
      }),
    ).toBe("&lt;!channel&gt; pipeline (table)\n- Owner: &lt;@U123&gt;");
    expect(
      renderSlackNativeDataFallbackText({
        type: "data_visualization",
        title: "<!here> revenue",
        chart: {
          type: "pie",
          segments: [{ label: "<@U456>", value: 1 }],
        },
      }),
    ).toBe("&lt;!here&gt; revenue (pie chart)\n- &lt;@U456&gt;: 1");
  });

  it("appends mixed native data in block order without collapsing repeated blocks", () => {
    const chartText = "Revenue mix (pie chart)\n- Product: 60\n- Services: 40";
    const tableText = "Pipeline report (table)\n- Account: Acme; ARR: $125k";
    const expected = `Overview\n\n${chartText}\n\n${tableText}`;

    expect(appendSlackNativeDataFallbackText("Overview", [chart, table, chart])).toBe(
      `${expected}\n\n${chartText}`,
    );
    expect(appendSlackNativeDataFallbackText(expected, [chart, table])).toBe(expected);
    expect(
      appendSlackNativeDataFallbackText("Revenue mix (pie chart) - Product: 60 - Services: 40", [
        chart,
      ]),
    ).toBe("Revenue mix (pie chart) - Product: 60 - Services: 40");
  });

  it("builds formatting-disabled accessibility in actual block order", () => {
    expect(
      buildSlackNativeDataAccessibilityText("Outside", [
        { type: "section", text: { type: "mrkdwn", text: "Before" } },
        table,
        { type: "section", text: { type: "mrkdwn", text: "After" } },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "private-action",
              text: { type: "plain_text", text: "Approve" },
              value: "private-value",
            },
            {
              type: "users_select",
              action_id: "private-select",
              placeholder: { type: "plain_text", text: "Choose owner" },
            },
          ],
        },
      ]),
    ).toBe(
      [
        "Outside",
        "Before",
        "Pipeline report (table)\nAccount\tARR\nAcme\t$125k",
        "After",
        "Approve\nChoose owner",
      ].join("\n\n"),
    );
  });

  it("keeps plain text objects literal in formatting-disabled accessibility", () => {
    expect(
      buildSlackNativeDataAccessibilityText("", [
        { type: "section", text: { type: "plain_text", text: "1 < 2 & <@U123>" } },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Keep <literal>" },
            },
          ],
        },
        table,
      ]),
    ).toBe(
      [
        "1 < 2 & <@U123>",
        "Keep <literal>",
        "Pipeline report (table)\nAccount\tARR\nAcme\t$125k",
      ].join("\n\n"),
    );
  });

  it("preserves repeated visible blocks even when their text matches the base", () => {
    const chartText = "Revenue mix (pie chart)\n- Product: 60\n- Services: 40";

    expect(buildSlackNativeDataAccessibilityText(chartText, [chart, chart])).toBe(
      [chartText, chartText].join("\n\n"),
    );
    expect(
      buildSlackNativeDataAccessibilityText("Refresh", [
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Refresh" },
              value: "hidden",
            },
          ],
        },
      ]),
    ).toBe("Refresh\n\nRefresh");
  });
});
