// Memory Host SDK module implements read file shared behavior.
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { MemoryReadResult } from "./types.js";

// Shared memory-file read result shaping and truncation notices.

/** Default number of lines returned by memory read helpers. */
export const DEFAULT_MEMORY_READ_LINES = 120;
/** Default max character budget for memory read helper output. */
export const DEFAULT_MEMORY_READ_MAX_CHARS = 12_000;

export type { LegacyMemoryReadResult, MemoryReadResult } from "./types.js";

/** Build the continuation notice appended to truncated memory excerpts. */
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

/** Fit line slices to the response character budget while preserving line boundaries. */
function fitLinesToCharBudget(params: { lines: string[]; maxChars: number }): {
  text: string;
  includedLines: number;
  hardTruncatedSingleLine: boolean;
} {
  const { lines, maxChars } = params;
  let includedLines = 0;
  let chars = 0;
  for (const line of lines) {
    const nextChars = chars + line.length + (includedLines > 0 ? 1 : 0);
    // Keep an oversized first line for the existing single-line truncation contract.
    if (includedLines > 0 && nextChars > maxChars) {
      break;
    }
    includedLines += 1;
    chars = nextChars;
  }

  return {
    text: truncateUtf16Safe(lines.slice(0, includedLines).join("\n"), maxChars),
    includedLines,
    hardTruncatedSingleLine: chars > maxChars,
  };
}

/** Build a memory read result from an already-selected line slice. */
export function buildMemoryReadResultFromSlice(params: {
  selectedLines: string[];
  relPath: string;
  startLine: number;
  moreSourceLinesRemain?: boolean;
  maxChars?: number;
  suggestReadFallback?: boolean;
}): MemoryReadResult {
  const start = resolveIntegerOption(params.startLine, 1, { min: 1 });
  const fitted = fitLinesToCharBudget({
    lines: params.selectedLines,
    maxChars: resolveIntegerOption(params.maxChars, DEFAULT_MEMORY_READ_MAX_CHARS, { min: 1 }),
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
    truncated && (fitted.text || fitted.hardTruncatedSingleLine)
      ? `${fitted.text}${buildContinuationNotice({
          nextFrom,
          suggestReadFallback: fitted.hardTruncatedSingleLine && params.suggestReadFallback,
        })}`
      : fitted.text;
  return {
    status: "ok",
    text,
    path: params.relPath,
    from: start,
    lines: fitted.includedLines,
    ...(truncated ? { truncated: true } : {}),
    ...(typeof nextFrom === "number" ? { nextFrom } : {}),
  };
}

/** Build a memory read result from raw file content and caller range options. */
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
  // A terminal newline closes the preceding line; its split sentinel is not a
  // readable blank line or a reason to offer another memory page.
  if (fileLines.at(-1) === "") {
    fileLines.pop();
  }
  const start = resolveIntegerOption(params.from, 1, { min: 1 });
  const requestedCount = resolveIntegerOption(
    params.lines ?? params.defaultLines,
    DEFAULT_MEMORY_READ_LINES,
    { min: 1 },
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
