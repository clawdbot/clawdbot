/**
 * Bounded MEMORY.md compaction for dreaming/promotion writes.
 *
 * Background: the dreaming pipeline appends promoted entries to MEMORY.md
 * via short-term-promotion.applyShortTermPromotions. Without a size budget,
 * MEMORY.md grows unboundedly across deep-phase sweeps and eventually
 * exceeds bootstrap's per-file injection cap, breaking session bootstrap.
 * See issue #73691.
 *
 * Strategy: drop the OLDEST auto-promoted sections (date-ordered) until
 * the file plus the new section fit within the budget. User-authored
 * content (anything that is not a `## Promoted From Short-Term Memory
 * (DATE)` section) is preserved unconditionally — only dreaming-owned
 * sections are eligible for compaction.
 */

const PROMOTION_SECTION_HEADING_RE = /^## Promoted From Short-Term Memory \(([^)]+)\)\s*$/;

/**
 * Default budget for MEMORY.md content on disk, in characters. Chosen to
 * stay safely below the bootstrap injection cap (~12KB per file at the
 * time of writing) so promoted memory keeps reaching new sessions instead
 * of being silently dropped by bootstrap truncation.
 */
export const DEFAULT_MEMORY_FILE_MAX_CHARS = 10_000;

/**
 * Reserve for writer-side overhead that the helper does not see directly:
 * the `# Long-Term Memory\n\n` header re-emitted when compaction empties
 * out (20 chars) and `withTrailingNewline`'s trailing `\n` (1 char). See
 * the actual write expression in `applyShortTermPromotions`. Subtracting
 * this from `budgetChars` keeps the on-disk file inside the caller's
 * stated budget instead of exceeding it by up to ~21 chars in edge cases.
 */
const WRITE_OVERHEAD_RESERVE = 21;

type MemoryBlock =
  | { kind: "preserved"; text: string }
  | { kind: "promotion"; date: string; text: string };

function parseMemoryBlocks(content: string): MemoryBlock[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split(/\r?\n/);
  const blocks: MemoryBlock[] = [];
  let currentLines: string[] = [];
  let currentKind: "preserved" | "promotion" = "preserved";
  let currentDate: string | undefined;

  const flush = () => {
    if (currentLines.length === 0) {
      return;
    }
    const text = currentLines.join("\n");
    if (currentKind === "promotion" && currentDate) {
      blocks.push({ kind: "promotion", date: currentDate, text });
    } else {
      blocks.push({ kind: "preserved", text });
    }
    currentLines = [];
    currentKind = "preserved";
    currentDate = undefined;
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      const match = PROMOTION_SECTION_HEADING_RE.exec(line);
      if (match) {
        currentKind = "promotion";
        currentDate = match[1];
      } else {
        currentKind = "preserved";
      }
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  flush();
  return blocks;
}

function joinBlocks(blocks: MemoryBlock[]): string {
  return blocks.map((block) => block.text).join("\n");
}

export type CompactMemoryParams = {
  existingMemory: string;
  newSection: string;
  budgetChars: number;
};

export type CompactMemoryResult = {
  compacted: string;
  droppedDates: string[];
};

/**
 * Drop oldest auto-promotion sections from `existingMemory` until
 * `existingMemory + newSection` fits within `budgetChars`. Returns the
 * (possibly trimmed) existing memory and the dates of dropped sections.
 *
 * Guarantees:
 * - Non-promotion content (user-authored markdown, the file header, any
 *   `##` heading not matching the promotion pattern) is preserved.
 * - Promotion sections are dropped in ascending date order (oldest first).
 * - If `existingMemory + newSection` already fits the budget, the existing
 *   memory is returned unchanged.
 * - If the budget cannot be satisfied even by dropping every promotion
 *   section, the function drops them all and returns; the caller writes
 *   the new section anyway. This is the "log and continue" failure mode —
 *   refusing the new write would silently swallow the freshest material.
 */
export function compactMemoryForBudget(params: CompactMemoryParams): CompactMemoryResult {
  const { existingMemory, newSection, budgetChars } = params;
  if (budgetChars <= 0) {
    return { compacted: existingMemory, droppedDates: [] };
  }

  // Reserve writer-side header + trailing-newline overhead so the on-disk
  // file actually fits the caller's stated budget.
  const effectiveBudget = Math.max(0, budgetChars - WRITE_OVERHEAD_RESERVE);

  if (existingMemory.length + newSection.length <= effectiveBudget) {
    return { compacted: existingMemory, droppedDates: [] };
  }

  const blocks = parseMemoryBlocks(existingMemory);
  const promotionEntries = blocks
    .map((block, index) =>
      block.kind === "promotion" ? { index, date: block.date, length: block.text.length } : null,
    )
    .filter((entry): entry is { index: number; date: string; length: number } => entry !== null)
    .toSorted((a, b) => a.date.localeCompare(b.date));

  if (promotionEntries.length === 0) {
    return { compacted: existingMemory, droppedDates: [] };
  }

  const droppedIndices = new Set<number>();
  const droppedDates: string[] = [];
  let projectedExistingSize = existingMemory.length;
  // Block boundaries cost one newline each in joinBlocks; subtract a
  // newline along with the block text so the projection stays honest.
  const blockSeparatorCost = blocks.length > 1 ? 1 : 0;

  for (const entry of promotionEntries) {
    if (projectedExistingSize + newSection.length <= effectiveBudget) {
      break;
    }
    droppedIndices.add(entry.index);
    droppedDates.push(entry.date);
    projectedExistingSize = Math.max(0, projectedExistingSize - entry.length - blockSeparatorCost);
  }

  if (droppedIndices.size === 0) {
    return { compacted: existingMemory, droppedDates: [] };
  }

  const remaining = blocks.filter((_, index) => !droppedIndices.has(index));
  return { compacted: joinBlocks(remaining), droppedDates };
}
