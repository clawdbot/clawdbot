import { describe, it, expect } from "vitest";
import { formatToolOutputForSidebar, getTruncatedPreview } from "./tool-helpers.ts";

const emptyStringHelperCases = [
  { name: "formatToolOutputForSidebar", resolve: formatToolOutputForSidebar },
  { name: "getTruncatedPreview", resolve: getTruncatedPreview },
];

describe("tool-helpers", () => {
  describe("empty string handling", () => {
    it.each(emptyStringHelperCases)("$name handles empty string", ({ resolve }) => {
      expect(resolve("")).toBe("");
    });
  });

  describe("formatToolOutputForSidebar", () => {
    it("formats valid JSON object as code block", () => {
      const input = '{"name":"test","value":123}';
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe(`\`\`\`json
{
  "name": "test",
  "value": 123
}
\`\`\``);
    });

    it("formats valid JSON array as code block", () => {
      const input = "[1, 2, 3]";
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe(`\`\`\`json
[
  1,
  2,
  3
]
\`\`\``);
    });

    it("handles nested JSON objects", () => {
      const input = '{"outer":{"inner":"value"}}';
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe(`\`\`\`json
{
  "outer": {
    "inner": "value"
  }
}
\`\`\``);
    });

    it("returns plain text for non-JSON content", () => {
      const input = "This is plain text output";
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe("This is plain text output");
    });

    it("returns as-is for invalid JSON starting with {", () => {
      const input = "{not valid json";
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe("{not valid json");
    });

    it("returns as-is for invalid JSON starting with [", () => {
      const input = "[not valid json";
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe("[not valid json");
    });

    it("trims whitespace before detecting JSON", () => {
      const input = '   {"trimmed": true}   ';
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe(`\`\`\`json
{
  "trimmed": true
}
\`\`\``);
    });

    it("handles whitespace-only string", () => {
      const result = formatToolOutputForSidebar("   ");
      expect(result).toBe("   ");
    });
  });

  describe("getTruncatedPreview", () => {
    it("returns short text unchanged", () => {
      const input = "Short text";
      const result = getTruncatedPreview(input);

      expect(result).toBe("Short text");
    });

    it("truncates text longer than max chars", () => {
      const input = "a".repeat(150);
      const result = getTruncatedPreview(input);

      expect(result).toBe(`${"a".repeat(100)}…`);
    });

    it("truncates to max lines", () => {
      const input = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
      const result = getTruncatedPreview(input);

      // Should only show first 2 lines (PREVIEW_MAX_LINES = 2)
      expect(result).toBe("Line 1\nLine 2…");
    });

    it("adds ellipsis when lines are truncated", () => {
      const input = "Line 1\nLine 2\nLine 3";
      const result = getTruncatedPreview(input);

      expect(result).toBe("Line 1\nLine 2…");
    });

    it("does not add ellipsis when all lines fit", () => {
      const input = "Line 1\nLine 2";
      const result = getTruncatedPreview(input);

      expect(result).toBe("Line 1\nLine 2");
    });

    it("handles single line within limits", () => {
      const input = "Single line";
      const result = getTruncatedPreview(input);

      expect(result).toBe("Single line");
    });

    it("truncates by chars even within line limit", () => {
      // Two lines but very long content
      const longLine = "x".repeat(80);
      const input = `${longLine}\n${longLine}`;
      const result = getTruncatedPreview(input);

      expect(result).toBe(`${"x".repeat(80)}\n${"x".repeat(19)}…`);
    });
  });
});
