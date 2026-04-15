/**
 * Batch insertion for large Feishu documents (>1000 blocks).
 *
 * The Feishu Descendant API has a limit of 1000 blocks per request.
 * This module handles splitting large documents into batches while
 * preserving parent-child relationships between blocks.
 */

import type * as Lark from "@larksuiteoapi/node-sdk";
import { readStringValue } from "openclaw/plugin-sdk/text-runtime";
import { cleanBlocksForDescendant } from "./docx-table-ops.js";
import type { FeishuDocxBlock, FeishuDocxBlockChild } from "./docx-types.js";

export const BATCH_SIZE = 1000; // Feishu API limit per request

type Logger = { info?: (msg: string) => void };

type DocxDescendantCreatePayload = NonNullable<
  Parameters<Lark.Client["docx"]["documentBlockDescendant"]["create"]>[0]
>;
type DocxDescendantCreateBlock = NonNullable<
  NonNullable<DocxDescendantCreatePayload["data"]>["descendants"]
>[number];

function normalizeChildIds(children: string[] | string | undefined): string[] | undefined {
  if (Array.isArray(children)) {
    return children;
  }
  const child = readStringValue(children);
  return child ? [child] : undefined;
}

function toDescendantBlock(block: FeishuDocxBlock): DocxDescendantCreateBlock {
  const children = normalizeChildIds(block.children);
  return {
    ...block,
    ...(children ? { children } : {}),
  } as DocxDescendantCreateBlock;
}

/**
 * Collect all descendant blocks for a given first-level block ID.
 * Recursively traverses the block tree to gather all children.
 */
function collectDescendants(
  blockMap: Map<string, FeishuDocxBlock>,
  rootId: string,
): FeishuDocxBlock[] {
  const result: FeishuDocxBlock[] = [];
  const visited = new Set<string>();

  function collect(blockId: string) {
    if (visited.has(blockId)) {
      return;
    }
    visited.add(blockId);

    const block = blockMap.get(blockId);
    if (!block) {
      return;
    }

    result.push(block);

    // Recursively collect children
    const children = block.children;
    if (Array.isArray(children)) {
      for (const childId of children) {
        collect(childId);
      }
    } else if (typeof children === "string") {
      collect(children);
    }
  }

  collect(rootId);

  return result;
}

/**
 * Insert a single batch of blocks using Descendant API.
 *
 * @param parentBlockId - Parent block to insert into (defaults to docToken)
 * @param index - Position within parent's children (-1 = end)
 */
async function insertBatch(
  client: Lark.Client,
  docToken: string,
  blocks: FeishuDocxBlock[],
  firstLevelBlockIds: string[],
  parentBlockId: string = docToken,
  index: number = -1,
): Promise<FeishuDocxBlockChild[]> {
  const descendants = cleanBlocksForDescendant(blocks);

  if (descendants.length === 0) {
    return [];
  }

  const res = await client.docx.documentBlockDescendant.create({
    path: { document_id: docToken, block_id: parentBlockId },
    data: {
      children_id: firstLevelBlockIds,
      descendants: descendants.map(toDescendantBlock),
      index,
    },
  });

  if (res.code !== 0) {
    throw new Error(`${res.msg} (code: ${res.code})`);
  }

  return res.data?.children ?? [];
}

/**
 * Insert blocks in batches for large documents (>1000 blocks).
 *
 * Batches are split to ensure BOTH children_id AND descendants
 * arrays stay under the 1000 block API limit.
 *
 * @param client - Feishu API client
 * @param docToken - Document ID
 * @param blocks - All blocks from Convert API
 * @param firstLevelBlockIds - IDs of top-level blocks to insert
 * @param logger - Optional logger for progress updates
 * @param parentBlockId - Parent block to insert into (defaults to docToken = document root)
 * @param startIndex - Starting position within parent (-1 = end). For multi-batch inserts,
 *   each batch advances this by the number of first-level IDs inserted so far.
 * @returns Inserted children blocks and any skipped block IDs
 */
export async function insertBlocksInBatches(
  client: Lark.Client,
  docToken: string,
  blocks: FeishuDocxBlock[],
  firstLevelBlockIds: string[],
  logger?: Logger,
  parentBlockId: string = docToken,
  startIndex: number = -1,
): Promise<{ children: FeishuDocxBlockChild[]; skipped: string[] }> {
  const allChildren: FeishuDocxBlockChild[] = [];

  // Build batches ensuring each batch has ≤1000 total descendants
  const batches: Array<{ firstLevelIds: string[]; blocks: FeishuDocxBlock[] }> = [];
  let currentBatch: { firstLevelIds: string[]; blocks: FeishuDocxBlock[] } = {
    firstLevelIds: [],
    blocks: [],
  };
  const usedBlockIds = new Set<string>();
  const blockMap = new Map<string, FeishuDocxBlock>();
  for (const block of blocks) {
    if (block.block_id) {
      blockMap.set(block.block_id, block);
    }
  }

  for (const firstLevelId of firstLevelBlockIds) {
    const descendants = collectDescendants(blockMap, firstLevelId);
    const newBlocks = descendants.filter((b) => b.block_id && !usedBlockIds.has(b.block_id));

    // A single block whose subtree exceeds the API limit cannot be split
    // (a table or other compound block must be inserted atomically).
    if (newBlocks.length > BATCH_SIZE) {
      throw new Error(
        `Block "${firstLevelId}" has ${newBlocks.length} descendants, which exceeds the ` +
          `Feishu API limit of ${BATCH_SIZE} blocks per request. ` +
          `Please split the content into smaller sections.`,
      );
    }

    // If adding this first-level block would exceed limit, start new batch
    if (
      currentBatch.blocks.length + newBlocks.length > BATCH_SIZE &&
      currentBatch.blocks.length > 0
    ) {
      batches.push(currentBatch);
      currentBatch = { firstLevelIds: [], blocks: [] };
    }

    // Add to current batch
    currentBatch.firstLevelIds.push(firstLevelId);
    for (const block of newBlocks) {
      currentBatch.blocks.push(block);
      if (block.block_id) {
        usedBlockIds.add(block.block_id);
      }
    }
  }

  // Don't forget the last batch
  if (currentBatch.blocks.length > 0) {
    batches.push(currentBatch);
  }

  // Insert each batch, advancing index for position-aware inserts.
  // When startIndex == -1 (append to end), each batch appends after the previous.
  // When startIndex >= 0, each batch starts at startIndex + count of first-level IDs already inserted.
  let currentIndex = startIndex;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    logger?.info?.(
      `feishu_doc: Inserting batch ${i + 1}/${batches.length} (${batch.blocks.length} blocks)...`,
    );

    const children = await insertBatch(
      client,
      docToken,
      batch.blocks,
      batch.firstLevelIds,
      parentBlockId,
      currentIndex,
    );
    allChildren.push(...children);

    // Advance index only for explicit positions; -1 always means "after last inserted"
    if (currentIndex !== -1) {
      currentIndex += batch.firstLevelIds.length;
    }
  }

  return { children: allChildren, skipped: [] };
}
