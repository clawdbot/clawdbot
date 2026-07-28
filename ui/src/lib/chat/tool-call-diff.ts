/**
 * Inline diff data for tool-call rendering.
 *
 * Sources, in preference order:
 * 1. The edit tool's precomputed display diff (`details.diff`, numbered lines).
 * 2. A locally computed line diff from `oldText`/`newText`-style args when a
 *    harness does not ship diff details.
 */

export type DiffLineKind = "add" | "del" | "ctx" | "file" | "skip";

export type DiffLine = {
  kind: DiffLineKind;
  /** 1-based line number in the file (new file for adds/ctx, old file for dels). */
  lineNo?: number;
  text: string;
};

export type DiffStat = { added: number; removed: number };

/** Bound diff rendering work; oversized inputs degrade to a truncation marker. */
const MAX_DIFF_INPUT_LINES = 600;
export const MAX_DIFF_RENDER_LINES = 400;

export function diffStat(lines: readonly DiffLine[]): DiffStat {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") {
      added += 1;
    } else if (line.kind === "del") {
      removed += 1;
    }
  }
  return { added, removed };
}

/**
 * Parse the edit tool's display diff (`generateDiffString` output):
 * `+457 text`, `-455 text`, ` 456 text`, and `     ...` skip markers.
 */
export function parseDiffDetailsString(diff: string): DiffLine[] | null {
  const trimmed = diff.trim();
  if (!trimmed) {
    return null;
  }
  const lines: DiffLine[] = [];
  for (const raw of diff.split("\n")) {
    if (!raw) {
      continue;
    }
    const skipMatch = raw.match(/^\s*\.\.\.(?:\(truncated\)\.\.\.)?\s*$/);
    if (skipMatch) {
      lines.push({ kind: "skip", text: "" });
      continue;
    }
    const match = raw.match(/^([+\- ])\s*(\d+) ?(.*)$/s);
    if (!match) {
      // Not the expected format; bail so callers fall back to raw text.
      return null;
    }
    const [, sign, lineNo, text] = match;
    if (!sign || !lineNo) {
      return null;
    }
    lines.push({
      kind: sign === "+" ? "add" : sign === "-" ? "del" : "ctx",
      lineNo: Number.parseInt(lineNo, 10),
      text: text ?? "",
    });
    if (lines.length > MAX_DIFF_RENDER_LINES) {
      lines.push({ kind: "skip", text: "" });
      break;
    }
  }
  return lines.some((line) => line.kind === "add" || line.kind === "del") ? lines : null;
}

function splitDiffLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Empty snippets are zero lines: deletions (`newText: ""`) and insertions
  // from an empty old side must not produce a phantom blank row in the diff.
  if (normalized === "") {
    return [];
  }
  const lines = normalized.split("\n");
  // A trailing newline yields one empty trailing element; drop it so
  // "foo\n" diffs as one line, not two.
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function compactLineDiff(lines: DiffLine[], inputTruncated: boolean): DiffLine[] {
  if (lines.length <= MAX_DIFF_RENDER_LINES && !inputTruncated) {
    return lines;
  }
  const hasChange = lines.some((line) => line.kind === "add" || line.kind === "del");
  if (!hasChange) {
    return inputTruncated
      ? [{ kind: "skip", text: "" }]
      : [...lines.slice(0, MAX_DIFF_RENDER_LINES), { kind: "skip", text: "" }];
  }
  const keep = new Uint8Array(lines.length);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line || (line.kind !== "add" && line.kind !== "del")) {
      continue;
    }
    const start = Math.max(0, index - 3);
    const end = Math.min(lines.length, index + 4);
    keep.fill(1, start, end);
  }
  const preview: DiffLine[] = [];
  let gap = false;
  let clipped = inputTruncated;
  for (let index = 0; index < lines.length; index++) {
    if (keep[index] === 0) {
      gap = true;
      clipped = true;
      continue;
    }
    if (gap && preview.at(-1)?.kind !== "skip") {
      preview.push({ kind: "skip", text: "" });
    }
    gap = false;
    if (preview.length >= MAX_DIFF_RENDER_LINES) {
      clipped = true;
      break;
    }
    const line = lines[index];
    if (line) {
      preview.push(line);
    }
  }
  if (clipped && preview.at(-1)?.kind !== "skip") {
    preview.push({ kind: "skip", text: "" });
  }
  return preview;
}

/**
 * Compute a line diff between two snippets (no file line numbers available).
 * Standard LCS table; inputs are bounded so the quadratic cost stays small.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const allOldLines = splitDiffLines(oldText);
  const allNewLines = splitDiffLines(newText);
  const inputTruncated =
    allOldLines.length > MAX_DIFF_INPUT_LINES || allNewLines.length > MAX_DIFF_INPUT_LINES;
  const oldLines = allOldLines.slice(0, MAX_DIFF_INPUT_LINES);
  const newLines = allNewLines.slice(0, MAX_DIFF_INPUT_LINES);
  const n = oldLines.length;
  const m = newLines.length;
  // lcs[i][j] = LCS length of oldLines[i..] vs newLines[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0),
  );
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i];
    const nextRow = lcs[i + 1];
    if (!row || !nextRow) {
      continue;
    }
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        oldLines[i] === newLines[j]
          ? (nextRow[j + 1] ?? 0) + 1
          : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const oldLine = oldLines[i];
    const newLine = newLines[j];
    if (oldLine === undefined || newLine === undefined) {
      break;
    }
    if (oldLine === newLine) {
      lines.push({ kind: "ctx", text: oldLine });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      lines.push({ kind: "del", text: oldLine });
      i++;
    } else {
      lines.push({ kind: "add", text: newLine });
      j++;
    }
  }
  while (i < n) {
    const line = oldLines[i];
    if (line !== undefined) {
      lines.push({ kind: "del", text: line });
    }
    i++;
  }
  while (j < m) {
    const line = newLines[j];
    if (line !== undefined) {
      lines.push({ kind: "add", text: line });
    }
    j++;
  }
  return compactLineDiff(lines, inputTruncated);
}

/** All-added preview for freshly written files, numbered from line 1. */
export function buildWriteDiffLines(content: string, maxLines = 80): DiffLine[] {
  const sourceLines = splitDiffLines(content);
  const lines: DiffLine[] = [];
  for (const [index, text] of sourceLines.slice(0, maxLines).entries()) {
    lines.push({ kind: "add", lineNo: index + 1, text });
  }
  if (sourceLines.length > maxLines) {
    lines.push({ kind: "skip", text: "" });
  }
  return lines;
}

export function countTextLines(content: string): number {
  return splitDiffLines(content).length;
}

/**
 * Concatenate per-edit diffs with skip separators, e.g. for multi-edit calls
 * where each `edits[i]` produced its own local diff.
 */
export function joinDiffSections(
  sections: ReadonlyArray<DiffLine[]>,
  options?: { truncated?: boolean; maxLines?: number },
): DiffLine[] {
  const maxLines = options?.maxLines ?? MAX_DIFF_RENDER_LINES;
  const joined: DiffLine[] = [];
  let truncated = options?.truncated === true;
  for (const section of sections) {
    if (section.length === 0) {
      continue;
    }
    if (joined.length > 0) {
      if (joined.length >= maxLines) {
        truncated = true;
        break;
      }
      joined.push({ kind: "skip", text: "" });
    }
    const remaining = maxLines - joined.length;
    if (section.length > remaining) {
      joined.push(...section.slice(0, remaining));
      truncated = true;
      break;
    }
    joined.push(...section);
  }
  if (truncated && joined.at(-1)?.kind !== "skip") {
    joined.push({ kind: "skip", text: "" });
  }
  return joined;
}
