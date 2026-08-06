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
 * the file plus the new section fit within the budget. A section counts as
 * dreaming-owned only when its complete body matches the marker + entry
 * structure emitted by `buildPromotionSection`. Ambiguous or mixed content
 * is preserved unconditionally.
 */

const PROMOTION_SECTION_HEADING_RE = /^## Promoted From Short-Term Memory \(([^)]+)\)\s*$/;

const PROMOTION_SUBSECTION_HEADING_RE = /^### (?:Global|Project: .+?)\s*$/;

const PROMOTION_ENTRY_MARKER_RE = /^<!--\s*openclaw-memory-promotion:.*-->\s*$/i;

const ATX_HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;

const SETEXT_HEADING_UNDERLINE_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;

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

function isGeneratedPromotionBlock(lines: string[]): boolean {
  let sawEntry = false;
  let index = 1;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    if (PROMOTION_SUBSECTION_HEADING_RE.test(line)) {
      index += 1;
      while (index < lines.length && (lines[index] ?? "").trim().length === 0) {
        index += 1;
      }
    }

    if (!PROMOTION_ENTRY_MARKER_RE.test(lines[index] ?? "")) {
      return false;
    }
    // A marker owns only the single bullet emitted with it. Treat any other
    // body shape as mixed user content so compaction cannot delete it.
    if (!(lines[index + 1] ?? "").startsWith("- ")) {
      return false;
    }
    sawEntry = true;
    index += 2;
  }

  return sawEntry;
}

function startsGeneratedPromotionSubsection(lines: string[], index: number): boolean {
  if (!PROMOTION_SUBSECTION_HEADING_RE.test(lines[index] ?? "")) {
    return false;
  }
  for (let next = index + 1; next < lines.length; next += 1) {
    const line = lines[next] ?? "";
    if (line.trim().length === 0) {
      continue;
    }
    return PROMOTION_ENTRY_MARKER_RE.test(line);
  }
  return false;
}

function takeSetextHeadingLines(lines: string[]): string[] | undefined {
  let start = lines.length;
  while (start > 1 && lines[start - 1]?.trim().length !== 0) {
    start -= 1;
  }
  if (start === lines.length) {
    return undefined;
  }
  const headingLines = lines.slice(start);
  if (headingLines.some((line) => PROMOTION_ENTRY_MARKER_RE.test(line))) {
    return undefined;
  }
  lines.splice(start);
  return headingLines;
}

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
    if (currentKind === "promotion" && currentDate && isGeneratedPromotionBlock(currentLines)) {
      blocks.push({ kind: "promotion", date: currentDate, text });
    } else {
      blocks.push({ kind: "preserved", text });
    }
    currentLines = [];
    currentKind = "preserved";
    currentDate = undefined;
  };

  for (const [index, line] of lines.entries()) {
    if (currentKind === "promotion" && SETEXT_HEADING_UNDERLINE_RE.test(line)) {
      const headingLines = takeSetextHeadingLines(currentLines);
      if (headingLines) {
        flush();
        currentLines = [...headingLines, line];
        continue;
      }
    }
    const continuesPromotionBody =
      currentKind === "promotion" && startsGeneratedPromotionSubsection(lines, index);
    if (ATX_HEADING_RE.test(line) && !continuesPromotionBody) {
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

type CompactMemoryParams = {
  existingMemory: string;
  newSection: string;
  budgetChars: number;
};

type CompactMemoryResult = {
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
 *   heading of any level not matching the promotion pattern, and any mixed
 *   or malformed promotion-shaped block) is preserved.
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
