import { BoundedBuffer } from "../../shared/bounded-buffer.js";

/**
 * Last `cap` chars of `chunk`, nudged forward one unit when the cut would land
 * mid-surrogate-pair: a replayed lone surrogate is permanent mojibake, unlike a
 * mid-escape cut the emulator repaints over.
 */
export function surrogateSafeTail(chunk: string, cap: number): string {
  const start = chunk.length - cap;
  const splitsPair =
    start > 0 && /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(chunk.slice(start - 1, start + 1));
  return chunk.slice(splitsPair ? start + 1 : start);
}

/** Raw output may start mid-escape after whole-write eviction; repaint recovers. */
export class TerminalOutputRing extends BoundedBuffer<string> {
  constructor(cap: number) {
    super(cap, { mode: "drop-oldest", fit: surrogateSafeTail }, (chunk) => chunk.length);
  }

  snapshot(): string {
    return this.values.join("");
  }
}
