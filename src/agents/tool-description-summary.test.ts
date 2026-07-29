import { describe, expect, it } from "vitest";
import {
  describeToolForVerbose,
  summarizeToolDescriptionText,
} from "./tool-description-summary.js";

function hasDanglingSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

describe("tool description summaries", () => {
  it("keeps compact summaries UTF-16 safe at truncation boundaries", () => {
    const summary = summarizeToolDescriptionText({
      displaySummary: "abcd😀 efgh",
      maxLen: 8,
    });

    expect(summary).toBe("abcd...");
    expect(hasDanglingSurrogate(summary)).toBe(false);
  });

  it("keeps verbose descriptions UTF-16 safe at truncation boundaries", () => {
    const description = describeToolForVerbose({
      rawDescription: "abcd😀 efgh",
      fallback: "Tool",
      maxLen: 8,
    });

    expect(description).toBe("abcd...");
    expect(hasDanglingSurrogate(description)).toBe(false);
  });
});
