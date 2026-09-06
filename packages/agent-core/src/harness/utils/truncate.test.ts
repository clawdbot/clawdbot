// Agent Core tests cover truncate behavior.
import { describe, expect, it } from "vitest";
import { truncateHead, truncateLine, truncateTail } from "./truncate.js";

describe("truncate utilities", () => {
  it("does not count a trailing newline as an extra display line", () => {
    expect(truncateHead("alpha\nbeta\n").totalLines).toBe(2);
    expect(truncateTail("alpha\nbeta\n").totalLines).toBe(2);
    expect(truncateTail("alpha\nbeta\ngamma\n", { maxLines: 2 })).toMatchObject({
      content: "beta\ngamma",
      truncatedBy: "lines",
      outputLines: 2,
    });
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

  it.each([
    {
      name: "CRLF",
      content: "a\r\n\r\nb\r\n",
      maxLines: 2,
      maxBytes: 20,
      head: "a\r\n\r",
      tail: "\r\nb\r",
      outputLines: 2,
      truncatedBy: "lines",
    },
    {
      name: "empty lines",
      content: "\n\n\n",
      maxLines: 2,
      maxBytes: 20,
      head: "\n",
      tail: "\n",
      outputLines: 2,
      truncatedBy: "lines",
    },
    {
      name: "byte limit first",
      content: "aa\nbb\ncc",
      maxLines: 2,
      maxBytes: 4,
      head: "aa",
      tail: "cc",
      outputLines: 1,
      truncatedBy: "bytes",
    },
    {
      name: "line limit first",
      content: "a\nb\nc",
      maxLines: 1,
      maxBytes: 1,
      head: "a",
      tail: "c",
      outputLines: 1,
      truncatedBy: "lines",
    },
    {
      name: "terminal newline bytes",
      content: "\n\n\n",
      maxLines: 3,
      maxBytes: 2,
      head: "\n\n",
      tail: "\n\n",
      outputLines: 3,
      truncatedBy: "bytes",
    },
  ])(
    "preserves selected lines and limit metadata: $name",
    ({ content, maxLines, maxBytes, head, tail, outputLines, truncatedBy }) => {
      for (const [truncate, expected] of [
        [truncateHead, head],
        [truncateTail, tail],
      ] as const) {
        expect(truncate(content, { maxLines, maxBytes })).toMatchObject({
          content: expected,
          totalLines: 3,
          totalBytes: Buffer.byteLength(content),
          outputLines,
          outputBytes: Buffer.byteLength(expected),
          truncated: true,
          truncatedBy,
          firstLineExceedsLimit: false,
          lastLinePartial: false,
        });
      }
    },
  );

  describe("truncateLine", () => {
    it("returns text unchanged when within limit", () => {
      expect(truncateLine("short", 10)).toEqual({ text: "short", wasTruncated: false });
    });

    it("truncates and appends suffix when over limit", () => {
      const result = truncateLine("this is a very long line", 10);
      expect(result.wasTruncated).toBe(true);
      expect(result.text).toBe("this is a ... [truncated]");
    });

    it("keeps 500 characters and truncates longer lines by default", () => {
      const line = "x".repeat(500);
      expect(truncateLine(line)).toEqual({ text: line, wasTruncated: false });
      expect(truncateLine(`${line}y`)).toEqual({
        text: `${line}... [truncated]`,
        wasTruncated: true,
      });
    });

    it("does not split a surrogate pair at the cut point", () => {
      // Emoji at boundary: "AB" + 🤖(surrogate pair) + "CD" — cut at 3 splits the emoji.
      expect(truncateLine("AB🤖CD", 3).text).toBe("AB... [truncated]");
      // Three emoji, cut in the middle of the third emoji.
      expect(truncateLine("🤖🤖🤖", 5).text).toBe("🤖🤖... [truncated]");
      // CJK Extension B (surrogate pair) at boundary stays intact.
      expect(truncateLine("AB𠮷CD", 5).text).toBe("AB𠮷C... [truncated]");
    });
  });
});
