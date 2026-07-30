import { findMarkdownCodeSpans } from "./reasoning-tag-parser.js";

export interface CodeRegion {
  start: number;
  end: number;
}

/** Finds CommonMark/GFM code regions so text sanitizers can avoid examples. */
export function findCodeRegions(text: string): CodeRegion[] {
  return findMarkdownCodeSpans(text).map(([start, end]) => ({ start, end }));
}

/** Returns true when a character offset falls inside one of the discovered code regions. */
export function isInsideCode(pos: number, regions: readonly CodeRegion[]): boolean {
  let low = 0;
  let high = regions.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const region = regions[middle];
    if (!region) {
      return false;
    }
    if (pos < region.start) {
      high = middle - 1;
    } else if (pos >= region.end) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}
