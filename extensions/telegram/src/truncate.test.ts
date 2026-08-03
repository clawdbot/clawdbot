// Telegram tests cover progress text clipping behavior.
import { describe, expect, it } from "vitest";
import { clipTelegramProgressText } from "./truncate.js";

const TELEGRAM_PROGRESS_LIMIT = 300;

describe("clipTelegramProgressText", () => {
  it("drops a surrogate-pair emoji whole when it straddles the limit", () => {
    // 😀 is U+1F600, encoded as two UTF-16 code units (high \uD83D + low \uDE00).
    // Placing the emoji at positions [MAX-2, MAX-1] (0-indexed) puts its high
    // surrogate right on the .slice(0, MAX-1) cut edge. A raw .slice keeps only
    // \uD83D — an unpaired high surrogate — which is invalid in a Telegram payload.
    const base = "a".repeat(TELEGRAM_PROGRESS_LIMIT - 2); // 298 'a's
    const out = clipTelegramProgressText(`${base}😀tail`);
    expect(out).toBe(`${base}…`);
    // No dangling high surrogate (high not followed by a low surrogate).
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  it("keeps an emoji that fits entirely before the cut", () => {
    // 296 'a's + '😀' (2 units) + 'xyz' (3 units) = 301 total > 300.
    // The emoji sits at [296, 297] — entirely before the cut at 299 — so it stays.
    const base = "a".repeat(TELEGRAM_PROGRESS_LIMIT - 4); // 296 'a's
    const out = clipTelegramProgressText(`${base}😀xyz`);
    expect(out).toBe(`${base}😀x…`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  it("returns text unchanged when it is within the limit", () => {
    const short = "hello 😀 world";
    expect(clipTelegramProgressText(short)).toBe(short);
  });

  it("trims trailing whitespace before the ellipsis", () => {
    // The sliced portion may end in spaces when trailing spaces straddle the cut.
    const text = `${"a".repeat(TELEGRAM_PROGRESS_LIMIT - 2)}  rest`;
    const out = clipTelegramProgressText(text);
    expect(out).not.toContain("  …");
    expect(out.endsWith("…")).toBe(true);
  });

  it("handles plain ASCII that fills exactly to the limit", () => {
    const exact = "x".repeat(TELEGRAM_PROGRESS_LIMIT);
    expect(clipTelegramProgressText(exact)).toBe(exact);
    const oneOver = `${"x".repeat(TELEGRAM_PROGRESS_LIMIT)}y`;
    const out = clipTelegramProgressText(oneOver);
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_PROGRESS_LIMIT);
    expect(out.endsWith("…")).toBe(true);
  });
});
