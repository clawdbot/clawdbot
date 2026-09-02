// Code region helpers expose Markdown Core spans to sanitizer consumers.
import { findMarkdownCodeSpans } from "../../../packages/markdown-core/src/reasoning-tags.js";

export interface CodeRegion {
  start: number;
  end: number;
}

/** Finds CommonMark block-aware fenced, indented, and inline code regions. */
export function findCodeRegions(text: string): CodeRegion[] {
  return findMarkdownCodeSpans(text).map(([start, end]) => ({ start, end }));
}

/** Returns true when a character offset falls inside one of the discovered code regions. */
export function isInsideCode(pos: number, regions: CodeRegion[]): boolean {
  return regions.some((region) => pos >= region.start && pos < region.end);
}

/** Removes control lines while retaining literal code and original line endings. */
export function stripLinesOutsideCode(
  text: string,
  shouldStrip: (line: string) => boolean,
): string {
  let regions: CodeRegion[] | undefined;
  return text.replace(/[^\n]*(?:\n|$)/g, (raw: string, offset: number) => {
    const line = raw.endsWith("\n") ? raw.slice(0, -1).replace(/\r$/, "") : raw;
    return shouldStrip(line) && !isInsideCode(offset, (regions ??= findCodeRegions(text)))
      ? ""
      : raw;
  });
}
