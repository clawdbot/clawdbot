import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { renderTelegramMonospaceGrid } from "./text-width.js";

describe("renderTelegramMonospaceGrid", () => {
  it.each([
    ["CJK", "小明"],
    ["combining mark", "cafe\u0301"],
    ["default emoji check", "✅"],
    ["default emoji watch", "⌚"],
    ["default emoji ball", "⚽"],
    ["ZWJ family", "👨‍👩‍👧"],
    ["flag", "🇨🇳"],
    ["unqualified keycap", "1⃣"],
    ["qualified keycap", "1️⃣"],
    ["bare heart", "❤"],
    ["VS16 heart", "❤️"],
    ["bare copyright", "©"],
    ["VS16 copyright", "©️"],
  ])("matches the string-width oracle for %s", (_label, value) => {
    const oracleWidth = stringWidth(value);
    const grid = renderTelegramMonospaceGrid([
      [value, "value"],
      ["x".repeat(oracleWidth), "reference"],
    ]);
    expect(new Set(grid.split("\n").map((line) => stringWidth(line))).size).toBe(1);
  });

  it.each([
    ["zero-width space", "\u200B"],
    ["zero-width non-joiner", "\u200C"],
    ["word joiner", "\u2060"],
    ["function application", "\u2061"],
    ["soft hyphen", "\u00AD"],
    ["zero-width no-break space", "\uFEFF"],
  ])("does not allocate a cell for %s", (_label, value) => {
    const [withInvisible, reference] = renderTelegramMonospaceGrid([[`A${value}B`], ["AB"]]).split(
      "\n",
    );
    expect(withInvisible?.replace(value, "")).toBe(reference);
  });

  it("keeps the header separator aligned with data rows", () => {
    const grid = renderTelegramMonospaceGrid(
      [
        ["Name", "Status"],
        ["小明", "✅"],
      ],
      { headerSeparator: true },
    );
    expect(grid.split("\n")).toHaveLength(3);
    expect(new Set(grid.split("\n").map((line) => stringWidth(line))).size).toBe(1);
  });
});
