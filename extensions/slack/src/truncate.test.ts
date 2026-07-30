// Slack tests cover truncate plugin behavior.
import { describe, expect, it } from "vitest";
import {
  countSlackTextUtf8Bytes,
  truncateSlackText,
  truncateSlackTextByUtf8Bytes,
} from "./truncate.js";

describe("truncateSlackText", () => {
  it("drops a surrogate-pair emoji whole when it straddles the limit", () => {
    // "abc😀def": 😀 (U+1F600) sits at the cut point. Slicing by UTF-16 code unit
    // would keep only its high surrogate — a lone \uD83D — before the ellipsis,
    // which serializes to an invalid character in the Slack payload.
    const out = truncateSlackText("abc😀def", 5);
    expect(out).toBe("abc…");
    // No dangling high surrogate (a high surrogate not followed by a low one).
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  it("truncates plain BMP text unchanged", () => {
    expect(truncateSlackText("hello world", 5)).toBe("hell…");
  });

  it("keeps an emoji that fits before the cut", () => {
    expect(truncateSlackText("😀abcdef", 5)).toBe("😀ab…");
  });

  it("returns the trimmed input unchanged when it fits", () => {
    expect(truncateSlackText("ab😀cd", 10)).toBe("ab😀cd");
  });
});

describe("truncateSlackTextByUtf8Bytes", () => {
  it("fills an ASCII byte budget and keeps the ellipsis inside it", () => {
    const result = truncateSlackTextByUtf8Bytes("x".repeat(6_000), 4_000);

    expect(result).toHaveLength(3_998);
    expect(result.endsWith("…")).toBe(true);
    expect(countSlackTextUtf8Bytes(result)).toBe(4_000);
  });

  it("backs off for multibyte text instead of trusting UTF-16 length", () => {
    const result = truncateSlackTextByUtf8Bytes(`${"x".repeat(3_999)}…`, 4_000);

    expect(result).toBe(`${"x".repeat(3_997)}…`);
    expect(countSlackTextUtf8Bytes(result)).toBe(4_000);
  });

  it("does not split emoji at the byte boundary", () => {
    const result = truncateSlackTextByUtf8Bytes("😀".repeat(2_000), 4_000);

    expect(result.endsWith("…")).toBe(true);
    expect(result).not.toContain("�");
    expect(countSlackTextUtf8Bytes(result)).toBeLessThanOrEqual(4_000);
  });
});
