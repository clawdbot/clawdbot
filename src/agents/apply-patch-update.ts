/**
 * Update-hunk application for the apply_patch parser.
 * Locates expected old lines with tolerant matching, applies chunks in order,
 * and retains source bytes that the patch does not change.
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
  contextOldIndexes: Array<number | undefined>;
  isEndOfFile: boolean;
};

type LineEnding = "\r\n" | "\r" | "\n" | "";

type SourceLine = {
  text: string;
  ending: LineEnding;
};

type SourceFile = {
  bom: string;
  lines: SourceLine[];
  preferredEnding: Exclude<LineEnding, "">;
  missingFinalEnding: boolean;
};

type Replacement = [number, number, SourceLine[]];

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

  const source = parseSourceFile(originalContents);
  const replacements = computeReplacements(source, filePath, chunks);
  const newLines = applyReplacements(source.lines, replacements);
  ensureInteriorEndings(newLines, source.preferredEnding);
  return source.bom + newLines.map((line) => line.text + line.ending).join("");
}

function computeReplacements(
  source: SourceFile,
  filePath: string,
  chunks: UpdateFileChunk[],
): Replacement[] {
  const originalLines = source.lines.map((line) => line.text);
  const replacements: Replacement[] = [];
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
        chunk.changeContext && !chunk.isEndOfFile ? lineIndex : source.lines.length;
      const insertedLines = buildChangedLines({
        sourceLines: source.lines,
        startIndex: insertionIndex,
        oldCount: 0,
        newLines: chunk.newLines,
        preferredEnding: source.preferredEnding,
      });
      const finalInsertedLine = insertedLines.at(-1);
      if (
        source.missingFinalEnding &&
        insertionIndex === source.lines.length &&
        finalInsertedLine
      ) {
        finalInsertedLine.ending = "";
      }
      replacements.push([insertionIndex, 0, insertedLines]);
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
      buildChunkLines({
        source,
        matchIndex: found,
        pattern,
        newSlice,
        contextOldIndexes: chunk.contextOldIndexes,
      }),
    ]);
    lineIndex = found + pattern.length;
  }

  replacements.sort((a, b) => a[0] - b[0]);
  return replacements;
}

function buildChunkLines(params: {
  source: SourceFile;
  matchIndex: number;
  pattern: string[];
  newSlice: string[];
  contextOldIndexes: Array<number | undefined>;
}): SourceLine[] {
  const { source, matchIndex, pattern, newSlice, contextOldIndexes } = params;
  const lines: SourceLine[] = [];
  let oldStart = 0;
  let newStart = 0;

  // Tolerant matching may ignore whitespace or punctuation. Reuse matched
  // context records so bytes outside each explicit change stay untouched.
  for (const [newContext, oldContext] of contextOldIndexes.entries()) {
    if (oldContext === undefined || oldContext >= pattern.length || newContext >= newSlice.length) {
      continue;
    }
    lines.push(
      ...buildChangedLines({
        sourceLines: source.lines,
        startIndex: matchIndex + oldStart,
        oldCount: oldContext - oldStart,
        newLines: newSlice.slice(newStart, newContext),
        preferredEnding: source.preferredEnding,
      }),
      source.lines[matchIndex + oldContext]!,
    );
    oldStart = oldContext + 1;
    newStart = newContext + 1;
  }

  lines.push(
    ...buildChangedLines({
      sourceLines: source.lines,
      startIndex: matchIndex + oldStart,
      oldCount: pattern.length - oldStart,
      newLines: newSlice.slice(newStart),
      preferredEnding: source.preferredEnding,
    }),
  );
  return lines;
}

function buildChangedLines(params: {
  sourceLines: SourceLine[];
  startIndex: number;
  oldCount: number;
  newLines: string[];
  preferredEnding: Exclude<LineEnding, "">;
}): SourceLine[] {
  const { sourceLines, startIndex, oldCount, newLines, preferredEnding } = params;
  const replacedLines = sourceLines.slice(startIndex, startIndex + oldCount);
  const nearbyEnding =
    replacedLines.find((line) => line.ending)?.ending ||
    sourceLines.at(startIndex)?.ending ||
    sourceLines.at(startIndex - 1)?.ending ||
    preferredEnding;
  return newLines.map((text, index) => {
    let ending: LineEnding = nearbyEnding;
    if (replacedLines.length === newLines.length) {
      ending = replacedLines.at(index)?.ending ?? nearbyEnding;
    } else if (index === newLines.length - 1 && replacedLines.length > 0) {
      ending = replacedLines.at(-1)?.ending ?? nearbyEnding;
    } else if (index < replacedLines.length - 1) {
      ending = replacedLines.at(index)?.ending ?? nearbyEnding;
    }
    return { text, ending };
  });
}

function applyReplacements(lines: SourceLine[], replacements: Replacement[]): SourceLine[] {
  const result = [...lines];
  // Apply from the end of the file backward so earlier replacement indexes stay
  // stable while later replacements mutate the array.
  for (const [startIndex, oldLen, newLines] of [...replacements].toReversed()) {
    result.splice(startIndex, oldLen, ...newLines);
  }
  return result;
}

function parseSourceFile(contents: string): SourceFile {
  const bom = contents.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = bom ? contents.slice(1) : contents;
  const rawLines = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+/g) ?? [];
  const lines = rawLines.map(splitLineEnding);
  const preferredEnding = lines.find((line) => line.ending)?.ending || "\n";
  return {
    bom,
    lines,
    preferredEnding,
    missingFinalEnding: lines.length > 0 && lines.at(-1)?.ending === "",
  };
}

function splitLineEnding(line: string): SourceLine {
  if (line.endsWith("\r\n")) {
    return { text: line.slice(0, -2), ending: "\r\n" };
  }
  if (line.endsWith("\r")) {
    return { text: line.slice(0, -1), ending: "\r" };
  }
  if (line.endsWith("\n")) {
    return { text: line.slice(0, -1), ending: "\n" };
  }
  return { text: line, ending: "" };
}

function ensureInteriorEndings(
  lines: SourceLine[],
  preferredEnding: Exclude<LineEnding, "">,
): void {
  // An insertion can move an unterminated line inward. Only that interior
  // boundary needs a terminator; the final record already owns EOF state.
  for (const line of lines.slice(0, -1)) {
    line.ending ||= preferredEnding;
  }
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
  const searchStart = eof ? Math.max(start, maxStart) : start;
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
