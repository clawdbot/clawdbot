// Code region helpers find fenced, indented, and inline code spans in Markdown
// text so text sanitizers can leave documentation examples untouched.
import { expectDefined } from "./expect.js";

export interface CodeRegion {
  start: number;
  end: number;
}

interface IndentedScanLine {
  /** Offset of the first character of the line (leading whitespace included). */
  start: number;
  /** Offset just past the last non-newline character on the line. */
  contentEnd: number;
  /** True when the line holds only spaces/tabs (or is empty). */
  blank: boolean;
  /** Leading-whitespace width in CommonMark columns (tab -> next multiple of 4). */
  indentColumns: number;
}

/** Splits text into line records, measuring CommonMark indent columns per line. */
function scanIndentedLines(text: string): IndentedScanLine[] {
  const lines: IndentedScanLine[] = [];
  let lineStart = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index !== text.length && text[index] !== "\n") {
      continue;
    }
    let contentEnd = index;
    if (contentEnd > lineStart && text[contentEnd - 1] === "\r") {
      contentEnd -= 1;
    }
    let columns = 0;
    let cursor = lineStart;
    while (cursor < contentEnd) {
      const char = text[cursor];
      if (char === " ") {
        columns += 1;
      } else if (char === "\t") {
        // A tab advances to the next multiple of four columns, so a single
        // leading tab reaches the 4-column indented-code threshold.
        columns += 4 - (columns % 4);
      } else {
        break;
      }
      cursor += 1;
    }
    lines.push({
      start: lineStart,
      contentEnd,
      blank: cursor === contentEnd,
      indentColumns: columns,
    });
    lineStart = index + 1;
    if (index === text.length) {
      break;
    }
  }
  return lines;
}

// This flat scanner approximates document-level CommonMark indented code blocks.
// It only opens a block after a blank line when the nearest preceding non-blank
// line is unindented (top level), so it does not fully resolve container-relative
// (blockquote / list-item) indentation the way a real mdast parser would, and it
// treats a 4-column line following prose as a lazy paragraph continuation (kept
// scrubbable). That deliberate trade keeps the detector self-contained (no
// markdown-core dependency, which would cycle) while protecting the common case.
function opensIndentedBlock(
  lines: readonly IndentedScanLine[],
  index: number,
  insideFenced: (offset: number) => boolean,
): boolean {
  const line = expectDefined(lines[index], "indented code scan line");
  if (line.blank || line.indentColumns < 4 || insideFenced(line.start)) {
    return false;
  }
  if (index === 0) {
    return true;
  }
  // A 4-column line directly under a non-blank line is a lazy paragraph
  // continuation, not code, so a leaked call there must stay scrubbable.
  if (!expectDefined(lines[index - 1], "previous scan line").blank) {
    return false;
  }
  // Preceded by a blank line: only open at top level. If the nearest non-blank
  // predecessor is itself indented, treat this as container/continuation content
  // rather than a fresh indented code block (e.g. list-item body vs real code).
  let predecessor = index - 2;
  while (predecessor >= 0 && expectDefined(lines[predecessor], "predecessor scan line").blank) {
    predecessor -= 1;
  }
  if (predecessor < 0) {
    return true;
  }
  return expectDefined(lines[predecessor], "predecessor scan line").indentColumns < 4;
}

function findIndentedCodeRegions(text: string, fenced: readonly CodeRegion[]): CodeRegion[] {
  const insideFenced = (offset: number): boolean =>
    fenced.some((region) => offset >= region.start && offset < region.end);
  const lines = scanIndentedLines(text);
  const regions: CodeRegion[] = [];
  for (let index = 0; index < lines.length;) {
    const line = expectDefined(lines[index], "indented code scan line");
    if (!opensIndentedBlock(lines, index, insideFenced)) {
      index += 1;
      continue;
    }
    let lastContent = index;
    let lookahead = index + 1;
    while (lookahead < lines.length) {
      const next = expectDefined(lines[lookahead], "indented code lookahead line");
      if (next.blank) {
        lookahead += 1;
        continue;
      }
      if (next.indentColumns >= 4 && !insideFenced(next.start)) {
        lastContent = lookahead;
        lookahead += 1;
        continue;
      }
      break;
    }
    // Interior blank lines stay inside the block; trailing blanks are excluded by
    // ending at the last non-blank indented line.
    regions.push({
      start: line.start,
      end: expectDefined(lines[lastContent], "indented code trailing line").contentEnd,
    });
    index = lastContent + 1;
  }
  return regions;
}

/** Finds fenced, indented, and inline Markdown code regions so text sanitizers can avoid examples. */
export function findCodeRegions(text: string): CodeRegion[] {
  const regions: CodeRegion[] = [];

  const fencedRe = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2|$)/g;
  for (const match of text.matchAll(fencedRe)) {
    const start =
      (match.index ?? 0) + expectDefined(match[1], "code regions regex capture 1").length;
    regions.push({
      start,
      end: start + match[0].length - expectDefined(match[1], "code regions regex capture 1").length,
    });
  }

  // Indented code runs after the fenced pass (so it can skip lines already owned
  // by a fence) and before the inline pass (so inline exclusion also covers it).
  for (const region of findIndentedCodeRegions(text, regions)) {
    regions.push(region);
  }

  const inlineRe = /`+[^`]+`+/g;
  for (const match of text.matchAll(inlineRe)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const insideCollected = regions.some((r) => start >= r.start && end <= r.end);
    if (!insideCollected) {
      regions.push({ start, end });
    }
  }

  regions.sort((a, b) => a.start - b.start);
  return regions;
}

/** Returns true when a character offset falls inside one of the discovered code regions. */
export function isInsideCode(pos: number, regions: CodeRegion[]): boolean {
  return regions.some((r) => pos >= r.start && pos < r.end);
}
