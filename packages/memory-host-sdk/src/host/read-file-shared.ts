import type { MemoryReadResult } from "./types.js";

export const DEFAULT_MEMORY_READ_LINES = 120;
export const DEFAULT_MEMORY_READ_MAX_CHARS = 12_000;

export type { MemoryReadResult } from "./types.js";

function buildContinuationNotice(params: {
  nextFrom: number | undefined;
  suggestReadFallback?: boolean;
}): string {
  const base =
    typeof params.nextFrom === "number"
      ? `[More content available. Use from=${params.nextFrom} to continue.]`
      : "[More content available. Requested excerpt exceeded the default maxChars budget.]";
  const fallback = params.suggestReadFallback
    ? " If you need the full raw line, use read on the source file."
    : "";
  return `\n\n${base.slice(0, -1)}${fallback}]`;
}

function fitLinesToCharBudget(params: { lines: string[]; maxChars: number }): {
  text: string;
  includedLines: number;
  hardTruncatedSingleLine: boolean;
} {
  const { lines, maxChars } = params;
  if (lines.length === 0) {
    return { text: "", includedLines: 0, hardTruncatedSingleLine: false };
  }

  let includedLines = lines.length;
  let text = lines.join("\n");
  while (includedLines > 1 && text.length > maxChars) {
    includedLines -= 1;
    text = lines.slice(0, includedLines).join("\n");
  }

  if (text.length <= maxChars) {
    return { text, includedLines, hardTruncatedSingleLine: false };
  }

  return {
    text: text.slice(0, maxChars),
    includedLines: 1,
    hardTruncatedSingleLine: true,
  };
}

export function buildMemoryReadResultFromSlice(params: {
  selectedLines: string[];
  relPath: string;
  startLine: number;
  moreSourceLinesRemain?: boolean;
  maxChars?: number;
  suggestReadFallback?: boolean;
}): MemoryReadResult {
  const start = Math.max(1, params.startLine);
  const fitted = fitLinesToCharBudget({
    lines: params.selectedLines,
    maxChars: Math.max(1, params.maxChars ?? DEFAULT_MEMORY_READ_MAX_CHARS),
  });
  const moreSourceLinesRemain = params.moreSourceLinesRemain ?? false;
  const charCapTruncated =
    fitted.hardTruncatedSingleLine || fitted.includedLines < params.selectedLines.length;
  const nextFrom =
    !fitted.hardTruncatedSingleLine &&
    (moreSourceLinesRemain || fitted.includedLines < params.selectedLines.length)
      ? start + fitted.includedLines
      : undefined;
  const truncated = charCapTruncated || moreSourceLinesRemain;
  const text =
    truncated && fitted.text
      ? `${fitted.text}${buildContinuationNotice({
          nextFrom,
          suggestReadFallback: fitted.hardTruncatedSingleLine && params.suggestReadFallback,
        })}`
      : fitted.text;
  return {
    text,
    path: params.relPath,
    from: start,
    lines: fitted.includedLines,
    ...(truncated ? { truncated: true } : {}),
    ...(typeof nextFrom === "number" ? { nextFrom } : {}),
  };
}

export function buildMemoryReadResult(params: {
  content: string;
  relPath: string;
  from?: number;
  lines?: number;
  defaultLines?: number;
  maxChars?: number;
  suggestReadFallback?: boolean;
}): MemoryReadResult {
  const fileLines = params.content.split("\n");
  const start = Math.max(1, params.from ?? 1);
  const requestedCount = Math.max(
    1,
    params.lines ?? params.defaultLines ?? DEFAULT_MEMORY_READ_LINES,
  );
  const selectedLines = fileLines.slice(start - 1, start - 1 + requestedCount);
  const moreSourceLinesRemain = start - 1 + selectedLines.length < fileLines.length;
  return buildMemoryReadResultFromSlice({
    selectedLines,
    relPath: params.relPath,
    startLine: start,
    moreSourceLinesRemain,
    maxChars: params.maxChars,
    suggestReadFallback: params.suggestReadFallback,
  });
}
