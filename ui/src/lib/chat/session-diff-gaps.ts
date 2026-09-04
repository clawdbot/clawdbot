import type { DiffLine, DiffLineGap } from "./tool-call-diff.ts";

export type SessionDiffGapDirection = "down" | "up" | "all";

const GAP_CHUNK_SIZE = 20;
const EXPAND_WHOLE_GAP_MAX = 25;

export function splitSessionDiffFileText(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function fileMatchesPatch(lines: readonly DiffLine[], fileLines: readonly string[]): boolean {
  for (const line of lines) {
    if (
      (line.kind === "add" || line.kind === "ctx") &&
      line.lineNo !== undefined &&
      fileLines[line.lineNo - 1] !== line.text
    ) {
      return false;
    }
  }
  return true;
}

function contextRows(fileLines: readonly string[], start: number, count: number): DiffLine[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "ctx" as const,
    lineNo: start + index,
    text: fileLines[start + index - 1]!,
  }));
}

/** Replaces part or all of one unchanged-lines marker with working-tree context. */
export function expandSessionDiffGap(
  lines: readonly DiffLine[],
  target: DiffLineGap,
  fileLines: readonly string[],
  direction: SessionDiffGapDirection,
  formatGap: (count: number) => string,
): DiffLine[] | null {
  const index = lines.findIndex((line) => line.kind === "skip" && line.gap === target);
  const gapEnd = target.newStart + target.count - 1;
  if (
    index < 0 ||
    target.newStart < 1 ||
    target.count < 1 ||
    gapEnd > fileLines.length ||
    !fileMatchesPatch(lines, fileLines)
  ) {
    return null;
  }

  const revealCount =
    direction === "all" || target.count <= EXPAND_WHOLE_GAP_MAX
      ? target.count
      : Math.min(GAP_CHUNK_SIZE, target.count);
  const remainingCount = target.count - revealCount;
  const revealStart = direction === "up" ? target.newStart + remainingCount : target.newStart;
  const revealed = contextRows(fileLines, revealStart, revealCount);
  const replacement: DiffLine[] = [];
  if (direction === "up" && remainingCount > 0) {
    replacement.push({
      kind: "skip",
      text: formatGap(remainingCount),
      gap: { ...target, count: remainingCount },
    });
  }
  replacement.push(...revealed);
  if (direction !== "up" && remainingCount > 0) {
    replacement.push({
      kind: "skip",
      text: formatGap(remainingCount),
      gap: {
        oldStart: target.oldStart + revealCount,
        newStart: target.newStart + revealCount,
        count: remainingCount,
      },
    });
  }
  return [...lines.slice(0, index), ...replacement, ...lines.slice(index + 1)];
}
