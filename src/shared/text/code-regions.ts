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
