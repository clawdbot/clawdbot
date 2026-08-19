/**
 * Update-hunk application for the apply_patch parser.
 * Locates expected old lines with tolerant matching, applies chunks in order,
 * and returns normalized file contents with a trailing newline.
 */
import fs from "node:fs/promises";
import { formatErrorMessage } from "../infra/errors.js";
import { hasOnlyCrlfLineEndings, normalizeToLF, restoreLineEndings } from "./line-endings.js";

const DASH_PUNCTUATION = /[\u2010-\u2015\u2212]/g;
const SINGLE_QUOTE_PUNCTUATION = /[\u2018-\u201B]/g;
const DOUBLE_QUOTE_PUNCTUATION = /[\u201C-\u201F]/g;
const SPACE_PUNCTUATION = /[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g;

type UpdateFileChunk = {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  contextOldIndexes: Array<number | undefined>;
  isEndOfFile: boolean;
};

async function defaultReadFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

/** Apply parsed update chunks to one file and return the new file contents. */
export async function applyUpdateHunk(
  filePath: string,
  chunks: UpdateFileChunk[],
  options?: { readFile?: (filePath: string) => Promise<string> },
): Promise<string> {
  const reader = options?.readFile ?? defaultReadFile;
  const originalContents = await reader(filePath).catch((err: unknown) => {
    throw new Error(`Failed to read file to update ${filePath}: ${formatErrorMessage(err)}`);
  });

  // Normalizing mixed endings would rewrite untouched lines across the file.
  // Keep the existing localized behavior unless every terminator is CRLF.
  const preserveCrlf = hasOnlyCrlfLineEndings(originalContents);
  const matchingContents = preserveCrlf ? normalizeToLF(originalContents) : originalContents;
  const originalLines = matchingContents.split("\n");
  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
    originalLines.pop();
  }

  const replacements = computeReplacements(originalLines, filePath, chunks);
  let newLines = applyReplacements(originalLines, replacements);
  if (newLines.length === 0 || newLines[newLines.length - 1] !== "") {
    newLines = [...newLines, ""];
  }
  const updatedContents = newLines.join("\n");
  return preserveCrlf ? restoreLineEndings(updatedContents, "\r\n") : updatedContents;
}

function computeReplacements(
  originalLines: string[],
  filePath: string,
  chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const contextSearch = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
      if (contextSearch.kind === "ambiguous") {
        throw new Error(
          `Found ${contextSearch.occurrences} occurrences of context '${chunk.changeContext}' in ${filePath}. The context must be unique; use a more specific @@ context line.`,
        );
      }
      if (contextSearch.kind === "missing") {
        throw new Error(`Failed to find context '${chunk.changeContext}' in ${filePath}`);
      }
      lineIndex = contextSearch.index + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIndex =
        chunk.changeContext && !chunk.isEndOfFile
          ? lineIndex
          : originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
            ? originalLines.length - 1
            : originalLines.length;
      replacements.push([insertionIndex, 0, chunk.newLines]);
      lineIndex = insertionIndex;
      continue;
    }

    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let search = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);

    if (search.kind === "missing" && pattern[pattern.length - 1] === "") {
      // Parsed hunks may carry an EOF sentinel as a blank trailing line. Retry
      // without it so equivalent file contents still match.
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
        newSlice = newSlice.slice(0, -1);
      }
      search = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (search.kind === "ambiguous") {
      throw new Error(
        `Found ${search.occurrences} occurrences of these lines in ${filePath}. The lines must be unique; include more surrounding lines in the hunk:\n${chunk.oldLines.join("\n")}`,
      );
    }
    if (search.kind === "missing") {
      throw new Error(
        `Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`,
      );
    }
    const found = search.index;

    replacements.push([
      found,
      pattern.length,
      keepContextBytes({
        originalLines,
        matchIndex: found,
        patternLength: pattern.length,
        newSlice,
        contextOldIndexes: chunk.contextOldIndexes,
      }),
    ]);
    lineIndex = found + pattern.length;
  }

  replacements.sort((a, b) => a[0] - b[0]);
  return replacements;
}

function keepContextBytes(params: {
  originalLines: string[];
  matchIndex: number;
  patternLength: number;
  newSlice: string[];
  contextOldIndexes: Array<number | undefined>;
}): string[] {
  const { originalLines, matchIndex, patternLength, newSlice, contextOldIndexes } = params;
  return newSlice.map((line, index) => {
    const oldIndex = contextOldIndexes.at(index);
    if (oldIndex === undefined || oldIndex >= patternLength) {
      return line;
    }
    return originalLines.at(matchIndex + oldIndex) ?? line;
  });
}

function applyReplacements(
  lines: string[],
  replacements: Array<[number, number, string[]]>,
): string[] {
  const result = [...lines];
  // Apply from the end of the file backward so earlier replacement indexes stay
  // stable while later replacements mutate the array.
  for (const [startIndex, oldLen, newLines] of [...replacements].toReversed()) {
    for (let i = 0; i < oldLen; i += 1) {
      if (startIndex < result.length) {
        result.splice(startIndex, 1);
      }
    }
    for (const [i, line] of newLines.entries()) {
      result.splice(startIndex + i, 0, line);
    }
  }
  return result;
}

type SequenceSearch =
  | { kind: "found"; index: number }
  | { kind: "ambiguous"; occurrences: number }
  | { kind: "missing" };

function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): SequenceSearch {
  if (pattern.length === 0) {
    return { kind: "found", index: start };
  }
  if (pattern.length > lines.length) {
    return { kind: "missing" };
  }

  const maxStart = lines.length - pattern.length;
  const searchStart = eof && lines.length >= pattern.length ? maxStart : start;
  if (searchStart > maxStart) {
    return { kind: "missing" };
  }

  // Fall back through increasingly tolerant comparisons. This preserves normal
  // exact matching while accepting whitespace/punctuation differences common in
  // generated patch text.
  const normalizers = [
    (value: string) => value,
    (value: string) => value.trimEnd(),
    (value: string) => value.trim(),
    (value: string) => normalizePunctuation(value.trim()),
  ];
  for (const normalize of normalizers) {
    let index: number | null = null;
    let occurrences = 0;
    for (let i = searchStart; i <= maxStart; i += 1) {
      if (linesMatch(lines, pattern, i, normalize)) {
        index ??= i;
        occurrences += 1;
      }
    }
    if (index !== null) {
      // Later tiers are broader, so only the first tier with any matches decides.
      return occurrences === 1 ? { kind: "found", index } : { kind: "ambiguous", occurrences };
    }
  }

  return { kind: "missing" };
}

function linesMatch(
  lines: string[],
  pattern: string[],
  start: number,
  normalize: (value: string) => string,
): boolean {
  for (let idx = 0; idx < pattern.length; idx += 1) {
    const line = lines.at(start + idx);
    const expected = pattern.at(idx);
    if (line === undefined || expected === undefined || normalize(line) !== normalize(expected)) {
      return false;
    }
  }
  return true;
}

function normalizePunctuation(value: string): string {
  return value
    .replace(DASH_PUNCTUATION, "-")
    .replace(SINGLE_QUOTE_PUNCTUATION, "'")
    .replace(DOUBLE_QUOTE_PUNCTUATION, '"')
    .replace(SPACE_PUNCTUATION, " ");
}
