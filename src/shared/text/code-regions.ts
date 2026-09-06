// Code region helpers expose Markdown Core spans to sanitizer consumers.
import { findMarkdownCodeRegions } from "../../../packages/markdown-core/src/reasoning-tags.js";

/** Public range inputs need only offsets; parser-owned metadata belongs to discovered regions. */
export interface CodeRegion {
  start: number;
  end: number;
}

/** Finds CommonMark block-aware fenced, indented, and inline code regions. */
export function findCodeRegions(
  text: string,
  options?: Parameters<typeof findMarkdownCodeRegions>[1],
): ReturnType<typeof findMarkdownCodeRegions> {
  return findMarkdownCodeRegions(text, options);
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
