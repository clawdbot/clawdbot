/**
 * Shared diff computation utilities for the edit tool.
 * Used by both edit.ts (for execution) and tool-execution.ts (for preview rendering).
 */

import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createPatch, FILE_HEADERS_ONLY, structuredPatch } from "diff";
import { levenshteinDistance } from "../../../shared/levenshtein-distance.js";
import { normalizeToLF } from "../../line-endings.js";
import {
  applyReplacements,
  applyReplacementsPreservingLineEndings,
  type TextReplacement,
} from "./edit-replacements.js";
import { resolveLocalPathToCwd, resolveToCwd } from "./path-utils.js";

interface FuzzyBoundary {
  /** Original offset when the normalized boundary begins a replacement. */
  start?: number;
  /** Original offset when the normalized boundary ends a replacement. */
  end?: number;
}

interface FuzzyNormalizedFile {
  text: string;
  boundaries: Array<FuzzyBoundary | undefined>;
}

const fuzzyGraphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function foldFuzzyCharacters(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 *
 */
function normalizeForFuzzyMatch(text: string): string {
  return foldFuzzyCharacters(
    text
      .normalize("NFKC")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n"),
  );
}

function buildNfkcBoundaries(
  text: string,
  authoritativeNfkc: string,
): FuzzyNormalizedFile["boundaries"] | undefined {
  const boundaries: Array<FuzzyBoundary | undefined> = [];
  const normalizedSegments: string[] = [];
  let normalizedOffset = 0;

  for (const segment of fuzzyGraphemeSegmenter.segment(text)) {
    const sourceStart = segment.index;
    const sourceEnd = sourceStart + segment.segment.length;
    const normalizedSegment = segment.segment.normalize("NFKC");
    normalizedSegments.push(normalizedSegment);

    const boundary = boundaries[normalizedOffset] ?? {};
    if (normalizedSegment.length === 0) {
      // Preserve omitted source text on either side of this collapsed boundary.
      boundaries[normalizedOffset] = {
        end: boundary.end ?? sourceStart,
        start: sourceEnd,
      };
      continue;
    }

    boundaries[normalizedOffset] = {
      start: boundary.start ?? sourceStart,
      end: boundary.end ?? sourceStart,
    };
    normalizedOffset += normalizedSegment.length;
    boundaries[normalizedOffset] = { start: sourceEnd, end: sourceEnd };
  }

  // Grapheme segmentation is only a mapping aid. Whole-string NFKC remains
  // authoritative; fail closed if a runtime ever segments it differently.
  if (normalizedSegments.join("") !== authoritativeNfkc) {
    return undefined;
  }
  return boundaries;
}

function buildFuzzyNormalizedFile(text: string): FuzzyNormalizedFile | undefined {
  const authoritativeNfkc = text.normalize("NFKC");
  const nfkcBoundaries = buildNfkcBoundaries(text, authoritativeNfkc);
  if (!nfkcBoundaries) {
    return undefined;
  }

  const boundaries: Array<FuzzyBoundary | undefined> = [];
  let sourceLineStart = 0;
  let normalizedLineStart = 0;

  while (sourceLineStart <= authoritativeNfkc.length) {
    const newlineIndex = authoritativeNfkc.indexOf("\n", sourceLineStart);
    const sourceLineEnd = newlineIndex === -1 ? authoritativeNfkc.length : newlineIndex;
    const line = authoritativeNfkc.slice(sourceLineStart, sourceLineEnd);
    const keptLineEnd = sourceLineStart + line.trimEnd().length;

    for (let offset = sourceLineStart; offset <= keptLineEnd; offset++) {
      const boundary = nfkcBoundaries[offset];
      if (boundary) {
        boundaries[normalizedLineStart + offset - sourceLineStart] = { ...boundary };
      }
    }

    const normalizedLineEnd = normalizedLineStart + keptLineEnd - sourceLineStart;
    if (keptLineEnd < sourceLineEnd) {
      const beforeTrim = nfkcBoundaries[keptLineEnd];
      const afterTrim = nfkcBoundaries[sourceLineEnd];
      boundaries[normalizedLineEnd] = {
        end: beforeTrim?.end,
        start: afterTrim?.start,
      };
    }

    if (newlineIndex === -1) {
      break;
    }

    const afterNewline = nfkcBoundaries[sourceLineEnd + 1];
    boundaries[normalizedLineEnd + 1] = afterNewline ? { ...afterNewline } : undefined;
    normalizedLineStart = normalizedLineEnd + 1;
    sourceLineStart = sourceLineEnd + 1;
  }

  const normalizedText = normalizeForFuzzyMatch(text);
  if (boundaries.length > normalizedText.length + 1) {
    return undefined;
  }
  return { text: normalizedText, boundaries };
}

function translateFuzzySpan(
  normalized: FuzzyNormalizedFile,
  fuzzyStart: number,
  fuzzyLength: number,
): { originalStart: number; originalLength: number } | undefined {
  const fuzzyEnd = fuzzyStart + fuzzyLength;
  const originalStart = normalized.boundaries[fuzzyStart]?.start;
  const originalEnd = normalized.boundaries[fuzzyEnd]?.end;
  if (originalStart === undefined || originalEnd === undefined) {
    return undefined;
  }
  return {
    originalStart,
    originalLength: originalEnd - originalStart,
  };
}

interface FuzzyMatchResult {
  /** Whether a match was found */
  found: boolean;
  /** The index where the match starts (in original-content coordinates) */
  index: number;
  /** Length of the matched text (in original-content coordinates) */
  matchLength: number;
  /** Whether fuzzy matching was used (false = exact match) */
  usedFuzzyMatch: boolean;
  /** The normalized match exists but cannot map to an unambiguous source span. */
  unsafeBoundary?: boolean;
}

export interface Edit {
  oldText: string;
  newText: string;
}

export class EditNoChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditNoChangeError";
  }
}

interface MatchedEdit extends TextReplacement {
  editIndex: number;
}

interface AppliedEdits {
  baseContent: string;
  newContent: string;
  replacementBaseContent: string;
  replacements: MatchedEdit[];
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * When fuzzy matching is used and an offsetMap is provided, the returned
 * index and matchLength are translated back to original-content coordinates
 * so the caller can apply replacements against the un-normalized content.
 */
function fuzzyFindText(
  content: string,
  oldText: string,
  normalizedFile?: FuzzyNormalizedFile,
): FuzzyMatchResult {
  // Try exact match first
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
    };
  }

  // Try fuzzy match - work entirely in normalized space
  const fuzzyContent = normalizedFile?.text ?? normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  if (!fuzzyOldText) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: true,
      unsafeBoundary: true,
    };
  }
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
    };
  }

  const translated = normalizedFile
    ? translateFuzzySpan(normalizedFile, fuzzyIndex, fuzzyOldText.length)
    : undefined;
  if (!translated) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: true,
      unsafeBoundary: true,
    };
  }

  return {
    found: true,
    index: translated.originalStart,
    matchLength: translated.originalLength,
    usedFuzzyMatch: true,
  };
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  if (!fuzzyOldText) {
    return 0;
  }
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

function countExactOccurrences(content: string, oldText: string): number {
  return content.split(oldText).length - 1;
}

const EDIT_CANDIDATE_LIMIT = 3;
const EDIT_CANDIDATE_MAX_LINES = 1000;
const EDIT_CANDIDATE_MAX_SCAN_CHARS = 128 * 1024;
const EDIT_CANDIDATE_MAX_LINE_CHARS = 120;
const EDIT_CANDIDATE_MIN_SCORE = 0.45;

interface EditCandidate {
  lineNumber: number;
  line: string;
  score: number;
}

function truncateCandidateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const cut =
    maxChars > 0 &&
    /[\uD800-\uDBFF]/.test(text.charAt(maxChars - 1)) &&
    /[\uDC00-\uDFFF]/.test(text.charAt(maxChars))
      ? maxChars - 1
      : maxChars;
  return text.slice(0, cut);
}

function getBoundedLines(text: string, maxLines: number, maxScanChars: number): string[] {
  return truncateCandidateText(text, maxScanChars)
    .split("\n", maxLines)
    .map((line) => truncateCandidateText(line, EDIT_CANDIDATE_MAX_LINE_CHARS));
}

function scoreCandidate(expected: string, candidate: string): number {
  const normalizedExpected = expected.trim();
  const normalizedCandidate = candidate.trim();
  const maxLength = Math.max(normalizedExpected.length, normalizedCandidate.length);
  if (maxLength === 0) {
    return 0;
  }

  // Length alone sets an upper bound on the possible similarity score.
  if (
    Math.min(normalizedExpected.length, normalizedCandidate.length) / maxLength <
    EDIT_CANDIDATE_MIN_SCORE
  ) {
    return 0;
  }

  return 1 - levenshteinDistance(normalizedExpected, normalizedCandidate) / maxLength;
}

function describeIndentation(line: string): string {
  const indentation = line.match(/^[ \t]*/)?.[0] ?? "";
  if (!indentation) {
    return "none";
  }
  const tabs = indentation.match(/\t/g)?.length ?? 0;
  const spaces = indentation.length - tabs;
  return tabs === 0 ? `${spaces} spaces` : `${spaces} spaces and ${tabs} tabs`;
}

function firstDifferenceIndex(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index++) {
    if (left.charAt(index) !== right.charAt(index)) {
      return index;
    }
  }
  return left.length === right.length ? -1 : sharedLength;
}

function describeCandidateDifference(expected: string, found: string): string {
  const expectedIndentation = expected.match(/^[ \t]*/)?.[0] ?? "";
  const foundIndentation = found.match(/^[ \t]*/)?.[0] ?? "";
  if (expectedIndentation !== foundIndentation) {
    return `indentation differs (expected ${describeIndentation(expected)}, found ${describeIndentation(found)})`;
  }

  const expectedBackslashes = expected.match(/\\/g)?.length ?? 0;
  const foundBackslashes = found.match(/\\/g)?.length ?? 0;
  if (expectedBackslashes !== foundBackslashes) {
    return `escaping differs (expected ${expectedBackslashes} backslashes, found ${foundBackslashes})`;
  }

  const differenceIndex = firstDifferenceIndex(expected, found);
  return differenceIndex === -1
    ? "this line matches; surrounding lines differ"
    : `first difference at column ${differenceIndex + 1}`;
}

function getCandidateHint(content: string, oldText: string): string {
  const expected = getBoundedLines(oldText, 32, 4096).reduce(
    (best, line) => (line.trim().length > best.trim().length ? line : best),
    "",
  );
  if (!expected.trim()) {
    return "";
  }
  const candidates = getBoundedLines(
    content,
    EDIT_CANDIDATE_MAX_LINES,
    EDIT_CANDIDATE_MAX_SCAN_CHARS,
  )
    .map((line, index): EditCandidate | undefined => {
      const score = scoreCandidate(expected, line);
      return score >= EDIT_CANDIDATE_MIN_SCORE ? { lineNumber: index + 1, line, score } : undefined;
    })
    .filter((candidate): candidate is EditCandidate => candidate !== undefined)
    .toSorted((left, right) => right.score - left.score || left.lineNumber - right.lineNumber)
    .slice(0, EDIT_CANDIDATE_LIMIT);
  if (candidates.length === 0) {
    return "";
  }
  const expectedDisplay = JSON.stringify(expected);
  return (
    "\nClosest matching lines:\n" +
    candidates
      .map((candidate) => {
        const foundDisplay = JSON.stringify(candidate.line);
        const differenceIndex = firstDifferenceIndex(expectedDisplay, foundDisplay);
        const markerIndex =
          differenceIndex === -1
            ? Math.min(expectedDisplay.length, foundDisplay.length)
            : differenceIndex;
        const markerWidth = Math.max(
          1,
          Math.min(12, Math.max(expectedDisplay.length, foundDisplay.length) - markerIndex),
        );
        return [
          `  near line ${candidate.lineNumber} (${Math.round(candidate.score * 100)}% match):`,
          `    expected: ${expectedDisplay}`,
          `    found:    ${foundDisplay}`,
          `              ${" ".repeat(markerIndex)}${"^".repeat(markerWidth)}`,
          `    hint: ${describeCandidateDifference(expected, candidate.line)}`,
        ].join("\n");
      })
      .join("\n")
  );
}

function getNotFoundError(
  path: string,
  editIndex: number,
  totalEdits: number,
  content: string,
  oldText: string,
): Error {
  const prefix =
    totalEdits === 1 ? "Could not find the exact text" : `Could not find edits[${editIndex}]`;
  const hint = getCandidateHint(content, oldText);
  return new Error(
    `${prefix} in ${path}. The old text must match exactly including all whitespace and newlines.${hint}`,
  );
}

function getDuplicateError(
  path: string,
  editIndex: number,
  totalEdits: number,
  occurrences: number,
): Error {
  if (totalEdits === 1) {
    return new Error(
      `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
    );
  }
  return new Error(
    `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
  );
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(`oldText must not be empty in ${path}.`);
  }
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): EditNoChangeError {
  if (totalEdits === 1) {
    return new EditNoChangeError(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
    );
  }
  return new EditNoChangeError(
    `No changes made to ${path}. The replacements produced identical content.`,
  );
}

function getUnsafeFuzzyBoundaryError(path: string, editIndex: number, totalEdits: number): Error {
  const target = totalEdits === 1 ? "The fuzzy match" : `The fuzzy match for edits[${editIndex}]`;
  return new Error(
    `${target} in ${path} crosses an ambiguous Unicode-normalization or trimmed-whitespace boundary. Copy the exact source text or use a span whose normalized boundaries map cleanly.`,
  );
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. Fuzzy matching is
 * lookup-only: replacements always splice into the original content.
 */
function applyEdits(normalizedContent: string, edits: Edit[], path: string): AppliedEdits {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (const [i, edit] of normalizedEdits.entries()) {
    if (edit.oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length);
    }
  }

  const needsFuzzyMapping = normalizedEdits.some(
    (edit) => !normalizedContent.includes(edit.oldText),
  );
  const fuzzyFile = needsFuzzyMapping ? buildFuzzyNormalizedFile(normalizedContent) : undefined;
  const replacementBaseContent = normalizedContent;

  const matchedEdits: MatchedEdit[] = [];
  for (const [i, edit] of normalizedEdits.entries()) {
    const matchResult = fuzzyFindText(normalizedContent, edit.oldText, fuzzyFile);
    const occurrences = matchResult.usedFuzzyMatch
      ? countOccurrences(normalizedContent, edit.oldText)
      : countExactOccurrences(replacementBaseContent, edit.oldText);
    if (occurrences > 1) {
      throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
    }
    if (matchResult.unsafeBoundary) {
      throw getUnsafeFuzzyBoundaryError(path, i, normalizedEdits.length);
    }
    if (!matchResult.found) {
      throw getNotFoundError(path, i, normalizedEdits.length, normalizedContent, edit.oldText);
    }

    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText,
    });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits.at(i - 1);
    const current = matchedEdits.at(i);
    if (!previous || !current) {
      continue;
    }
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  const baseContent = normalizedContent;
  const newContent = applyReplacements(replacementBaseContent, matchedEdits);

  if (baseContent === newContent) {
    throw getNoChangeError(path, normalizedEdits.length);
  }

  return {
    baseContent,
    newContent,
    replacementBaseContent,
    replacements: matchedEdits,
  };
}

function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Edit[],
  path: string,
): { baseContent: string; newContent: string } {
  const { baseContent, newContent } = applyEdits(normalizedContent, edits, path);
  return { baseContent, newContent };
}

export function applyEditsPreservingLineEndings(
  originalContent: string,
  edits: Edit[],
  path: string,
): { baseContent: string; newContent: string; finalContent: string } {
  const applied = applyEdits(normalizeToLF(originalContent), edits, path);
  const finalContent = applyReplacementsPreservingLineEndings(
    originalContent,
    applied.replacementBaseContent,
    applied.replacements,
  );
  if (normalizeToLF(finalContent) !== applied.newContent) {
    throw new Error("Line-ending restoration changed the normalized edit result.");
  }
  return {
    baseContent: applied.baseContent,
    newContent: applied.newContent,
    finalContent,
  };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(
  path: string,
  oldContent: string,
  newContent: string,
  contextLines = 4,
): string {
  return createPatch(path, oldContent, newContent, undefined, undefined, {
    context: contextLines,
    headerOptions: FILE_HEADERS_ONLY,
  });
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const hunks = structuredPatch("", "", oldContent, newContent, undefined, undefined, {
    context: contextLines,
  }).hunks;
  const oldLineCount = oldContent.split("\n").length;
  const newLineCount = newContent.split("\n").length;
  const lastNewLine = newContent === "" ? 0 : newLineCount - Number(newContent.endsWith("\n"));
  const maxLineNum = Math.max(oldLineCount, newLineCount);
  const lineNumWidth = String(maxLineNum).length;
  const ellipsis = ` ${"".padStart(lineNumWidth, " ")} ...`;
  const output: string[] = [];
  let firstChangedLine: number | undefined;

  for (const [hunkIndex, hunk] of hunks.entries()) {
    if (hunkIndex > 0 || hunk.newStart > 1) {
      output.push(ellipsis);
    }

    let oldLineNum = hunk.oldStart;
    let newLineNum = hunk.newStart;
    for (const line of hunk.lines) {
      const prefix = line[0];
      if (prefix === "\\") {
        continue;
      }
      if (firstChangedLine === undefined && prefix !== " ") {
        firstChangedLine = newLineNum;
      }
      const lineNum = prefix === "-" ? oldLineNum : newLineNum;
      output.push(`${prefix}${String(lineNum).padStart(lineNumWidth, " ")} ${line.slice(1)}`);
      oldLineNum += prefix === "+" ? 0 : 1;
      newLineNum += prefix === "-" ? 0 : 1;
    }

    if (hunkIndex === hunks.length - 1 && hunk.newStart + hunk.newLines <= lastNewLine) {
      output.push(ellipsis);
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
  diff: string;
  firstChangedLine: number | undefined;
}

export interface EditDiffError {
  error: string;
}

export function validateNoOpEditTargets(
  normalizedContent: string,
  noOpEdits: Edit[],
  realEdits: Edit[],
  path: string,
): void {
  if (noOpEdits.length > 0) {
    applyEditsToNormalizedContent(
      normalizedContent,
      noOpEdits.map((edit) => ({ oldText: edit.oldText, newText: "" })),
      path,
    );
  }
  const exactNoOpEdits = noOpEdits.filter((edit) =>
    normalizedContent.includes(normalizeToLF(edit.oldText)),
  );
  if (exactNoOpEdits.length > 0 && realEdits.length > 0) {
    applyEditsToNormalizedContent(
      normalizedContent,
      [...exactNoOpEdits, ...realEdits].map((edit) => ({
        oldText: edit.oldText,
        newText: "",
      })),
      path,
    );
  }
}

export function splitNoOpEdits(
  normalizedContent: string,
  edits: Edit[],
  path: string,
): { noOpEdits: Edit[]; realEdits: Edit[] } {
  const noOpEdits: Edit[] = [];
  const realEdits: Edit[] = [];
  for (const edit of edits) {
    if (edit.oldText === edit.newText) {
      applyEditsToNormalizedContent(
        normalizedContent,
        [{ oldText: edit.oldText, newText: "" }],
        path,
      );
      noOpEdits.push(edit);
    } else {
      realEdits.push(edit);
    }
  }
  return { noOpEdits, realEdits };
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
  path: string,
  edits: Edit[],
  cwd: string,
  operations?: {
    readFile: (absolutePath: string) => Promise<Buffer | string>;
    access: (absolutePath: string) => Promise<void>;
  },
  resolvePath = operations ? resolveToCwd : resolveLocalPathToCwd,
): Promise<EditDiffResult | EditDiffError> {
  const absolutePath = resolvePath(path, cwd);

  try {
    // Check if file exists and is readable
    try {
      if (operations) {
        await operations.access(absolutePath);
      } else {
        await access(absolutePath, constants.R_OK);
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error && "code" in error
          ? `Error code: ${String(error.code)}`
          : String(error);
      return { error: `Could not edit file: ${path}. ${errorMessage}.` };
    }

    // Read the file
    const rawContentResult = operations
      ? await operations.readFile(absolutePath)
      : await readFile(absolutePath, "utf-8");
    const rawContent =
      typeof rawContentResult === "string" ? rawContentResult : rawContentResult.toString("utf-8");

    // Strip BOM before matching (LLM won't include invisible BOM in oldText)
    const { text: content } = stripBom(rawContent);
    const normalizedContent = normalizeToLF(content);
    const { noOpEdits, realEdits } = splitNoOpEdits(normalizedContent, edits, path);
    validateNoOpEditTargets(normalizedContent, noOpEdits, realEdits, path);
    if (realEdits.length === 0) {
      return { diff: "", firstChangedLine: undefined };
    }
    const { baseContent, newContent } = applyEditsToNormalizedContent(
      normalizedContent,
      realEdits,
      path,
    );

    // Generate the diff
    return generateDiffString(baseContent, newContent);
  } catch (err) {
    if (err instanceof EditNoChangeError) {
      return { diff: "", firstChangedLine: undefined };
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
