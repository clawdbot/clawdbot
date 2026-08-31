// Agent Core tests cover truncate behavior.
import { describe, expect, it } from "vitest";
import { truncateHead, truncateLine, truncateTail } from "./truncate.js";

describe("truncate utilities", () => {
  it("does not count a trailing newline as an extra display line", () => {
    expect(truncateHead("alpha\nbeta\n").totalLines).toBe(2);
    expect(truncateTail("alpha\nbeta\n").totalLines).toBe(2);
  });

  it("classifies trailing-newline truncation by the byte limit", () => {
    expect(truncateHead("x\n", { maxBytes: 1 }).truncatedBy).toBe("bytes");
    expect(truncateTail("x\n", { maxBytes: 1 }).truncatedBy).toBe("bytes");
  });

  it("keeps complete UTF-8 characters when taking a partial tail line", () => {
    const result = truncateTail("alpha🙂", { maxBytes: 4 });

    expect(result.content).toBe("🙂");
    expect(result.lastLinePartial).toBe(true);
    expect(result.outputBytes).toBe(4);
  });

  describe("truncateLine", () => {
    it("returns text unchanged when within limit", () => {
      expect(truncateLine("short", 10)).toEqual({ text: "short", wasTruncated: false });
    });

    it("truncates and appends suffix when over limit", () => {
      const result = truncateLine("this is a very long line", 10);
      expect(result.wasTruncated).toBe(true);
      expect(result.text).toBe("this is a ... [truncated]");
    });

    it("uses GREP_MAX_LINE_LENGTH as the default limit", () => {
      const result = truncateLine("x");
      expect(result.wasTruncated).toBe(false);
      expect(result.text).toBe("x");
    });

    it("does not split a surrogate pair at the cut point", () => {
      // Emoji at boundary: "AB" + 🤖(surrogate pair) + "CD" — cut at 3 splits the emoji.
      expect(truncateLine("AB🤖CD", 3).text).toBe("AB... [truncated]");
      // Three emoji, cut in the middle of the second emoji.
      expect(truncateLine("🤖🤖🤖", 5).text).toBe("🤖🤖... [truncated]");
      // CJK Extension B (surrogate pair) at boundary stays intact.
      expect(truncateLine("AB𠮷CD", 5).text).toBe("AB𠮷C... [truncated]");
    });

    it("never produces unpaired surrogates in output", () => {
      const results = [
        truncateLine("AB🤖CD", 3).text,
        truncateLine("🤖🤖🤖", 5).text,
        truncateLine("AB𠮷CD", 5).text,
      ];
      for (const text of results) {
        expect(text).not.toMatch(
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
        );
      }
    });
  });
});
