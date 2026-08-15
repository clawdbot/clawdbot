// QA Lab Slack invalid-blocks fallback fixture.
import { randomUUID } from "node:crypto";
import {
  SLACK_QA_INVALID_TABLE_DATA_ROW_COUNT,
  SLACK_QA_INVALID_TABLE_CAPTION,
  SLACK_QA_INVALID_TABLE_HEADERS,
} from "./slack-live.contracts.js";

function buildSlackInvalidBlocksTableRow(index: number) {
  const rowId = String(index).padStart(3, "0");
  // Keep the fallback large enough to catch accidental truncation.
  return [`row-${rowId}`, `value-${rowId}-${"x".repeat(96)}`] as const;
}

export function buildSlackInvalidBlocksTableProbe() {
  const summaryText = `SLACK_QA_TABLE_INVALID_BLOCKS_${randomUUID().slice(0, 8).toUpperCase()}`;
  const dataRows = Array.from({ length: SLACK_QA_INVALID_TABLE_DATA_ROW_COUNT }, (_entry, index) =>
    buildSlackInvalidBlocksTableRow(index + 1),
  );
  const block = {
    type: "data_table",
    caption: SLACK_QA_INVALID_TABLE_CAPTION,
    rows: [
      SLACK_QA_INVALID_TABLE_HEADERS.map((text) => ({ type: "raw_text", text })),
      ...dataRows.map((row) => row.map((text) => ({ type: "raw_text", text }))),
    ],
    row_header_column_index: 0,
  } as const;
  const fallbackText = [
    summaryText,
    "",
    `${SLACK_QA_INVALID_TABLE_CAPTION} (table)`,
    SLACK_QA_INVALID_TABLE_HEADERS.join("\t"),
    ...dataRows.map((row) => row.join("\t")),
  ].join("\n");
  const cellCharacterCount = [...SLACK_QA_INVALID_TABLE_HEADERS, ...dataRows.flat()].reduce(
    (total, value) => total + Array.from(value).length,
    0,
  );
  return {
    block,
    cellCharacterCount,
    dataRowCount: dataRows.length,
    fallbackText,
    firstRowText: buildSlackInvalidBlocksTableRow(1).join("\t"),
    finalRowText: buildSlackInvalidBlocksTableRow(SLACK_QA_INVALID_TABLE_DATA_ROW_COUNT).join("\t"),
    summaryText,
  };
}
