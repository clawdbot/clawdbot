// Code region helpers find fenced and inline code spans in Markdown text.
import { expectDefined } from "@openclaw/normalization-core";
export interface CodeRegion {
  start: number;
  end: number;
}

/**
 * Finds inline code spans. Markdown closes a code span only with a backtick run of
 * the same length as the one that opened it, so a run of three followed by a run
 * of two spans nothing. Pairing unequal runs would let arbitrary text pose as a
 * literal code example and slip past the sanitizers that skip code regions.
 */
function findInlineCodeSpans(text: string): CodeRegion[] {
  const runs: CodeRegion[] = [];
  for (const match of text.matchAll(/`+/g)) {
    const start = match.index ?? 0;
    runs.push({ start, end: start + match[0].length });
  }

  const spans: CodeRegion[] = [];
  let openIndex = 0;
  while (openIndex < runs.length) {
    const open = expectDefined(runs[openIndex], "code regions backtick run");
    const width = open.end - open.start;
    let closeIndex = openIndex + 1;
    while (closeIndex < runs.length) {
      const candidate = expectDefined(runs[closeIndex], "code regions backtick run");
      if (candidate.end - candidate.start === width) {
        break;
      }
      closeIndex += 1;
    }
    if (closeIndex >= runs.length) {
      // Nothing closes this run, so it is literal text -- keep looking from the next.
      openIndex += 1;
      continue;
    }
    spans.push({
      start: open.start,
      end: expectDefined(runs[closeIndex], "code regions backtick run").end,
    });
    openIndex = closeIndex + 1;
  }
  return spans;
}

/** Finds fenced and inline Markdown code regions so text sanitizers can avoid examples. */
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

  for (const span of findInlineCodeSpans(text)) {
    const insideFenced = regions.some((r) => span.start >= r.start && span.end <= r.end);
    if (!insideFenced) {
      regions.push(span);
    }
  }

  regions.sort((a, b) => a.start - b.start);
  return regions;
}

/** Returns true when a character offset falls inside one of the discovered code regions. */
export function isInsideCode(pos: number, regions: CodeRegion[]): boolean {
  return regions.some((r) => pos >= r.start && pos < r.end);
}
