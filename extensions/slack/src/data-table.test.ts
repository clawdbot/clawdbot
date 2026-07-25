import { describe, expect, it } from "vitest";
import {
  buildSlackDataTableBlock,
  countSlackDataTableBlocksCellCharacters,
  countSlackDataTableCellCharacters,
  hasSlackDataTableBlock,
  renderSlackDataTableCompactPlainTextFallback,
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
    expect(buildSlackDataTableBlock(base)).toBeDefined();
    expect(
      buildSlackDataTableBlock({
        ...base,
        headers: Array.from({ length: 21 }, (_, index) => `H${String(index)}`),
        rows: [Array.from({ length: 21 }, () => "value")],
      }),
    ).toBeUndefined();
    expect(
      buildSlackDataTableBlock({
        ...base,
        rows: Array.from({ length: 101 }, () => ["value"]),
      }),
    ).toBeUndefined();
    expect(
      buildSlackDataTableBlock(base, {
        cellCharacterCountOffset: SLACK_DATA_TABLE_CELL_CHARACTERS_MAX - 7,
      }),
    ).toBeDefined();
    expect(
      buildSlackDataTableBlock(base, {
        cellCharacterCountOffset: SLACK_DATA_TABLE_CELL_CHARACTERS_MAX - 6,
      }),
    ).toBeUndefined();
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

  it("renders a compact formatting-disabled fallback with each cell once", () => {
    expect(
      renderSlackDataTableCompactPlainTextFallback({
        type: "data_table",
        caption: "Pipeline report",
        rows: [
          [
            { type: "raw_text", text: "Owner <!channel>" },
            { type: "raw_text", text: "Link" },
          ],
          [
            { type: "raw_text", text: "<@U1> & `literal`" },
            { type: "raw_text", text: "<https://example.com|open>" },
          ],
        ],
      }),
    ).toBe(
      [
        "Pipeline report (table)",
        "Owner <!channel>\tLink",
        "<@U1> & `literal`\t<https://example.com|open>",
      ].join("\n"),
    );
  });

  it("reversibly escapes one-line table delimiters without collapsing authored whitespace", () => {
    expect(
      renderSlackDataTableCompactPlainTextFallback({
        type: "data_table",
        caption: " Path\\root\t\r\n  ",
        rows: [
          [
            { type: "raw_text", text: "A  B" },
            { type: "raw_text", text: "Column\tTwo" },
          ],
          [
            { type: "raw_text", text: "line1\nline2\\tail" },
            { type: "raw_text", text: "keep  spaces" },
          ],
        ],
      }),
    ).toBe(
      [
        " Path\\\\root\\t\\r\\n   (table)",
        "A  B\tColumn\\tTwo",
        "line1\\nline2\\\\tail\tkeep  spaces",
      ].join("\n"),
    );
  });

  it("rejects raw native tables outside Slack's documented bounds", () => {
    const rows = Array.from({ length: 100 }, () => [{ type: "raw_text", text: "x" }]);
    expect(
      countSlackDataTableCellCharacters({
        type: "data_table",
        caption: "At limit",
        rows: [[{ type: "raw_text", text: "&".repeat(9_900) }], ...rows],
      }),
    ).toBe(10_000);
    const overCharacterLimit = {
      type: "data_table",
      caption: "Over limit",
      rows: [[{ type: "raw_text", text: "&".repeat(9_901) }], ...rows],
    };
    expect(countSlackDataTableCellCharacters(overCharacterLimit)).toBeUndefined();
    expect(renderSlackDataTableCompactPlainTextFallback(overCharacterLimit)).toContain(
      "&".repeat(9_901),
    );

    const overRowLimit = {
      type: "data_table",
      caption: "Too many rows",
      rows: [
        [{ type: "raw_text", text: "Value" }],
        ...Array.from({ length: 101 }, (_entry, index) => [
          { type: "raw_text", text: `row-${String(index)}` },
        ]),
      ],
    };
    expect(countSlackDataTableCellCharacters(overRowLimit)).toBeUndefined();
    expect(renderSlackDataTableCompactPlainTextFallback(overRowLimit)).toContain("row-100");
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
