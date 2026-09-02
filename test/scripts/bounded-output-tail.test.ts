import { describe, expect, it } from "vitest";
import { appendBoundedTail } from "../../scripts/lib/bounded-output-tail.mjs";

describe("appendBoundedTail", () => {
  it("preserves raw UTF-16 tail semantics and cumulative truncation", () => {
    expect(appendBoundedTail({ text: "ab", truncatedChars: 0 }, "cd", 4)).toEqual({
      text: "abcd",
      truncatedChars: 0,
    });

    const prior = appendBoundedTail({ text: "abc", truncatedChars: 2 }, "def", 4);
    expect(prior).toEqual({ text: "cdef", truncatedChars: 4 });

    expect(appendBoundedTail({ text: "", truncatedChars: 0 }, new Uint8Array([65, 66]), 8)).toEqual(
      {
        text: "65,66",
        truncatedChars: 0,
      },
    );

    const splitSurrogate = appendBoundedTail({ text: "\ud83d", truncatedChars: 0 }, "\ude00b", 2);
    expect(splitSurrogate).toEqual({ text: "\ude00b", truncatedChars: 1 });
    expect(splitSurrogate.text.charCodeAt(0)).toBe(0xde00);
  });
});
