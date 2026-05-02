/**
 * Table utilities and row/column manipulation operations for Feishu documents.
 *
 * Combines:
 * - Adaptive column width calculation (content-proportional, CJK-aware)
 * - Block cleaning for Descendant API (removes read-only fields)
 * - Table row/column insert, delete, and merge operations
 */

import type * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuBlockTable, FeishuDocxBlock } from "./docx-types.js";

// ============ Table Utilities ============

// Feishu table constraints
const MIN_COLUMN_WIDTH = 50; // Feishu API minimum
const MAX_COLUMN_WIDTH = 400; // Reasonable maximum for readability
const DEFAULT_TABLE_WIDTH = 730; // Approximate Feishu page content width

/**
 * Calculate adaptive column widths based on cell content length.
 *
 * Algorithm:
 * 1. For each column, find the max content length across all rows
 * 2. Weight CJK characters as 2x width (they render wider)
 * 3. Calculate proportional widths based on content length
 * 4. Apply min/max constraints
 * 5. Redistribute remaining space to fill total table width
 *
 * Total width is derived from the original column_width values returned
 * by the Convert API, ensuring tables match Feishu's expected dimensions.
 *
 * @param blocks - Array of blocks from Convert API
 * @param tableBlockId - The block_id of the table block
 * @returns Array of column widths in pixels
 */
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
        maxLengths[col] = Math.max(maxLengths[col], length);
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
      const add = Math.min(perColumn, MAX_COLUMN_WIDTH - widths[i]);
      widths[i] += add;
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

export async function insertTableRow(
  client: Lark.Client,
  docToken: string,
  blockId: string,
  rowIndex: number = -1,
) {
  const res = await client.docx.documentBlock.patch({
    path: { document_id: docToken, block_id: blockId },
    data: { insert_table_row: { row_index: rowIndex } },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return { success: true, block: res.data?.block };
}

export async function insertTableColumn(
  client: Lark.Client,
  docToken: string,
  blockId: string,
  columnIndex: number = -1,
) {
  const res = await client.docx.documentBlock.patch({
    path: { document_id: docToken, block_id: blockId },
    data: { insert_table_column: { column_index: columnIndex } },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return { success: true, block: res.data?.block };
}

export async function deleteTableRows(
  client: Lark.Client,
  docToken: string,
  blockId: string,
  rowStart: number,
  rowCount: number = 1,
) {
  const res = await client.docx.documentBlock.patch({
    path: { document_id: docToken, block_id: blockId },
    data: { delete_table_rows: { row_start_index: rowStart, row_end_index: rowStart + rowCount } },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return { success: true, rows_deleted: rowCount, block: res.data?.block };
}

export async function deleteTableColumns(
  client: Lark.Client,
  docToken: string,
  blockId: string,
  columnStart: number,
  columnCount: number = 1,
) {
  const res = await client.docx.documentBlock.patch({
    path: { document_id: docToken, block_id: blockId },
    data: {
      delete_table_columns: {
        column_start_index: columnStart,
        column_end_index: columnStart + columnCount,
      },
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return { success: true, columns_deleted: columnCount, block: res.data?.block };
}

export async function mergeTableCells(
  client: Lark.Client,
  docToken: string,
  blockId: string,
  rowStart: number,
  rowEnd: number,
  columnStart: number,
  columnEnd: number,
) {
  const res = await client.docx.documentBlock.patch({
    path: { document_id: docToken, block_id: blockId },
    data: {
      merge_table_cells: {
        row_start_index: rowStart,
        row_end_index: rowEnd,
        column_start_index: columnStart,
        column_end_index: columnEnd,
      },
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return { success: true, block: res.data?.block };
}
