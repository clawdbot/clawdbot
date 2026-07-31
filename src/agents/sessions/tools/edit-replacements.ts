import { detectLineEnding } from "../../line-endings.js";

export interface TextReplacement {
  matchIndex: number;
  matchLength: number;
  newText: string;
}

interface LineSpan {
  start: number;
  end: number;
}

interface ReplacementGroup {
  startLine: number;
  endLine: number;
  replacements: TextReplacement[];
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

export function applyReplacements(
  content: string,
  replacements: TextReplacement[],
  offset = 0,
): string {
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

function groupReplacementsByLine(
  baseContent: string,
  replacements: TextReplacement[],
): { lines: LineSpan[]; groups: ReplacementGroup[] } {
  const lines = getLineSpans(baseContent);
  const groups: ReplacementGroup[] = [];
  const sortedReplacements = replacements.toSorted((a, b) => a.matchIndex - b.matchIndex);
  for (const replacement of sortedReplacements) {
    const range = getReplacementLineRange(lines, replacement);
    const current = groups.at(-1);
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
    } else {
      groups.push({ ...range, replacements: [replacement] });
    }
  }
  return { lines, groups };
}

/**
 * Rewrite only lines touched by fuzzy replacements. Untouched lines retain
 * their original bytes even though matching used normalized content.
 */
export function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: TextReplacement[],
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const { lines: baseLines, groups } = groupReplacementsByLine(baseContent, replacements);
  if (originalLines.length !== baseLines.length) {
    throw new Error(
      "Cannot preserve unchanged lines because the base content has a different line count.",
    );
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

    // Use the ORIGINAL content for this line group, mapping replacement indices
    // from normalized space to original space. This ensures bytes outside the
    // matched span (e.g. Unicode CJK characters in comments, unusual symbols)
    // stay untouched instead of being silently NFKC-normalized.
    const originalGroupContent = originalLines.slice(group.startLine, group.endLine).join("");

    // Map replacements from normalized-space indices to original-space indices,
    // accounting for trailing whitespace that normalizeForFuzzyMatch's trimEnd()
    // removed from each line.
    const originalReplacements = group.replacements.map((r) => {
      const normLine = baseLines.findIndex(
        (l, i) =>
          i >= group.startLine &&
          i < group.endLine &&
          r.matchIndex >= l.start &&
          r.matchIndex < l.end,
      );
      const withinLineOffset = r.matchIndex - baseLines[normLine].start;
      const origLineStart = originalLines
        .slice(0, normLine)
        .reduce((sum, l) => sum + l.length, 0);

      // Compute original-space match length by walking through lines.
      const normMatchEnd = r.matchIndex + r.matchLength;
      const endNormLine = baseLines.findIndex(
        (l) => normMatchEnd > l.start && normMatchEnd <= l.end,
      );
      const matchEndsWithNewline =
        r.matchLength > 0 && baseContent[r.matchIndex + r.matchLength - 1] === "\n";
      let origMatchLen = r.matchLength;
      if (endNormLine >= 0) {
        let origEndOfMatch: number;
        if (matchEndsWithNewline) {
          // Match ends at line end — include full original line length
          origEndOfMatch = originalLines
            .slice(0, endNormLine + 1)
            .reduce((sum, l) => sum + l.length, 0);
        } else {
          // Match ends mid-line — same within-line position
          const lastLineOrigStart = originalLines
            .slice(0, endNormLine)
            .reduce((sum, l) => sum + l.length, 0);
          const withinLastLine = normMatchEnd - baseLines[endNormLine].start;
          origEndOfMatch = lastLineOrigStart + withinLastLine;
        }
        origMatchLen = origEndOfMatch - (origLineStart + withinLineOffset);
      }

      return {
        ...r,
        matchIndex: origLineStart + withinLineOffset,
        matchLength: origMatchLen,
      };
    });

    // Apply replacements on the ORIGINAL content with original-space offsets
    const origGroupStart = originalLines
      .slice(0, group.startLine)
      .reduce((sum, l) => sum + l.length, 0);
    result += applyReplacements(
      originalGroupContent,
      originalReplacements,
      origGroupStart,
    );
    originalLineIndex = group.endLine;
  }
  return result + originalLines.slice(originalLineIndex).join("");
}

function splitLinesWithTerminators(content: string): string[] {
  return content.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+/g) ?? [];
}

type LineTerminator = "\r\n" | "\r" | "\n";

function getLineTerminator(line: string | undefined): LineTerminator | undefined {
  if (line === undefined) {
    return undefined;
  }
  if (line.endsWith("\r\n")) {
    return "\r\n";
  }
  if (line.endsWith("\n")) {
    return "\n";
  }
  return line.endsWith("\r") ? "\r" : undefined;
}

function restoreNormalizedLineEndings(
  normalizedContent: string,
  sourceLines: string[],
  fallback: LineTerminator,
): string {
  let sourceIndex = 0;
  return normalizedContent.replace(/\n/g, () => {
    const source = sourceLines[sourceIndex] ?? sourceLines.at(-1);
    sourceIndex++;
    return getLineTerminator(source) ?? fallback;
  });
}

function countLineBreaks(content: string): number {
  return content.match(/\n/g)?.length ?? 0;
}

export function applyReplacementsPreservingLineEndings(
  originalContent: string,
  baseContent: string,
  replacements: TextReplacement[],
): string {
  const originalLines = splitLinesWithTerminators(originalContent);
  const { lines: baseLines, groups } = groupReplacementsByLine(baseContent, replacements);
  if (originalLines.length !== baseLines.length) {
    throw new Error(
      "Cannot preserve original line endings because the base content has a different line count.",
    );
  }

  const fileFallback = detectLineEnding(originalContent);
  let originalIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalIndex, group.startLine).join("");
    const firstLine = baseLines.at(group.startLine);
    const lastLine = baseLines.at(group.endLine - 1);
    if (!firstLine || !lastLine) {
      throw new Error("Replacement group is outside the base content.");
    }

    const groupStartOffset = firstLine.start;
    const normalizedGroup = baseContent.slice(groupStartOffset, lastLine.end);
    const sourceGroup = originalLines.slice(group.startLine, group.endLine);
    const groupFallback =
      getLineTerminator(sourceGroup[0]) ??
      getLineTerminator(originalLines[group.startLine - 1]) ??
      fileFallback;
    const restoredGroup = restoreNormalizedLineEndings(normalizedGroup, sourceGroup, groupFallback);
    const restoredReplacements = group.replacements.map((replacement) => {
      const relativeStart = replacement.matchIndex - groupStartOffset;
      const relativeEnd = relativeStart + replacement.matchLength;
      const restoredStart = restoreNormalizedLineEndings(
        normalizedGroup.slice(0, relativeStart),
        sourceGroup,
        groupFallback,
      ).length;
      const restoredEnd = restoreNormalizedLineEndings(
        normalizedGroup.slice(0, relativeEnd),
        sourceGroup,
        groupFallback,
      ).length;
      const range = getReplacementLineRange(baseLines, replacement);
      const replacementSource = originalLines.slice(range.startLine, range.endLine);
      const replacementFallback =
        getLineTerminator(replacementSource[0]) ??
        getLineTerminator(originalLines[range.startLine - 1]) ??
        fileFallback;
      const consumedTerminatorCount = countLineBreaks(
        normalizedGroup.slice(relativeStart, relativeEnd),
      );
      const replacementTerminatorCount = countLineBreaks(replacement.newText);
      const terminatorSources =
        consumedTerminatorCount > 0
          ? replacementSource.slice(0, consumedTerminatorCount)
          : replacementSource.slice(0, 1);
      const sourceOffset = Math.max(0, terminatorSources.length - replacementTerminatorCount);
      return {
        matchIndex: restoredStart,
        matchLength: restoredEnd - restoredStart,
        newText: restoreNormalizedLineEndings(
          replacement.newText,
          terminatorSources.slice(sourceOffset),
          replacementFallback,
        ),
      };
    });
    result += applyReplacements(restoredGroup, restoredReplacements);
    originalIndex = group.endLine;
  }
  return result + originalLines.slice(originalIndex).join("");
}
