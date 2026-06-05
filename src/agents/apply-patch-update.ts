/**
 * Update-hunk application for the apply_patch parser.
 * Locates expected old lines with tolerant matching, applies chunks in order,
 * and returns normalized file contents with a trailing newline.
 */
import fs from "node:fs/promises";
import { formatErrorMessage } from "../infra/errors.js";

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
    for (let i = 0; i < newLines.length; i += 1) {
      result.splice(startIndex + i, 0, newLines[i]);
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

  for (let i = searchStart; i <= maxStart; i += 1) {
    if (linesMatch(lines, pattern, i, (value) => value)) {
      return i;
    }
  }
  // Fall back through increasingly tolerant comparisons. This preserves normal
  // exact matching while accepting whitespace/punctuation differences common in
  // generated patch text.
  for (let i = searchStart; i <= maxStart; i += 1) {
    if (linesMatch(lines, pattern, i, (value) => value.trimEnd())) {
      return i;
    }
  }
  for (let i = searchStart; i <= maxStart; i += 1) {
    if (linesMatch(lines, pattern, i, (value) => value.trim())) {
      return i;
    }
  }
  for (let i = searchStart; i <= maxStart; i += 1) {
    if (linesMatch(lines, pattern, i, (value) => normalizePunctuation(value.trim()))) {
      return i;
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
    if (normalize(lines[start + idx]) !== normalize(pattern[idx])) {
      return false;
    }
  }
  return true;
}

function normalizePunctuation(value: string): string {
  return Array.from(value)
    .map((char) => {
      switch (char) {
        case "\u2010":
        case "\u2011":
        case "\u2012":
        case "\u2013":
        case "\u2014":
        case "\u2015":
        case "\u2212":
          return "-";
        case "\u2018":
        case "\u2019":
        case "\u201A":
        case "\u201B":
          return "'";
        case "\u201C":
        case "\u201D":
        case "\u201E":
        case "\u201F":
          return '"';
        case "\u00A0":
        case "\u2002":
        case "\u2003":
        case "\u2004":
        case "\u2005":
        case "\u2006":
        case "\u2007":
        case "\u2008":
        case "\u2009":
        case "\u200A":
        case "\u202F":
        case "\u205F":
        case "\u3000":
          return " ";
        default:
          return char;
      }
    })
    .join("");
}
