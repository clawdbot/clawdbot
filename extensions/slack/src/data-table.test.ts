import { describe, expect, it } from "vitest";
import {
  buildSlackDataTableBlock,
  canRenderSlackDataTable,
  countSlackDataTableBlocksCellCharacters,
  countSlackDataTableCellCharacters,
  hasSlackDataTableBlock,
  renderSlackDataTableFallbackText,
  SLACK_DATA_TABLE_CELL_CHARACTERS_MAX,
} from "./data-table.js";

describe("Slack data table blocks", () => {
  it("maps portable cells to Slack's current native shape", () => {
    expect(
      buildSlackDataTableBlock({
        type: "table",
        caption: "Pipeline report",
        headers: ["Account", "Stage", "ARR"],
        rows: [
          ["Acme", "Won", 125_000],
          ["Globex", "Review", 82_000],
        ],
        rowHeaderColumnIndex: 0,
      }),
    ).toEqual({
      type: "data_table",
      caption: "Pipeline report",
      rows: [
        [
          { type: "raw_text", text: "Account" },
          { type: "raw_text", text: "Stage" },
          { type: "raw_text", text: "ARR" },
        ],
        [
          { type: "raw_text", text: "Acme" },
          { type: "raw_text", text: "Won" },
          { type: "raw_number", value: 125_000, text: "125000" },
        ],
        [
          { type: "raw_text", text: "Globex" },
          { type: "raw_text", text: "Review" },
          { type: "raw_number", value: 82_000, text: "82000" },
        ],
      ],
      row_header_column_index: 0,
    });
  });

  it("enforces Slack's column, data-row, and aggregate character limits", () => {
    const base = {
      type: "table" as const,
      caption: "Limits",
      headers: ["Value"],
      rows: [["ok"]],
    };
    expect(canRenderSlackDataTable(base)).toBe(true);
    expect(
      canRenderSlackDataTable({
        ...base,
        headers: Array.from({ length: 21 }, (_, index) => `H${String(index)}`),
        rows: [Array.from({ length: 21 }, () => "value")],
      }),
    ).toBe(false);
    expect(
      canRenderSlackDataTable({
        ...base,
        rows: Array.from({ length: 101 }, () => ["value"]),
      }),
    ).toBe(false);
    expect(
      canRenderSlackDataTable(base, {
        cellCharacterCountOffset: SLACK_DATA_TABLE_CELL_CHARACTERS_MAX - 7,
      }),
    ).toBe(true);
    expect(
      canRenderSlackDataTable(base, {
        cellCharacterCountOffset: SLACK_DATA_TABLE_CELL_CHARACTERS_MAX - 6,
      }),
    ).toBe(false);
  });

  it("counts display text across raw tables and reports malformed native tables", () => {
    const table = {
      type: "data_table",
      caption: "Values",
      rows: [
        [{ type: "raw_text", text: "Name" }],
        [{ type: "raw_number", value: 125_000, text: "$125k" }],
      ],
    };
    expect(countSlackDataTableCellCharacters(table)).toBe(9);
    expect(countSlackDataTableBlocksCellCharacters([{ type: "section" }, table, table])).toBe(18);
    expect(
      countSlackDataTableBlocksCellCharacters([
        table,
        { type: "data_table", caption: "Broken", rows: [] },
      ]),
    ).toBeUndefined();
  });

  it("extracts complete raw-number and rich-text display values for fallback", () => {
    expect(
      renderSlackDataTableFallbackText({
        type: "data_table",
        caption: "Pipeline report",
        rows: [
          [
            { type: "raw_text", text: "Account" },
            { type: "raw_text", text: "ARR" },
            { type: "raw_text", text: "Owner" },
          ],
          [
            { type: "raw_text", text: "Acme" },
            { type: "raw_number", value: 125_000, text: "$125k" },
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    { type: "user", user_id: "U123" },
                    { type: "text", text: " ready" },
                  ],
                },
              ],
            },
          ],
        ],
        row_header_column_index: 0,
      }),
    ).toBe("Pipeline report (table)\n- Account: Acme; ARR: $125k; Owner: <@U123> ready");
  });

  it("detects native tables and keeps a caption fallback for malformed raw blocks", () => {
    expect(hasSlackDataTableBlock([{ type: "section" }])).toBe(false);
    expect(hasSlackDataTableBlock([{ type: "data_table" }])).toBe(true);
    expect(
      renderSlackDataTableFallbackText({
        type: "data_table",
        caption: "  Provider table  ",
        rows: [],
      }),
    ).toBe("Provider table");
  });
});
