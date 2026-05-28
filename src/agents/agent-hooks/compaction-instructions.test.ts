import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPACTION_INSTRUCTIONS,
  resolveCompactionInstructions,
  composeSplitTurnInstructions,
} from "./compaction-instructions.js";

describe("DEFAULT_COMPACTION_INSTRUCTIONS", () => {
  it("is a non-empty string", () => {
    expect(typeof DEFAULT_COMPACTION_INSTRUCTIONS).toBe("string");
    expect(DEFAULT_COMPACTION_INSTRUCTIONS.trim()).not.toBe("");
  });

  it("contains language preservation directive", () => {
    expect(DEFAULT_COMPACTION_INSTRUCTIONS).toContain("primary language");
  });

  it("contains factual content directive", () => {
    expect(DEFAULT_COMPACTION_INSTRUCTIONS).toContain("factual content");
  });

  it("does not exceed MAX_INSTRUCTION_LENGTH (800 chars)", () => {
    expect(DEFAULT_COMPACTION_INSTRUCTIONS.length).toBeLessThanOrEqual(800);
  });
});

describe("resolveCompactionInstructions", () => {
  describe("null / undefined handling", () => {
    it("returns DEFAULT when both args are undefined", () => {
      expect(resolveCompactionInstructions(undefined, undefined)).toBe(
        DEFAULT_COMPACTION_INSTRUCTIONS,
      );
    });

    it("returns DEFAULT when both args are explicitly null (untyped JS caller)", () => {
      expect(
        resolveCompactionInstructions(null as unknown as undefined, null as unknown as undefined),
      ).toBe(DEFAULT_COMPACTION_INSTRUCTIONS);
    });
  });

  describe("empty and whitespace normalization", () => {
    it("treats empty-string event as absent -- runtime wins", () => {
      const result = resolveCompactionInstructions("", "runtime value");
      expect(result).toBe("runtime value");
    });

    it("treats whitespace-only event as absent -- runtime wins", () => {
      const result = resolveCompactionInstructions("   ", "runtime value");
      expect(result).toBe("runtime value");
    });

    it("treats tab/newline-only event as absent -- runtime wins", () => {
      const result = resolveCompactionInstructions("\t\n\r", "runtime value");
      expect(result).toBe("runtime value");
    });

    it("treats empty-string runtime as absent -- DEFAULT wins", () => {
      const result = resolveCompactionInstructions(undefined, "");
      expect(result).toBe(DEFAULT_COMPACTION_INSTRUCTIONS);
    });

    it("treats whitespace-only runtime as absent -- DEFAULT wins", () => {
      const result = resolveCompactionInstructions(undefined, "   ");
      expect(result).toBe(DEFAULT_COMPACTION_INSTRUCTIONS);
    });

    it("falls through to DEFAULT when both are empty strings", () => {
      expect(resolveCompactionInstructions("", "")).toBe(DEFAULT_COMPACTION_INSTRUCTIONS);
    });

    it("falls through to DEFAULT when both are whitespace-only", () => {
      expect(resolveCompactionInstructions("  ", "\t\n")).toBe(DEFAULT_COMPACTION_INSTRUCTIONS);
    });

    it("non-breaking space (\\u00A0) IS trimmed by ES2015+ trim() -- falls through", () => {
      const nbsp = "\u00A0";
      const result = resolveCompactionInstructions(nbsp, "runtime");
      expect(result).toBe("runtime");
    });

    it("KNOWN_EDGE: zero-width space (\\u200B) survives normalization -- invisible string used as instructions", () => {
      const zws = "\u200B";
      const result = resolveCompactionInstructions(zws, "runtime");
      expect(result).toBe(zws);
    });
  });

  describe("precedence", () => {
    it("event wins over runtime when both are non-empty", () => {
      const result = resolveCompactionInstructions("event value", "runtime value");
      expect(result).toBe("event value");
    });

    it("runtime wins when event is undefined", () => {
      const result = resolveCompactionInstructions(undefined, "runtime value");
      expect(result).toBe("runtime value");
    });

    it("event is trimmed before use", () => {
      const result = resolveCompactionInstructions("  event  ", "runtime");
      expect(result).toBe("event");
    });

    it("runtime is trimmed before use", () => {
      const result = resolveCompactionInstructions(undefined, "  runtime  ");
      expect(result).toBe("runtime");
    });
  });

  describe("truncation at 800 chars", () => {
    it("does NOT truncate string of exactly 800 chars", () => {
      const exact800 = "A".repeat(800);
      const result = resolveCompactionInstructions(exact800, undefined);
      expect(result).toHaveLength(800);
      expect(result).toBe(exact800);
    });

    it("truncates string of 801 chars to 800", () => {
      const over = "B".repeat(801);
      const result = resolveCompactionInstructions(over, undefined);
      expect(result).toHaveLength(800);
      expect(result).toBe("B".repeat(800));
    });

    it("truncates very long string to exactly 800", () => {
      const huge = "C".repeat(5000);
      const result = resolveCompactionInstructions(huge, undefined);
      expect(result).toHaveLength(800);
    });

    it("truncation applies AFTER trimming -- 810 raw chars with 10 leading spaces yields 800", () => {
      const padded = " ".repeat(10) + "D".repeat(800);
      const result = resolveCompactionInstructions(padded, undefined);
      expect(result).toHaveLength(800);
      expect(result).toBe("D".repeat(800));
    });

    it("truncation applies to runtime fallback as well", () => {
      const longRuntime = "R".repeat(1000);
      const result = resolveCompactionInstructions(undefined, longRuntime);
      expect(result).toHaveLength(800);
    });

    it("truncates by code points, not code units (emoji safe)", () => {
      const emojis801 = "\u{1F600}".repeat(801);
      const result = resolveCompactionInstructions(emojis801, undefined);
      expect(Array.from(result)).toHaveLength(800);
    });

    it("does not split surrogate pair when cut lands inside a pair", () => {
      const input = "X" + "\u{1F600}".repeat(800);
      const result = resolveCompactionInstructions(input, undefined);
      const codePoints = Array.from(result);
      expect(codePoints).toHaveLength(800);
      expect(codePoints[0]).toBe("X");
      // Every code point in the truncated result must be a complete character (no lone surrogates)
      for (const cp of codePoints) {
        const code = cp.codePointAt(0)!;
        const isLoneSurrogate = code >= 0xd800 && code <= 0xdfff;
        expect(isLoneSurrogate).toBe(false);
      }
    });
  });

  describe("return type", () => {
    it("always returns the resolved instruction string, never undefined or null", () => {
      const cases: [string | undefined, string | undefined, string][] = [
        [undefined, undefined, DEFAULT_COMPACTION_INSTRUCTIONS],
        ["", "", DEFAULT_COMPACTION_INSTRUCTIONS],
        [" ", " ", DEFAULT_COMPACTION_INSTRUCTIONS],
        [
          null as unknown as undefined,
          null as unknown as undefined,
          DEFAULT_COMPACTION_INSTRUCTIONS,
        ],
        ["valid", undefined, "valid"],
        [undefined, "valid", "valid"],
      ];

      for (const [event, runtime, expected] of cases) {
        const result = resolveCompactionInstructions(event, runtime);
        expect(typeof result).toBe("string");
        expect(result).toBe(expected);
      }
    });
  });
});

describe("composeSplitTurnInstructions", () => {
  it("joins turn prefix, separator, and resolved instructions with double newlines", () => {
    const result = composeSplitTurnInstructions("Turn prefix here", "Resolved instructions here");
    expect(result).toBe(
      "Turn prefix here\n\nAdditional requirements:\n\nResolved instructions here",
    );
  });

  it("output contains the turn prefix verbatim", () => {
    const prefix = "Summarize the last 5 messages.";
    const result = composeSplitTurnInstructions(prefix, "Keep it short.");
    expect(result).toContain(prefix);
  });

  it("output contains the resolved instructions verbatim", () => {
    const instructions = "Write in Korean. Preserve persona.";
    const result = composeSplitTurnInstructions("prefix", instructions);
    expect(result).toContain(instructions);
  });

  it("output contains 'Additional requirements:' separator", () => {
    const result = composeSplitTurnInstructions("a", "b");
    expect(result).toContain("Additional requirements:");
  });

  it("KNOWN_EDGE: empty turnPrefix produces leading blank line", () => {
    const result = composeSplitTurnInstructions("", "instructions");
    expect(result).toBe("\n\nAdditional requirements:\n\ninstructions");
    expect(result.startsWith("\n")).toBe(true);
  });

  it("KNOWN_EDGE: empty resolvedInstructions produces trailing blank area", () => {
    const result = composeSplitTurnInstructions("prefix", "");
    expect(result).toBe("prefix\n\nAdditional requirements:\n\n");
    expect(result.endsWith("\n\n")).toBe(true);
  });

  it("does not deduplicate if instructions already contain 'Additional requirements:'", () => {
    const instructions = "Additional requirements: keep it short.";
    const result = composeSplitTurnInstructions("prefix", instructions);
    const count = (result.match(/Additional requirements:/g) || []).length;
    expect(count).toBe(2);
  });

  it("preserves multiline content in both inputs", () => {
    const prefix = "Line 1\nLine 2";
    const instructions = "Rule A\nRule B\nRule C";
    const result = composeSplitTurnInstructions(prefix, instructions);
    expect(result).toContain("Line 1\nLine 2");
    expect(result).toContain("Rule A\nRule B\nRule C");
  });
});
