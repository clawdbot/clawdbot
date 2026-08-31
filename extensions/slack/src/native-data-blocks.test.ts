import { Response as UndiciResponse } from "undici";
import { describe, expect, it, vi } from "vitest";
import {
  appendSlackNativeDataFallbackText,
  buildSlackNativeDataAccessibilityText,
  hasSlackNativeDataBlock,
  isSlackInvalidBlocksError,
  isSlackInvalidBlocksResponse,
  isSlackNativeResponseUrlRejection,
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

  it("matches Bolt 5 response_url responses and contextual RespondError failures", async () => {
    const response = new Response(JSON.stringify({ error: "invalid_blocks" }), { status: 200 });
    await expect(isSlackInvalidBlocksResponse(response)).resolves.toBe(true);
    await expect(
      isSlackInvalidBlocksResponse(
        new UndiciResponse(JSON.stringify({ error: "invalid_blocks" }), { status: 200 }),
      ),
    ).resolves.toBe(true);
    await expect(isSlackInvalidBlocksResponse(new Response("ok"))).resolves.toBe(false);
    expect(
      isSlackNativeResponseUrlRejection({
        code: "slack_bolt_respond_error",
        statusCode: 400,
      }),
    ).toBe(true);
    expect(
      isSlackNativeResponseUrlRejection({
        code: "slack_bolt_respond_error",
        statusCode: 500,
      }),
    ).toBe(false);
  });

  it("bounds stalled response_url body inspection and cancels its reader", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(async () => undefined);
      const releaseLock = vi.fn();
      const response = {
        status: 200,
        body: {
          getReader: () => ({
            read: async () => await new Promise<never>(() => {}),
            cancel,
            releaseLock,
          }),
        },
      };

      const inspection = isSlackInvalidBlocksResponse(response);
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(inspection).resolves.toBe(false);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds oversized response_url bodies and cancels after the prefix", async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const response = {
      status: 200,
      body: {
        getReader: () => ({
          read: async () => ({
            done: false,
            value: new TextEncoder().encode("x".repeat(32 * 1024)),
          }),
          cancel,
          releaseLock,
        }),
      },
    };

    await expect(isSlackInvalidBlocksResponse(response)).resolves.toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
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
