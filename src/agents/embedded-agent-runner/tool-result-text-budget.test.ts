import { describe, expect, it } from "vitest";
import { toolResultFitsBudget } from "../tool-result-limits.js";
import {
  estimateToolResultTextChars,
  sliceToolResultTextTailToBudget,
  sliceToolResultTextToBudget,
} from "./tool-result-text-budget.js";

describe("tool-result text budgets", () => {
  it("preserves ASCII accounting while weighting dense CJK", () => {
    expect(estimateToolResultTextChars("hello")).toBe(5);
    expect(estimateToolResultTextChars("你好")).toBe(8);
  });

  it("combines the context guard's ASCII floor with CJK weighting", () => {
    const options = { minimumRawWeight: 2 };
    expect(estimateToolResultTextChars("hello", options)).toBe(10);
    expect(estimateToolResultTextChars("你好", options)).toBe(8);
    expect(estimateToolResultTextChars("ab你好", options)).toBe(12);
  });

  it.each([
    ["abc", 3, 6],
    ["漢a", 5, 6],
    ["𠀀a", 17, 18],
    ["🌍a", 3, 6],
  ])("checks both budget boundaries for %s", (text, maxChars, maxContextChars) => {
    expect(toolResultFitsBudget(text, { maxChars, maxContextChars })).toBe(true);
    expect(toolResultFitsBudget(text, { maxChars: maxChars - 1, maxContextChars })).toBe(false);
    expect(toolResultFitsBudget(text, { maxChars, maxContextChars: maxContextChars - 1 })).toBe(
      false,
    );
  });

  it("finds prefix and tail cuts on complete UTF-16 boundaries", () => {
    const text = "A😀你好B";
    expect(sliceToolResultTextToBudget(text, 7)).toBe("A😀你");
    expect(sliceToolResultTextTailToBudget(text, 7)).toBe("好B");
    expect(sliceToolResultTextToBudget("😀", 1)).toBe("");
    expect(sliceToolResultTextTailToBudget("😀", 1)).toBe("");
  });

  it("honors the larger of CJK cost and a caller safety floor", () => {
    const options = { minimumRawWeight: 2 };
    expect(sliceToolResultTextToBudget("ab你好", 9, options)).toBe("ab你");
    expect(sliceToolResultTextTailToBudget("你好ab", 9, options)).toBe("好ab");
  });
});
