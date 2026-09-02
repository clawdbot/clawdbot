/**
 * Regression coverage for surrogate-safe truncation in compact tool display
 * detail coercion (coerceDisplayValue, reached via resolveToolVerbAndDetailForArgs
 * -> resolveDetailFromKeys).
 */
import { describe, expect, it } from "vitest";
import { resolveToolVerbAndDetailForArgs } from "./tool-display-common.js";

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const codeUnit = value.charCodeAt(i);
    if (isHighSurrogate(codeUnit)) {
      if (i + 1 >= value.length || !isLowSurrogate(value.charCodeAt(i + 1))) {
        return true;
      }
    } else if (isLowSurrogate(codeUnit)) {
      if (i === 0 || !isHighSurrogate(value.charCodeAt(i - 1))) {
        return true;
      }
    }
  }
  return false;
}

describe("coerceDisplayValue surrogate-safe truncation", () => {
  it("does not split an emoji across the truncation boundary (default maxStringChars=160)", () => {
    // 200 UTF-16 units: 78 'a', an emoji (surrogate pair at indices 78-79), 120 'b'.
    // With maxStringChars=160, half = floor(159/2) = 79, so the naive
    // firstLine.slice(0, 79) keeps only the emoji's high surrogate at index 78.
    const detailValue = `${"a".repeat(78)}\u{1F600}${"b".repeat(120)}`;
    expect(detailValue.length).toBe(200);

    const { detail } = resolveToolVerbAndDetailForArgs({
      toolKey: "custom_tool",
      args: { note: detailValue },
      fallbackDetailKeys: ["note"],
      detailMode: "first",
    });

    expect(detail).toBeDefined();
    // The bug rendered a lone high surrogate (and possibly a lone low surrogate
    // at the tail head); the fix must drop the whole emoji at the cut.
    expect(hasLoneSurrogate(detail as string)).toBe(false);
    // Head keeps only the 78 leading 'a's (emoji dropped, not half-kept).
    expect((detail as string).split("…")[0]).toBe("a".repeat(78));
    // Tail must not begin mid-pair on a lone low surrogate.
    const tail = (detail as string).split("…")[1] ?? "";
    expect(isLowSurrogate(tail.charCodeAt(0))).toBe(false);
  });

  it("leaves plain (non-surrogate) long values truncated as before", () => {
    const detailValue = "x".repeat(300);

    const { detail } = resolveToolVerbAndDetailForArgs({
      toolKey: "custom_tool",
      args: { note: detailValue },
      fallbackDetailKeys: ["note"],
      detailMode: "first",
    });

    // Behavior-preserving for ASCII: half = 79, so 79 'x' + ellipsis + 80 'x'.
    expect(detail).toBe(`${"x".repeat(79)}…${"x".repeat(80)}`);
    expect(hasLoneSurrogate(detail as string)).toBe(false);
  });

  it("returns short values unchanged", () => {
    const { detail } = resolveToolVerbAndDetailForArgs({
      toolKey: "custom_tool",
      args: { note: "short value with no emoji" },
      fallbackDetailKeys: ["note"],
      detailMode: "first",
    });
    expect(detail).toBe("short value with no emoji");
  });
});
