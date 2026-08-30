// Telegram tests cover progress text clipping behavior.
import { describe, expect, it } from "vitest";
import { clipTelegramProgressText, TELEGRAM_PROGRESS_MAX_CHARS } from "./truncate.js";

const TELEGRAM_PROGRESS_LIMIT = TELEGRAM_PROGRESS_MAX_CHARS;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function hasLoneSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

describe("clipTelegramProgressText", () => {
  it("returns text unchanged when it is within the default limit", () => {
    const short = "hello 😀 world";
    expect(clipTelegramProgressText(short)).toBe(short);
    const exact = "x".repeat(TELEGRAM_PROGRESS_LIMIT);
    expect(clipTelegramProgressText(exact)).toBe(exact);
  });

  it("keeps the historical 300 budget when no budget is passed", () => {
    const oneOver = `${"x".repeat(TELEGRAM_PROGRESS_LIMIT)}y`;
    const out = clipTelegramProgressText(oneOver);
    expect(codePointLength(out)).toBeLessThanOrEqual(TELEGRAM_PROGRESS_LIMIT);
    expect(out.endsWith("…")).toBe(true);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it("honors a configured budget", () => {
    const out = clipTelegramProgressText("hello wonderful world of telegram", 20);
    expect(out).toBe("hello wonderful…");
    expect(codePointLength(out)).toBeLessThanOrEqual(20);
  });

  it("cuts prose on word boundaries", () => {
    const sentence =
      "I'm checking whether the generated video exists or if the generator bailed while writing output.";
    expect(clipTelegramProgressText(sentence, 64)).toBe(
      "I'm checking whether the generated video exists or if the…",
    );
  });

  it("keeps command prefixes and useful path suffixes", () => {
    const path = `path/to/${"nested/".repeat(20)}file.ts`;
    const detail = `Ran command: cat ${path}`;
    const out = clipTelegramProgressText(detail, 60);
    expect(out.startsWith("Ran command: cat")).toBe(true);
    expect(out.endsWith("file.ts")).toBe(true);
    expect(out).toContain("…");
    expect(codePointLength(out)).toBeLessThanOrEqual(60);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it("drops a surrogate-pair emoji whole when it straddles the cut", () => {
    // 😀 is U+1F600, encoded as two UTF-16 code units. With a 299-code-point
    // budget the head keeps 298 code points, so the emoji at positions
    // [298, 299] is dropped whole instead of leaving a lone \uD83D-style high
    // surrogate before the ellipsis, which serializes to an invalid character
    // in the Telegram Bot API payload.
    const base = "a".repeat(298);
    const out = clipTelegramProgressText(`${base}😀tail`, 299);
    expect(out).toBe(`${base}…`);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it("keeps an emoji that fits entirely before the cut", () => {
    // 297 'a's + '😀' (1 code point) + 'xyz' = 301 code points > 299.
    // The emoji sits at code point 297 — entirely before the 298-code-point
    // head — so it stays.
    const base = "a".repeat(297);
    const out = clipTelegramProgressText(`${base}😀xyz`, 299);
    expect(out).toBe(`${base}😀…`);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it("never leaves trailing whitespace before the ellipsis", () => {
    // Collapsed trailing spaces can straddle the cut.
    const text = `${"a".repeat(TELEGRAM_PROGRESS_LIMIT - 2)}  rest`;
    const out = clipTelegramProgressText(text);
    expect(out).not.toMatch(/\s…$/u);
    expect(out.endsWith("…")).toBe(true);
  });
});
