// File Transfer tests cover bounded stderr tail UTF-16 safety.
import { describe, expect, it } from "vitest";
import { projectBoundedTextTail } from "./append-bounded-text-tail.js";

const hasUnpairedUtf16Surrogate = (text: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text);

describe("projectBoundedTextTail", () => {
  it("keeps final error projection UTF-16 safe when the boundary bisects an emoji", () => {
    const stderr = "p".repeat(5) + "🤖fail";
    const projected = projectBoundedTextTail(stderr, 5);

    expect(projected).toBe("fail");
    expect(hasUnpairedUtf16Surrogate(projected)).toBe(false);
  });
});
