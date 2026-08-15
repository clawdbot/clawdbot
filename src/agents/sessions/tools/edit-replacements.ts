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
