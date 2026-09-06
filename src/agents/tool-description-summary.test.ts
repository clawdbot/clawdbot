import { describe, expect, it } from "vitest";
import {
  describeToolForVerbose,
  summarizeToolDescriptionText,
} from "./tool-description-summary.js";

function hasDanglingSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

describe("tool description summaries", () => {
  it.each<[string, Parameters<typeof summarizeToolDescriptionText>[0], string]>([
    [
      "the opening line",
      { rawDescription: "Search project docs.\nFurther details." },
      "Search project docs.",
    ],
    [
      "paragraph precedence over earlier fallback lines",
      { rawDescription: "ACTIONS:\nEarlier detail.\n\nSecond paragraph summary.\nExtra detail." },
      "Second paragraph summary.",
    ],
    [
      "fallback after all paragraph openings are excluded",
      { rawDescription: "ACTIONS:\n- Query.\nFallback detail.\n\nJOB SCHEMA:\n{}\n[]" },
      "Fallback detail.",
    ],
    [
      "schema-only descriptions",
      { rawDescription: "ACTIONS:\n- Query.\n\nJOB SCHEMA:\n{}\n[]" },
      "Tool",
    ],
    [
      "generic mixed-case headings",
      { rawDescription: "Mixed Case Heading:\nLater detail." },
      "Mixed Case Heading:",
    ],
    [
      "excluded uppercase headings",
      { rawDescription: "EXTENDED DETAILS:\nLater detail." },
      "Later detail.",
    ],
    [
      "excluded known mixed-case headings",
      { rawDescription: "Actions:\nAction detail." },
      "Action detail.",
    ],
    [
      "blank paragraphs and surrounding line whitespace",
      { rawDescription: "\n \n  Opening summary.  \n  Later line.  \n\nLast paragraph." },
      "Opening summary.",
    ],
    [
      "Unicode whitespace without treating a line separator as LF",
      { rawDescription: "\ufeff\u00a0 First\tline\u2003 words\u2028tail\nOther" },
      "First line words tail",
    ],
    [
      "CRLF paragraphs",
      { rawDescription: "ACTIONS:\r\n- Query.\r\n\r\nCRLF summary.\r\nDetails." },
      "CRLF summary.",
    ],
    ["bare CR within a line", { rawDescription: "Alpha\rBeta" }, "Alpha Beta"],
    ["a trimmed bare hyphen", { rawDescription: "- " }, "-"],
    ["unrecognized list markers", { rawDescription: "* task" }, "* task"],
    ["an omitted description", {}, "Tool"],
    ["a null description", { rawDescription: null }, "Tool"],
    ["Unicode-only blank descriptions", { rawDescription: "\ufeff\u00a0 \t\n\u2003" }, "Tool"],
    [
      "explicit summary precedence and whitespace",
      { rawDescription: "Ignored raw", displaySummary: "\u00a0 Preferred\t summary\u2003" },
      "Preferred summary",
    ],
    [
      "a blank explicit summary",
      { rawDescription: "Raw fallback", displaySummary: " \t" },
      "Raw fallback",
    ],
    ["the default hard limit", { rawDescription: "x".repeat(130) }, `${"x".repeat(117)}...`],
    [
      "word-boundary truncation",
      { rawDescription: `${"a".repeat(50)} ${"b".repeat(80)}`, maxLen: 70 },
      `${"a".repeat(50)}...`,
    ],
  ])("preserves %s", (_name, params, expected) => {
    expect(summarizeToolDescriptionText(params)).toBe(expected);
  });

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
