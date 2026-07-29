// Markdown Core tests cover CJK-friendly emphasis flanking.
import { describe, expect, it } from "vitest";
import { markdownToIR } from "./ir.js";

function styledText(markdown: string, style: "bold" | "italic" = "bold"): string[] {
  const ir = markdownToIR(markdown);
  return ir.styles
    .filter((span) => span.style === style)
    .map((span) => ir.text.slice(span.start, span.end));
}

describe("markdownToIR CJK emphasis flanking", () => {
  it("closes strong emphasis before adjacent Chinese text", () => {
    expect(styledText("前**加粗：**后")).toEqual(["加粗："]);
  });

  it("closes strong emphasis before adjacent Japanese text", () => {
    expect(styledText("これは**強調。**です")).toEqual(["強調。"]);
  });

  it("closes strong emphasis before adjacent Korean text", () => {
    expect(styledText("이것은 **강조:**입니다")).toEqual(["강조:"]);
  });

  it("handles supplementary CJK and variation selectors at emphasis boundaries", () => {
    expect(styledText("𰻞𰻞**（ビャンビャン）**麺")).toEqual(["（ビャンビャン）"]);
    expect(styledText("葛󠄀**(こちらが正式表記)**城市")).toEqual(["(こちらが正式表記)"]);
  });

  it("supports CJK-friendly underscore flanking without enabling Latin intraword emphasis", () => {
    expect(styledText("__注意__：注意事項")).toEqual(["注意"]);
    expect(styledText("foo_bar_baz", "italic")).toEqual([]);
  });

  it("keeps ASCII CommonMark emphasis behavior", () => {
    expect(styledText("**bold** text")).toEqual(["bold"]);
    expect(styledText("foo**bar**baz")).toEqual(["bar"]);
  });

  it("treats ideographic space (U+3000) as whitespace, not a flanking CJK char", () => {
    // Opening delimiter followed by U+3000 must not be forced open.
    expect(styledText("前**\u3000加粗**后")).toEqual([]);
    // U+3000-separated emphasis keeps normal CommonMark behavior.
    expect(styledText("前\u3000**加粗**\u3000后")).toEqual(["加粗"]);
  });

  it("treats Unicode thin space (U+2009) as whitespace in delimiter scanning", () => {
    // Opening delimiter followed by U+2009 must not be forced open.
    expect(styledText("前**\u2009加粗**后")).toEqual([]);
    // Closing delimiter after CJK punctuation still closes when followed by U+2009.
    expect(styledText("前**加粗：**\u2009后")).toEqual(["加粗："]);
  });

  it("leaves code spans and links on their existing paths", () => {
    const code = markdownToIR("`前**加粗：**后`");
    expect(code.text).toBe("前**加粗：**后");
    expect(code.styles.map((span) => span.style)).toEqual(["code"]);

    const linked = markdownToIR("[前**加粗：**后](https://example.com)");
    expect(linked.text).toBe("前加粗：后");
    expect(linked.links).toEqual([
      { start: 0, end: linked.text.length, href: "https://example.com" },
    ]);
    expect(linked.styles.filter((span) => span.style === "bold")).toEqual([
      { start: 1, end: 4, style: "bold" },
    ]);
  });
});
