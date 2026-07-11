// File Transfer tests cover bounded stderr tail UTF-16 safety.
import { describe, expect, it } from "vitest";
import { appendBoundedTextTail, projectBoundedTextTail } from "./append-bounded-text-tail.js";

const hasUnpairedUtf16Surrogate = (text: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text);

describe("appendBoundedTextTail", () => {
  it("keeps stderr tail UTF-16 safe when the boundary bisects an emoji", () => {
    const stderr = appendBoundedTextTail("prefix", Buffer.from("🤖tail"), 5);

    expect(stderr).toBe("tail");
    expect(hasUnpairedUtf16Surrogate(stderr)).toBe(false);
  });
});

describe("projectBoundedTextTail", () => {
  it("keeps final error projection UTF-16 safe when the boundary bisects an emoji", () => {
    const stderr = "p".repeat(5) + "🤖fail";
    const projected = projectBoundedTextTail(stderr, 5);

    expect(projected).toBe("fail");
    expect(hasUnpairedUtf16Surrogate(projected)).toBe(false);
  });
});
