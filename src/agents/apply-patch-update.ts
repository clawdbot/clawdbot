/**
 * Update-hunk application for the apply_patch parser.
 * Locates expected old lines with tolerant matching, applies chunks in order,
 * and returns normalized file contents with a trailing newline.
 */
import fs from "node:fs/promises";
import { formatErrorMessage } from "../infra/errors.js";

const DASH_PUNCTUATION = /[\u2010-\u2015\u2212]/g;
const SINGLE_QUOTE_PUNCTUATION = /[\u2018-\u201B]/g;
const DOUBLE_QUOTE_PUNCTUATION = /[\u201C-\u201F]/g;
const SPACE_PUNCTUATION = /[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g;

type UpdateFileChunk = {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
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

  const originalLines = originalContents.split("\n");
  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
    originalLines.pop();
  }

  const replacements = computeReplacements(originalLines, filePath, chunks);
  let newLines = applyReplacements(originalLines, replacements);
  if (newLines.length === 0 || newLines[newLines.length - 1] !== "") {
    newLines = [...newLines, ""];
  }
  return newLines.join("\n");
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
      const ctxIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
      if (ctxIndex === null) {
        throw new Error(`Failed to find context '${chunk.changeContext}' in ${filePath}`);
      }
      lineIndex = ctxIndex + 1;
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
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);

    if (found === null && pattern[pattern.length - 1] === "") {
      // Parsed hunks may carry an EOF sentinel as a blank trailing line. Retry
      // without it so equivalent file contents still match.
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (found === null) {
      throw new Error(
        `Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`,
      );
    }

    replacements.push([found, pattern.length, newSlice]);
    lineIndex = found + pattern.length;
  }

  replacements.sort((a, b) => a[0] - b[0]);
  return replacements;
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

function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): number | null {
  if (pattern.length === 0) {
    return start;
  }
  if (pattern.length > lines.length) {
    return null;
  }

  const maxStart = lines.length - pattern.length;
  const searchStart = eof && lines.length >= pattern.length ? maxStart : start;
  if (searchStart > maxStart) {
    return null;
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
    for (let i = searchStart; i <= maxStart; i += 1) {
      if (linesMatch(lines, pattern, i, normalize)) {
        return i;
      }
    }
  }

  return null;
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
