/**
 * Table utilities and row/column manipulation operations for Feishu documents.
 *
 * Combines:
 * - Adaptive column width calculation (content-proportional, CJK-aware)
 * - Block cleaning for Descendant API (removes read-only fields)
 * - Table row/column insert, delete, and merge operations
 */

import type * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuDocParams } from "./doc-schema.js";
import type { FeishuBlockTable, FeishuDocxBlock } from "./docx-types.js";

// ============ Table Utilities ============

// Feishu table constraints
const MIN_COLUMN_WIDTH = 50; // Feishu API minimum
const MAX_COLUMN_WIDTH = 400; // Reasonable maximum for readability
const DEFAULT_TABLE_WIDTH = 730; // Approximate Feishu page content width

function normalizeChildBlockIds(children: string[] | string | undefined): string[] {
  if (Array.isArray(children)) {
    return children;
  }
  return typeof children === "string" ? [children] : [];
}

function omitParentId(block: FeishuDocxBlock): FeishuDocxBlock {
  const cleanBlock = { ...block };
  delete cleanBlock.parent_id;
  return cleanBlock;
}

function createDescendantTable(
  table: FeishuBlockTable,
  adaptiveWidths: number[] | undefined,
): FeishuBlockTable {
  const { row_size, column_size } = table.property || {};
  return {
    property: {
      row_size,
      column_size,
      ...(adaptiveWidths?.length ? { column_width: adaptiveWidths } : {}),
    },
  };
}

function calculateAdaptiveColumnWidths(blocks: FeishuDocxBlock[], tableBlockId: string): number[] {
  // Find the table block
  const tableBlock = blocks.find((b) => b.block_id === tableBlockId && b.block_type === 31);

  if (!tableBlock?.table?.property) {
    return [];
  }

  const { row_size, column_size, column_width: originalWidths } = tableBlock.table.property;
  if (!row_size || !column_size) {
    return [];
  }

  // Use original total width from Convert API, or fall back to default
  const totalWidth =
    originalWidths && originalWidths.length > 0
      ? originalWidths.reduce((a: number, b: number) => a + b, 0)
      : DEFAULT_TABLE_WIDTH;
  const cellIds = normalizeChildBlockIds(tableBlock.children);

  // Build block lookup map
  const blockMap = new Map<string, FeishuDocxBlock>();
  for (const block of blocks) {
    if (block.block_id) {
      blockMap.set(block.block_id, block);
    }
  }

  // Extract text content from a table cell
  function getCellText(cellId: string): string {
    const cell = blockMap.get(cellId);
    let text = "";
    const childIds = normalizeChildBlockIds(cell?.children);

    for (const childId of childIds) {
      const child = blockMap.get(childId);
      if (child?.text?.elements) {
        for (const elem of child.text.elements) {
          if (elem.text_run?.content) {
            text += elem.text_run.content;
          }
        }
      }
    }
    return text;
  }

  // Calculate weighted length (CJK chars count as 2)
  // CJK (Chinese/Japanese/Korean) characters render ~2x wider than ASCII
  function getWeightedLength(text: string): number {
    return Array.from(text).reduce((sum, char) => {
      return sum + (char.charCodeAt(0) > 255 ? 2 : 1);
    }, 0);
  }

  // Find max content length per column
  const maxLengths = Array.from({ length: column_size }, () => 0);

  for (let row = 0; row < row_size; row++) {
    for (let col = 0; col < column_size; col++) {
      const cellIndex = row * column_size + col;
      const cellId = cellIds[cellIndex];
      if (cellId) {
        const content = getCellText(cellId);
        const length = getWeightedLength(content);
        maxLengths[col] = Math.max(maxLengths[col] ?? 0, length);
      }
    }
  }

  // Handle empty table: distribute width equally, clamped to [MIN, MAX] so
  // wide tables (e.g. 15+ columns) don't produce sub-50 widths that Feishu
  // rejects as invalid column_width values.
  const totalLength = maxLengths.reduce((a, b) => a + b, 0);
  if (totalLength === 0) {
    const equalWidth = Math.max(
      MIN_COLUMN_WIDTH,
      Math.min(MAX_COLUMN_WIDTH, Math.floor(totalWidth / column_size)),
    );
    return Array.from({ length: column_size }, () => equalWidth);
  }

  // Calculate proportional widths
  let widths = maxLengths.map((len) => {
    const proportion = len / totalLength;
    return Math.round(proportion * totalWidth);
  });

  // Apply min/max constraints
  widths = widths.map((w) => Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, w)));

  // Redistribute remaining space to fill total width
  let remaining = totalWidth - widths.reduce((a, b) => a + b, 0);
  while (remaining > 0) {
    // Find columns that can still grow (not at max)
    const growable = widths.map((w, i) => (w < MAX_COLUMN_WIDTH ? i : -1)).filter((i) => i >= 0);
    if (growable.length === 0) {
      break;
    }

    // Distribute evenly among growable columns
    const perColumn = Math.floor(remaining / growable.length);
    if (perColumn === 0) {
      break;
    }

    for (const i of growable) {
      const width = widths[i];
      if (width === undefined) {
        continue;
      }
      const add = Math.min(perColumn, MAX_COLUMN_WIDTH - width);
      widths[i] = width + add;
      remaining -= add;
    }
  }

  return widths;
}

/**
 * Clean blocks for Descendant API with adaptive column widths.
 *
 * - Removes parent_id from all blocks
 * - Fixes children type (string → array) for TableCell blocks
 * - Removes merge_info (read-only, causes API error)
 * - Calculates and applies adaptive column_width for tables
 *
 * @param blocks - Array of blocks from Convert API
 * @returns Cleaned blocks ready for Descendant API
 */
export function cleanBlocksForDescendant(blocks: FeishuDocxBlock[]): FeishuDocxBlock[] {
  // Pre-calculate adaptive widths for all tables
  const tableWidths = new Map<string, number[]>();
  for (const block of blocks) {
    if (block.block_type === 31 && block.block_id) {
      const widths = calculateAdaptiveColumnWidths(blocks, block.block_id);
      tableWidths.set(block.block_id, widths);
    }
  }

  return blocks.map((block) => {
    const cleanBlock = omitParentId(block);

    // Fix: Convert API sometimes returns children as string for TableCell
    if (cleanBlock.block_type === 32 && typeof cleanBlock.children === "string") {
      cleanBlock.children = [cleanBlock.children];
    }

    // Clean table blocks
    if (cleanBlock.block_type === 31 && cleanBlock.table) {
      const adaptiveWidths = block.block_id ? tableWidths.get(block.block_id) : undefined;
      cleanBlock.table = createDescendantTable(cleanBlock.table, adaptiveWidths);
    }

    return cleanBlock;
  });
}

// ============ Table Row/Column Operations ============

type TableAction = Extract<
  FeishuDocParams,
  {
    action:
      | "insert_table_row"
      | "insert_table_column"
      | "delete_table_rows"
      | "delete_table_columns"
      | "merge_table_cells";
  }
>;
type TablePatchData = NonNullable<
  NonNullable<Parameters<Lark.Client["docx"]["documentBlock"]["patch"]>[0]>["data"]
>;

export async function patchTable(client: Lark.Client, params: TableAction) {
  const { doc_token, block_id } = params;
  let data: TablePatchData;
  const counts: { rows_deleted?: number; columns_deleted?: number } = {};
  // Capture result counts before the request; defaults apply only to undefined inputs.
  switch (params.action) {
    case "insert_table_row": {
      const { row_index = -1 } = params;
      data = { insert_table_row: { row_index } };
      break;
    }
    case "insert_table_column": {
      const { column_index = -1 } = params;
      data = { insert_table_column: { column_index } };
      break;
    }
    case "delete_table_rows": {
      const { row_start, row_count = 1 } = params;
      data = {
        delete_table_rows: { row_start_index: row_start, row_end_index: row_start + row_count },
      };
      counts.rows_deleted = row_count;
      break;
    }
    case "delete_table_columns": {
      const { column_start, column_count = 1 } = params;
      data = {
        delete_table_columns: {
          column_start_index: column_start,
          column_end_index: column_start + column_count,
        },
      };
      counts.columns_deleted = column_count;
      break;
    }
    case "merge_table_cells": {
      const { row_start, row_end, column_start, column_end } = params;
      data = {
        merge_table_cells: {
          row_start_index: row_start,
          row_end_index: row_end,
          column_start_index: column_start,
          column_end_index: column_end,
        },
      };
      break;
    }
  }
  const res = await client.docx.documentBlock.patch({
    path: { document_id: doc_token, block_id },
    data,
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return { success: true, ...counts, block: res.data?.block };
}
