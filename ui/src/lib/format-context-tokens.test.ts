import { describe, expect, it } from "vitest";
import { formatContextTokenCount, formatContextTokenExact } from "./format-context-tokens.ts";

describe("formatContextTokenCount", () => {
  it("formats values under 1024 as-is", () => {
    expect(formatContextTokenCount(0)).toBe("0");
    expect(formatContextTokenCount(981)).toBe("981");
    expect(formatContextTokenCount(1023)).toBe("1023");
  });

  it("uses binary kilo-tokens (÷1024)", () => {
    expect(formatContextTokenCount(1024)).toBe("1k");
    expect(formatContextTokenCount(1536)).toBe("1.5k");
    expect(formatContextTokenCount(262_144)).toBe("256k");
  });

  it("formats binary mega-tokens", () => {
    expect(formatContextTokenCount(1_048_576)).toBe("1M");
    expect(formatContextTokenCount(1_572_864)).toBe("1.5M");
  });
});

describe("formatContextTokenExact", () => {
  it("formats exact integers with grouping", () => {
    expect(formatContextTokenExact(262_144, "en-US")).toBe("262,144");
    expect(formatContextTokenExact(981, "en-US")).toBe("981");
  });
});
