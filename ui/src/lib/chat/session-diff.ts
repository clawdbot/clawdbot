/**
 * Session diff panel parsing: turns the per-file unified patches returned by
 * the `sessions.diff` gateway method into renderable DiffLine rows, with
 * hunk-gap markers ("N unmodified lines") instead of bare separators.
 */
import type { DiffLine } from "./tool-call-diff.ts";

/** Per-file render bound; the panel shows a truncation notice past this. */
const MAX_SESSION_DIFF_FILE_LINES = 600;

export type ParsedFilePatch = {
  lines: DiffLine[];
  truncated: boolean;
};

/**
 * Parses one file's unified patch (header lines + hunks) into DiffLine rows.
 * Gaps between hunks become "skip" rows whose text carries the formatted
 * unmodified-line count supplied by the caller (kept out of this lib so the
 * parser stays i18n-free).
 */
export function parseSessionDiffPatch(
  patch: string,
  formatGap: (count: number) => string,
  maxLines = MAX_SESSION_DIFF_FILE_LINES,
): ParsedFilePatch {
  const lines: DiffLine[] = [];
  let truncated = false;
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  // Next expected old-file line after the previous hunk; drives gap counts.
  let oldNext: number | undefined;
  const rawLines = patch.replace(/\r\n/g, "\n").split("\n");
  if (rawLines.at(-1) === "") {
    rawLines.pop();
  }
  for (const raw of rawLines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      const oldStart = Number.parseInt(hunk[1] ?? "", 10);
      const newStart = Number.parseInt(hunk[2] ?? "", 10);
      const gap = oldNext === undefined ? oldStart - 1 : oldStart - oldNext;
      if (gap > 0) {
        lines.push({ kind: "skip", text: formatGap(gap) });
      }
      oldNo = oldStart;
      newNo = newStart;
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) {
      // Header lines before the first hunk and "\ No newline at end of file".
      continue;
    }
    if (lines.length >= maxLines) {
      truncated = true;
      break;
    }
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", lineNo: newNo, text: raw.slice(1) });
      newNo += 1;
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", lineNo: oldNo, text: raw.slice(1) });
      oldNo += 1;
    } else {
      lines.push({ kind: "ctx", lineNo: newNo, text: raw.slice(1) });
      oldNo += 1;
      newNo += 1;
    }
    oldNext = oldNo;
  }
  return { lines, truncated };
}
