import type { DiffLine } from "./tool-call-diff.ts";

export type SessionSplitDiffRow =
  | { kind: "pair"; left?: DiffLine; right?: DiffLine }
  | { kind: "span"; line: DiffLine };

/** Aligns each adjacent deletion/addition block while keeping context and gaps full-width. */
export function pairSessionDiffLines(lines: readonly DiffLine[]): SessionSplitDiffRow[] {
  const rows: SessionSplitDiffRow[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line) {
      break;
    }
    if (line.kind !== "add" && line.kind !== "del") {
      rows.push({ kind: "span", line });
      index += 1;
      continue;
    }

    const deletions: DiffLine[] = [];
    const additions: DiffLine[] = [];
    while (index < lines.length) {
      const changed = lines[index];
      if (changed?.kind === "del") {
        deletions.push(changed);
      } else if (changed?.kind === "add") {
        additions.push(changed);
      } else {
        break;
      }
      index += 1;
    }
    const count = Math.max(deletions.length, additions.length);
    for (let pairIndex = 0; pairIndex < count; pairIndex += 1) {
      rows.push({
        kind: "pair",
        ...(deletions[pairIndex] ? { left: deletions[pairIndex] } : {}),
        ...(additions[pairIndex] ? { right: additions[pairIndex] } : {}),
      });
    }
  }
  return rows;
}
