// Terminal Core tests cover ansi behavior.
import { describe, expect, it } from "vitest";
import { AnsiSequenceStripper } from "./ansi-sequences.js";
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

  it.each([
    ["ESC OSC with BEL", ["A\u001B]0;title", "\u0007B"]],
    ["ESC OSC with ESC ST", ["A\u001B]0;title", "\u001B\\B"]],
    ["C1 OSC with C1 ST", ["A\u009D0;title", "\u009CB"]],
    ["C1 OSC with ESC ST", ["A\u009D0;title", "\u001B\\B"]],
    ["ESC CSI", ["A\u001B[31", "mB"]],
    ["C1 CSI", ["A\u009B31", "mB"]],
    ["ESC compatibility charset", ["A\u001B(", "BB"]],
    ["ESC compatibility bracket prefix", ["A\u001B[", "[AB"]],
    ["ESC compatibility mixed prefixes", ["A\u001B(", "[31mB"]],
  ])("strips chunked %s sequences incrementally", (_label, chunks) => {
    const stripper = new AnsiSequenceStripper();

    const split = chunks.map((chunk) => stripper.write(chunk)).join("") + stripper.finish();
    const joined = stripAnsiSequences(chunks.join(""));

    expect(split).toBe("AB");
    expect(split).toBe(joined);
  });

  it("keeps a trailing ESC pending until the next chunk can identify OSC", () => {
    const chunks = ["A\u001B", "]0;title\u0007B"];
    const stripper = new AnsiSequenceStripper();

    const split = chunks.map((chunk) => stripper.write(chunk)).join("") + stripper.finish();
    const joined = stripAnsiSequences(chunks.join(""));

    expect(split).toBe("AB");
    expect(split).toBe(joined);
  });

  it("drops unterminated chunked OSC payload without retaining it until finish", () => {
    const stripper = new AnsiSequenceStripper();

    const split =
      stripper.write("line\n\t🙂\u001B]unter") + stripper.write("minated") + stripper.finish();

    expect(split).toBe("line\n\t🙂");
  });

  it("does not retain large unterminated OSC payloads", () => {
    const stripper = new AnsiSequenceStripper();
    const payload = "x".repeat(1024 * 1024);

    const split = stripper.write("safe\u001B]0;") + stripper.write(payload) + stripper.finish();

    expect(split).toBe("safe");
  });

  it("accepts every standard CSI final byte after a chunk boundary", () => {
    for (let final = 0x40; final <= 0x7e; final += 1) {
      const stripper = new AnsiSequenceStripper();
      const split = stripper.write("A\u001B[31") + stripper.write(`${String.fromCharCode(final)}B`);

      expect(split).toBe("AB");
    }
  });

  it.each([
    ["BEL", "\u0007"],
    ["C1 ST", "\u009C"],
  ])("terminates OSC after stray ESC before %s", (_label, terminator) => {
    const stripper = new AnsiSequenceStripper();
    const input = `A\u001B]0;title\u001B${terminator}B`;
    const split = stripper.write(input.slice(0, -1)) + stripper.write(input.slice(-1));

    expect(stripAnsiSequences(input)).toBe("AB");
    expect(split).toBe("AB");
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
    expect(visibleWidth("\u0007\u007F\u0085")).toBe(0);
    expect(visibleWidth("a\u001B[31\u0001mb")).toBe(2);
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

  it("counts independently executed controls inside atomic CSI sequences", () => {
    const sequence = "\x1b[31\tm";
    const truncated = truncateToVisibleWidth(`a${sequence}B`, 2);
    expect(truncated).toBe(`a${sequence}`);
    expect(visibleWidth(truncated)).toBe(2);
    expect(visibleWidth(truncateToVisibleWidth(`a${sequence}B`, 1))).toBe(1);

    const reset = truncateToVisibleWidth("\x1b[31mA\x1b[0\tmB", 1);
    expect(reset).toBe("\x1b[31mA\x1b[0m");
    expect(visibleWidth(reset)).toBe(1);
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
