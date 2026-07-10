// Terminal Core tests cover ansi behavior.
import { describe, expect, it } from "vitest";
import {
  sanitizeForLog,
  splitGraphemes,
  stripAnsi,
  stripAnsiForStreamChunk,
  stripAnsiSequences,
  truncateToVisibleWidth,
  visibleWidth,
} from "./ansi.js";

const CSI_INTRODUCERS = [
  ["ESC [", "\u001B["],
  ["C1 CSI", "\u009B"],
] as const;

describe("terminal ansi helpers", () => {
  it("strips ANSI and OSC8 sequences", () => {
    expect(stripAnsi("\u001B[31mred\u001B[0m")).toBe("red");
    expect(stripAnsi("\u001B[2K\u001B[1Ared")).toBe("red");
    expect(stripAnsi("\u001B]8;;https://openclaw.ai\u001B\\link\u001B]8;;\u001B\\")).toBe("link");
    expect(stripAnsi("\u001B]8;;https://openclaw.ai\u0007link\u001B]8;;\u0007")).toBe("link");
    expect(stripAnsi("copy\u001B]52;c;YWJj\u0007safe")).toBe("copysafe");
    expect(stripAnsi("\u009B31mred\u009B0m")).toBe("red");
    expect(stripAnsi("\u009D8;;https://openclaw.ai\u009Clink\u009D8;;\u009C")).toBe("link");
    expect(stripAnsi("\u001B]unterminated")).toBe("\u001B]unterminated");
  });

  it("strips the agent output escape grammar without changing text policy", () => {
    expect(stripAnsiSequences("\u001B[38:5:196mred\u001B[0m")).toBe("red");
    expect(stripAnsiSequences("\u009B31mred\u009B0m")).toBe("red");
    expect(stripAnsiSequences("line\n\t🙂\u001B]unterminated")).toBe("line\n\t🙂nterminated");
    expect(() => stripAnsiSequences(null as never)).toThrow("Expected a `string`, got `object`");
  });

  it.each([
    ["ESC OSC with BEL", "\u001B]", "\u0007"],
    ["ESC OSC with ESC ST", "\u001B]", "\u001B\\"],
    ["ESC OSC with C1 ST", "\u001B]", "\u009C"],
    ["C1 OSC with BEL", "\u009D", "\u0007"],
    ["C1 OSC with ESC ST", "\u009D", "\u001B\\"],
    ["C1 OSC with C1 ST", "\u009D", "\u009C"],
  ])("strips %s without clipping adjacent text", (_label, introducer, terminator) => {
    expect(stripAnsiSequences(`before🙂${introducer}0;title${terminator}after界`)).toBe(
      "before🙂after界",
    );
  });

  it("sanitizes control characters for log-safe interpolation", () => {
    const input =
      "\u001B[31mwarn\u001B[0m" +
      "\r\n" +
      "next" +
      String.fromCharCode(0) +
      "line" +
      String.fromCharCode(127) +
      String.fromCharCode(0x85) +
      String.fromCharCode(0) +
      "done";
    expect(sanitizeForLog(input)).toBe("warnnextlinedone");
    expect(sanitizeForLog("\u009B31mred\u009B0m")).toBe("red");
  });

  it.each(CSI_INTRODUCERS)("strips every no-argument %s final byte", (_label, introducer) => {
    for (let finalCode = 0x40; finalCode <= 0x7e; finalCode += 1) {
      const sequence = introducer + String.fromCharCode(finalCode);
      expect(stripAnsi(`before${sequence}after`)).toBe("beforeafter");
      expect(stripAnsiSequences(`before${sequence}after`)).toBe("beforeafter");
    }
  });

  it.each(CSI_INTRODUCERS)(
    "keeps the longer legacy %s match when compatible",
    (_label, introducer) => {
      expect(stripAnsiSequences(`before${introducer}[Aafter`)).toBe("beforeafter");
      expect(stripAnsi(`before${introducer}[Aafter`)).toBe("beforeAafter");
    },
  );

  it.each(CSI_INTRODUCERS)("handles %s cancellation, restart, and EOF", (_label, introducer) => {
    for (const strip of [stripAnsi, stripAnsiSequences]) {
      expect(strip(`before${introducer}31\u0018after`)).toBe("beforeafter");
      expect(strip(`before${introducer}31\u001Aafter`)).toBe("beforeafter");
      expect(strip(`before${introducer}31\u001B[0mafter`)).toBe("beforeafter");
      expect(strip(`before${introducer}31;`)).toBe("before");
    }
  });

  it("does not reinterpret bytes joined by CSI removal as a new OSC", () => {
    const input = "\u001B\u001B[0m]visible\u0007after";
    expect(stripAnsi(input)).toBe("\u001B]visible\u0007after");
    expect(stripAnsiSequences(input)).toBe("\u001B]visible\u0007after");
    expect(sanitizeForLog(input)).toBe("]visibleafter");
  });

  it.each(CSI_INTRODUCERS)(
    "can preserve pending %s at a stream chunk boundary",
    (_label, introducer) => {
      const input = `before${introducer}31;`;
      expect(stripAnsiForStreamChunk(input)).toBe(input);
      expect(stripAnsiForStreamChunk(input, { compatibilityGrammar: true })).toBe(input);
    },
  );

  it.each(CSI_INTRODUCERS)(
    "keeps ordinary C0 controls inside %s for caller policy",
    (_label, introducer) => {
      const input = `before${introducer}31\u0001mafter`;
      expect(stripAnsi(input)).toBe("before\u0001after");
      expect(stripAnsiSequences(input)).toBe("before\u0001after");
      expect(sanitizeForLog(input)).toBe("beforeafter");
    },
  );

  it("measures wide graphemes by terminal cell width", () => {
    expect(visibleWidth("abc")).toBe(3);
    expect(visibleWidth("📸 skill")).toBe(8);
    expect(visibleWidth("表")).toBe(2);
    expect(visibleWidth("\u001B[31m📸\u001B[0m")).toBe(2);
  });

  it("keeps emoji zwj sequences as single graphemes", () => {
    expect(splitGraphemes("👨‍👩‍👧‍👦")).toEqual(["👨‍👩‍👧‍👦"]);
    expect(visibleWidth("👨‍👩‍👧‍👦")).toBe(2);
  });

  it("distinguishes text-default symbols from emoji presentation", () => {
    expect(visibleWidth("©")).toBe(1);
    expect(visibleWidth("©\uFE0E")).toBe(1);
    expect(visibleWidth("©️")).toBe(2);
    expect(visibleWidth("™")).toBe(1);
    expect(visibleWidth("™️")).toBe(2);
    expect(visibleWidth("❤")).toBe(1);
    expect(visibleWidth("❤️")).toBe(2);
    expect(visibleWidth("✈")).toBe(1);
    expect(visibleWidth("✈️")).toBe(2);
    expect(visibleWidth("⌚\uFE0E")).toBe(2);
    expect(visibleWidth("📸\uFE0E")).toBe(2);
    expect(visibleWidth("1️")).toBe(1);
    expect(visibleWidth("1⃣")).toBe(2);
    expect(visibleWidth("1️⃣")).toBe(2);
    expect(visibleWidth("❤‍")).toBe(1);
    expect(visibleWidth("☎️⃣")).toBe(1);
    expect(visibleWidth("❤‍🔥")).toBe(2);
    expect(visibleWidth("🇬")).toBe(1);
    expect(visibleWidth("🇬🇧")).toBe(2);
    expect(visibleWidth("🇬🇧🇺")).toBe(3);
  });

  it("truncates to a visible-width budget without splitting wide graphemes", () => {
    expect(truncateToVisibleWidth("abc", 2)).toBe("ab");
    expect(truncateToVisibleWidth("abc", 5)).toBe("abc");
    expect(truncateToVisibleWidth("anything", 0)).toBe("");
    // A wide grapheme that cannot fit the remaining budget is dropped whole,
    // never emitted half-width, so the result never exceeds the budget.
    expect(truncateToVisibleWidth("表文", 2)).toBe("表");
    expect(truncateToVisibleWidth("表", 1)).toBe("");
    expect(visibleWidth(truncateToVisibleWidth("📸📸", 1))).toBeLessThanOrEqual(1);
  });

  it("preserves ANSI sequences when truncating styled text", () => {
    // Trailing reset is retained even when its grapheme is dropped, so the cell
    // does not bleed styling into surrounding padding.
    expect(truncateToVisibleWidth("[31mab[0m", 1)).toBe("[31ma[0m");
    expect(truncateToVisibleWidth("[31m表文[0m", 1)).toBe("[31m[0m");
    expect(visibleWidth(truncateToVisibleWidth("[31m表文[0m", 1))).toBe(0);
  });

  it("reuses the ANSI scanner across truncation calls", () => {
    expect(truncateToVisibleWidth("\u001B[31mabc\u001B[0m", 2)).toBe("\u001B[31mab\u001B[0m");
    expect(truncateToVisibleWidth("plain", 3)).toBe("pla");
    expect(
      truncateToVisibleWidth("\u001B]8;;https://openclaw.ai\u001B\\link\u001B]8;;\u001B\\", 2),
    ).toBe("\u001B]8;;https://openclaw.ai\u001B\\li\u001B]8;;\u001B\\");
    expect(truncateToVisibleWidth("\u001B[32mxy\u001B[0m", 1)).toBe("\u001B[32mx\u001B[0m");
  });
});
