// Slack data_table Block Kit contract, projection, and text fallback.
import type { Block } from "@slack/web-api";
import {
  renderMessagePresentationTableFallbackText,
  type MessagePresentationTableBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";
import { renderSlackMessagePresentationTableFallbackText } from "./presentation-fallback.js";

const SLACK_DATA_TABLE_COLUMNS_MAX = 20;
const SLACK_DATA_TABLE_ROWS_MAX = 100;
export const SLACK_DATA_TABLE_CELL_CHARACTERS_MAX = 10_000;

type SlackDataTableRawTextCell = {
  type: "raw_text";
  text: string;
};

type SlackDataTableRawNumberCell = {
  type: "raw_number";
  value: number;
  text: string;
};

type SlackDataTableCell = SlackDataTableRawTextCell | SlackDataTableRawNumberCell;

type SlackDataTableBlock = Block & {
  type: "data_table";
  caption: string;
  rows: SlackDataTableCell[][];
  row_header_column_index?: number;
};

type SlackDataTableBuildOptions = {
  cellCharacterCountOffset?: number;
};

type ParsedSlackDataTable = {
  caption: string;
  headers: string[];
  rows: string[][];
  cellCharacterCount: number;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function countCharacters(value: string): number {
  return Array.from(value).length;
}

function readRichTextLeaf(record: Record<string, unknown>): string {
  const text = readNonEmptyString(record.text);
  if (text) {
    return text;
  }
  switch (record.type) {
    case "link":
      return readNonEmptyString(record.url) ?? "";
    case "user": {
      const userId = readNonEmptyString(record.user_id);
      return userId ? `<@${userId}>` : "";
    }
    case "channel": {
      const channelId = readNonEmptyString(record.channel_id);
      return channelId ? `<#${channelId}>` : "";
    }
    case "usergroup": {
      const usergroupId = readNonEmptyString(record.usergroup_id);
      return usergroupId ? `<!subteam^${usergroupId}>` : "";
    }
    case "broadcast": {
      const range = readNonEmptyString(record.range);
      return range ? `<!${range}>` : "";
    }
    case "emoji": {
      const name = readNonEmptyString(record.name);
      return name ? `:${name}:` : "";
    }
    case "date":
      return readNonEmptyString(record.fallback) ?? "";
    default:
      return "";
  }
}

function readRichTextElements(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  const parts: string[] = [];
  for (const rawElement of value) {
    const element = asRecord(rawElement);
    if (!element) {
      continue;
    }
    if (Array.isArray(element.elements)) {
      const rendered = readRichTextElements(element.elements);
      if (rendered) {
        parts.push(rendered);
      }
      continue;
    }
    const rendered = readRichTextLeaf(element);
    if (rendered) {
      parts.push(rendered);
    }
  }
  return parts.join("");
}

function readSlackDataTableCell(value: unknown, allowRichText: boolean): string | undefined {
  const cell = asRecord(value);
  if (!cell) {
    return undefined;
  }
  if (cell.type === "raw_text") {
    return readNonEmptyString(cell.text);
  }
  if (cell.type === "raw_number") {
    return typeof cell.value === "number" && Number.isFinite(cell.value)
      ? readNonEmptyString(cell.text)
      : undefined;
  }
  if (allowRichText && cell.type === "rich_text") {
    return readNonEmptyString(readRichTextElements(cell.elements));
  }
  return undefined;
}

function parseSlackDataTable(
  value: unknown,
  options: { enforceNativeLimits?: boolean } = {},
): ParsedSlackDataTable | undefined {
  const block = asRecord(value);
  const caption = readNonEmptyString(block?.caption);
  if (block?.type !== "data_table" || !caption || !Array.isArray(block.rows)) {
    return undefined;
  }
  if (block.rows.length < 2) {
    return undefined;
  }
  const rawHeader = block.rows[0];
  if (!Array.isArray(rawHeader) || rawHeader.length < 1) {
    return undefined;
  }
  const headers = rawHeader.map((cell) => readSlackDataTableCell(cell, false));
  if (!headers.every((header): header is string => Boolean(header))) {
    return undefined;
  }
  const rows = block.rows.slice(1).map((rawRow) => {
    if (!Array.isArray(rawRow) || rawRow.length !== headers.length) {
      return undefined;
    }
    const cells = rawRow.map((cell) => readSlackDataTableCell(cell, true));
    return cells.every((cell): cell is string => Boolean(cell)) ? cells : undefined;
  });
  if (!rows.every((row): row is string[] => Boolean(row))) {
    return undefined;
  }
  const cellCharacterCount = [...headers, ...rows.flat()].reduce(
    (total, cell) => total + countCharacters(cell),
    0,
  );
  if (
    options.enforceNativeLimits &&
    (block.rows.length > SLACK_DATA_TABLE_ROWS_MAX + 1 ||
      headers.length > SLACK_DATA_TABLE_COLUMNS_MAX ||
      cellCharacterCount > SLACK_DATA_TABLE_CELL_CHARACTERS_MAX)
  ) {
    return undefined;
  }
  return { caption, headers, rows, cellCharacterCount };
}

/** Detect current native table blocks without depending on unreleased Slack SDK types. */
export function hasSlackDataTableBlock(blocks?: readonly unknown[]): boolean {
  return blocks?.some((block) => asRecord(block)?.type === "data_table") ?? false;
}

/** Count display characters in one structurally valid native table. */
export function countSlackDataTableCellCharacters(value: SlackDataTableBlock): number;
export function countSlackDataTableCellCharacters(value: unknown): number | undefined;
export function countSlackDataTableCellCharacters(value: unknown): number | undefined {
  return parseSlackDataTable(value, { enforceNativeLimits: true })?.cellCharacterCount;
}

/** Count the aggregate native-table cell characters already present in a message. */
export function countSlackDataTableBlocksCellCharacters(
  blocks?: readonly unknown[],
): number | undefined {
  let total = 0;
  for (const block of blocks ?? []) {
    if (!hasSlackDataTableBlock([block])) {
      continue;
    }
    const cellCharacterCount = countSlackDataTableCellCharacters(block);
    if (cellCharacterCount === undefined) {
      return undefined;
    }
    total += cellCharacterCount;
  }
  return total;
}

function resolvePortableTableCellCharacterCount(
  block: MessagePresentationTableBlock,
): number | undefined {
  if (
    typeof block.caption !== "string" ||
    block.caption.trim().length === 0 ||
    !Array.isArray(block.headers) ||
    block.headers.length < 1 ||
    block.headers.length > SLACK_DATA_TABLE_COLUMNS_MAX ||
    !Array.isArray(block.rows) ||
    block.rows.length < 1 ||
    block.rows.length > SLACK_DATA_TABLE_ROWS_MAX ||
    new Set(block.headers).size !== block.headers.length ||
    !block.headers.every((header) => typeof header === "string" && header.trim().length > 0) ||
    (block.rowHeaderColumnIndex !== undefined &&
      (!Number.isInteger(block.rowHeaderColumnIndex) ||
        block.rowHeaderColumnIndex < 0 ||
        block.rowHeaderColumnIndex >= block.headers.length))
  ) {
    return undefined;
  }
  const values: string[] = [...block.headers];
  for (const row of block.rows) {
    if (!Array.isArray(row) || row.length !== block.headers.length) {
      return undefined;
    }
    for (const cell of row) {
      if (typeof cell === "number") {
        if (!Number.isFinite(cell)) {
          return undefined;
        }
        values.push(String(cell));
        continue;
      }
      if (typeof cell !== "string" || cell.trim().length === 0) {
        return undefined;
      }
      values.push(cell);
    }
  }
  return values.reduce((total, value) => total + countCharacters(value), 0);
}

/** True when a portable table fits Slack's per-table and per-message contracts. */
function canRenderSlackDataTable(
  block: MessagePresentationTableBlock,
  options: SlackDataTableBuildOptions = {},
): boolean {
  const cellCharacterCountOffset = options.cellCharacterCountOffset ?? 0;
  if (!Number.isSafeInteger(cellCharacterCountOffset) || cellCharacterCountOffset < 0) {
    return false;
  }
  const cellCharacterCount = resolvePortableTableCellCharacterCount(block);
  return (
    cellCharacterCount !== undefined &&
    cellCharacterCountOffset + cellCharacterCount <= SLACK_DATA_TABLE_CELL_CHARACTERS_MAX
  );
}

/** Map a validated portable table to Slack's current app-facing Block Kit shape. */
export function buildSlackDataTableBlock(
  block: MessagePresentationTableBlock,
  options: SlackDataTableBuildOptions = {},
): SlackDataTableBlock | undefined {
  if (!canRenderSlackDataTable(block, options)) {
    return undefined;
  }
  const header: SlackDataTableCell[] = block.headers.map((text) => ({ type: "raw_text", text }));
  const rows = block.rows.map((row) =>
    row.map<SlackDataTableCell>((cell) =>
      typeof cell === "number"
        ? { type: "raw_number", value: cell, text: String(cell) }
        : { type: "raw_text", text: cell },
    ),
  );
  return {
    type: "data_table",
    caption: block.caption,
    rows: [header, ...rows],
    ...(block.rowHeaderColumnIndex !== undefined
      ? { row_header_column_index: block.rowHeaderColumnIndex }
      : {}),
  };
}

/** Extract a deterministic accessible summary from a native Slack table block. */
export function renderSlackDataTableFallbackText(value: unknown): string | undefined {
  const block = asRecord(value);
  if (block?.type !== "data_table") {
    return undefined;
  }
  const parsed = parseSlackDataTable(block);
  if (parsed) {
    return renderMessagePresentationTableFallbackText({
      type: "table",
      caption: parsed.caption,
      headers: parsed.headers,
      rows: parsed.rows,
    });
  }
  return readNonEmptyString(block.caption)?.trim();
}

function escapeCompactFallbackCell(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

/** Render each native table cell once for bounded, formatting-disabled delivery. */
export function renderSlackDataTableCompactPlainTextFallback(value: unknown): string | undefined {
  const block = asRecord(value);
  if (block?.type !== "data_table") {
    return undefined;
  }
  const parsed = parseSlackDataTable(block);
  if (!parsed) {
    return readNonEmptyString(block.caption)?.trim();
  }
  return [
    `${escapeCompactFallbackCell(parsed.caption)} (table)`,
    parsed.headers.map(escapeCompactFallbackCell).join("\t"),
    ...parsed.rows.map((row) => row.map(escapeCompactFallbackCell).join("\t")),
  ].join("\n");
}

/** Render a native table as mrkdwn without activating raw cell control tokens. */
export function renderSlackDataTableMrkdwnFallbackText(value: unknown): string | undefined {
  const block = asRecord(value);
  if (block?.type !== "data_table") {
    return undefined;
  }
  const parsed = parseSlackDataTable(block);
  if (parsed) {
    return renderSlackMessagePresentationTableFallbackText({
      type: "table",
      caption: parsed.caption,
      headers: parsed.headers,
      rows: parsed.rows,
    });
  }
  const caption = readNonEmptyString(block.caption)?.trim();
  return caption ? escapeSlackMrkdwn(caption) : undefined;
}
