/**
 * Shared diff computation utilities for the edit tool.
 * Used by both edit.ts (for execution) and tool-execution.ts (for preview rendering).
 */

import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import * as Diff from "diff";
import { levenshteinDistance } from "../../../shared/levenshtein-distance.js";
import { resolveToCwd } from "./path-utils.js";

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) {
    return "\n";
  }
  if (crlfIdx === -1) {
    return "\n";
  }
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      // Strip trailing whitespace per line
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // Smart single quotes → '
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // Smart double quotes → "
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // Various dashes/hyphens → -
      // U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
      // U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      // Special spaces → regular space
      // U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
      // U+205F medium math space, U+3000 ideographic space
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
  );
}

interface FuzzyMatchResult {
  /** Whether a match was found */
  found: boolean;
  /** The index where the match starts (in the content that should be used for replacement) */
  index: number;
  /** Length of the matched text */
  matchLength: number;
  /** Whether fuzzy matching was used (false = exact match) */
  usedFuzzyMatch: boolean;
  /**
   * The content to use for replacement operations.
   * When exact match: original content. When fuzzy match: normalized content.
   */
  contentForReplacement: string;
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

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

interface LineSpan {
  start: number;
  end: number;
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;
  const startLine = lines.findIndex(
    (line) => replacementStart >= line.start && replacementStart < line.end,
  );
  if (startLine === -1) {
    throw new Error("Replacement range is outside the base content.");
  }

  let endLine = startLine;
  while (endLine < lines.length) {
    const line = lines.at(endLine);
    if (!line || line.end >= replacementEnd) {
      break;
    }
    endLine++;
  }
  if (endLine >= lines.length) {
    throw new Error("Replacement range is outside the base content.");
  }
  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
  let result = content;
  for (const replacement of replacements.toReversed()) {
    const matchIndex = replacement.matchIndex - offset;
    result =
      result.slice(0, matchIndex) +
      replacement.newText +
      result.slice(matchIndex + replacement.matchLength);
  }
  return result;
}

/**
 * Rewrite only lines touched by fuzzy replacements. Untouched lines retain
 * their original bytes even though matching used normalized content.
 */
function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: TextReplacement[],
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error(
      "Cannot preserve unchanged lines because the base content has a different line count.",
    );
  }

  const groups: Array<{
    startLine: number;
    endLine: number;
    replacements: TextReplacement[];
  }> = [];
  const sortedReplacements = replacements.toSorted((a, b) => a.matchIndex - b.matchIndex);
  for (const replacement of sortedReplacements) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups.at(-1);
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
    } else {
      groups.push({ ...range, replacements: [replacement] });
    }
  }

  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");
    const firstLine = baseLines.at(group.startLine);
    const lastLine = baseLines.at(group.endLine - 1);
    if (!firstLine || !lastLine) {
      throw new Error("Replacement group is outside the base content.");
    }
    const groupStartOffset = firstLine.start;
    const groupEndOffset = lastLine.end;
    result += applyReplacements(
      baseContent.slice(groupStartOffset, groupEndOffset),
      group.replacements,
      groupStartOffset,
    );
    originalLineIndex = group.endLine;
  }
  return result + originalLines.slice(originalLineIndex).join("");
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * When fuzzy matching is used, the returned contentForReplacement is the
 * fuzzy-normalized version of the content (trailing whitespace stripped,
 * Unicode quotes/dashes normalized to ASCII).
 */
function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  // Try exact match first
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  // Try fuzzy match - work entirely in normalized space
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  // When fuzzy matching, we work in the normalized space for replacement.
  // This means the output will have normalized whitespace/quotes/dashes,
  // which is acceptable since we're fixing minor formatting differences anyway.
  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent,
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
  return fuzzyContent.split(fuzzyOldText).length - 1;
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

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. If any edit needs
 * fuzzy matching, only touched lines are rewritten from normalized content.
 */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Edit[],
  path: string,
): { baseContent: string; newContent: string } {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (const [i, edit] of normalizedEdits.entries()) {
    if (edit.oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length);
    }
  }

  const initialMatches = normalizedEdits.map((edit) =>
    fuzzyFindText(normalizedContent, edit.oldText),
  );
  const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
  const replacementBaseContent = usedFuzzyMatch
    ? normalizeForFuzzyMatch(normalizedContent)
    : normalizedContent;

  const matchedEdits: MatchedEdit[] = [];
  for (const [i, edit] of normalizedEdits.entries()) {
    const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
    if (!matchResult.found) {
      throw getNotFoundError(path, i, normalizedEdits.length, normalizedContent, edit.oldText);
    }

    const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
    if (occurrences > 1) {
      throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
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
  const newContent = usedFuzzyMatch
    ? applyReplacementsPreservingUnchangedLines(
        normalizedContent,
        replacementBaseContent,
        matchedEdits,
      )
    : applyReplacements(replacementBaseContent, matchedEdits);

  if (baseContent === newContent) {
    throw getNoChangeError(path, normalizedEdits.length);
  }

  return { baseContent, newContent };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(
  path: string,
  oldContent: string,
  newContent: string,
  contextLines = 4,
): string {
  return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
    context: contextLines,
    headerOptions: Diff.FILE_HEADERS_ONLY,
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
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (const [i, part] of parts.entries()) {
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") {
      raw.pop();
    }

    if (part.added || part.removed) {
      // Capture the first changed line (in the new file)
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum;
      }

      // Show the change
      for (const line of raw) {
        if (part.added) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
          output.push(`+${lineNum} ${line}`);
          newLineNum++;
        } else {
          // removed
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(`-${lineNum} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      // Context lines - only show a few before/after changes
      const nextPart = parts.at(i + 1);
      const nextPartIsChange = Boolean(nextPart?.added || nextPart?.removed);
      const hasLeadingChange = lastWasChange;
      const hasTrailingChange = nextPartIsChange;

      if (hasLeadingChange && hasTrailingChange) {
        if (raw.length <= contextLines * 2) {
          for (const line of raw) {
            const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        } else {
          const leadingLines = raw.slice(0, contextLines);
          const trailingLines = raw.slice(raw.length - contextLines);
          const skippedLines = raw.length - leadingLines.length - trailingLines.length;

          for (const line of leadingLines) {
            const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }

          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;

          for (const line of trailingLines) {
            const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        }
      } else if (hasLeadingChange) {
        const shownLines = raw.slice(0, contextLines);
        const skippedLines = raw.length - shownLines.length;

        for (const line of shownLines) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }

        if (skippedLines > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
        }
      } else if (hasTrailingChange) {
        const skippedLines = Math.max(0, raw.length - contextLines);
        if (skippedLines > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
        }

        for (const line of raw.slice(skippedLines)) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
      } else {
        // Skip these context lines entirely
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }

      lastWasChange = false;
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
    const fuzzyNoOp = normalizeForFuzzyMatch(edit.oldText) === normalizeForFuzzyMatch(edit.newText);
    if (edit.oldText === edit.newText || fuzzyNoOp) {
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
): Promise<EditDiffResult | EditDiffError> {
  const absolutePath = resolveToCwd(path, cwd);

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
