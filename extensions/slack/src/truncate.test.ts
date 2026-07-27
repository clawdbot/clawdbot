// Slack tests cover truncate plugin behavior.
import { describe, expect, it } from "vitest";
import { truncateSlackText } from "./truncate.js";

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
