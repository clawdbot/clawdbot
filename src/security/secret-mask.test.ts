import { describe, expect, it } from "vitest";
import { maskApiKey } from "./secret-mask.js";

describe("maskApiKey", () => {
  it.each([
    ["", "missing"],
    ["   ", "missing"],
    [" short ", "s...t"],
    [" a ", "a...a"],
    [" ab ", "a...b"],
    [" abcdefghijklmnop ", "ab...op"],
    ["1234567890abcdefghijklmnop", "12345678...ijklmnop"],
  ])("masks %o", (value, expected) => {
    expect(maskApiKey(value)).toBe(expected);
  });

  it("strips control characters before applying the display policy", () => {
    expect(maskApiKey("abcd\nefghijklmnop")).toBe("ab...op");
    expect(maskApiKey("abcd\u0000efghijklmnop")).toBe("ab...op");
    expect(maskApiKey("abcd\u007f\u0085efghijklmnop")).toBe("ab...op");
    expect(maskApiKey("\u0000\n")).toBe("missing");
  });

  it("does not split UTF-16 surrogate pairs at mask boundaries", () => {
    // Short values: when the only characters are astral, both edges are dropped
    // rather than emitting isolated surrogate halves.
    expect(maskApiKey("😀")).toBe("...");
    expect(maskApiKey("😀ab")).toBe("...b");
    expect(maskApiKey("ab😀")).toBe("a...");
    expect(maskApiKey("a😀b")).toBe("a...b");

    // Long values keep their prefix/suffix when the 8-code-unit boundary lands
    // in the middle of a surrogate pair.
    const long = "😀".repeat(3) + "a😀" + "b".repeat(10);
    const masked = maskApiKey(long);
    expect(() => encodeURIComponent(masked)).not.toThrow();
    expect(masked).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(masked).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(maskApiKey("😀abcdefghijklmno😀")).toBe("😀abcdef...jklmno😀");
  });
});
