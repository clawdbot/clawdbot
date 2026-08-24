import { describe, expect, it } from "vitest";
import { markdownToIR } from "./ir.js";

describe("markdownToIR authored HTML underline", () => {
  it("emits underline spans only for authored u and ins tags when enabled", () => {
    const ir = markdownToIR("<u>under <ins>nested</ins></u> and __bold__", {
      enableHtmlUnderline: true,
    });

    expect(ir.text).toBe("under nested and bold");
    expect(ir.styles).toEqual([
      { start: 0, end: 12, style: "underline" },
      { start: 17, end: 21, style: "bold" },
    ]);
  });

  it("preserves raw HTML bytes unless underline parsing is explicitly enabled", () => {
    expect(markdownToIR("<u>under</u>").text).toBe("<u>under</u>");
  });

  it("does not enable HTML block parsing for unrelated tags", () => {
    const ir = markdownToIR("<div>\n**bold**\n</div>", { enableHtmlUnderline: true });
    expect(ir.text).toBe("<div>\nbold\n</div>");
    expect(ir.styles).toEqual([{ start: 6, end: 10, style: "bold" }]);
  });

  it("keeps entity-decoded and escaped underline tags literal", () => {
    for (const input of ["&lt;u&gt;text&lt;/u&gt;", "\\<u>text\\</u>"]) {
      const ir = markdownToIR(input, { enableHtmlUnderline: true });
      expect(ir.text, input).toBe("<u>text</u>");
      expect(ir.styles, input).toEqual([]);
    }
  });

  it("does not parse underline-shaped text inside other HTML lexemes", () => {
    for (const input of ['<span title="<u>">x</span>', "<!-- <u> -->x"]) {
      const ir = markdownToIR(input, { enableHtmlUnderline: true });
      expect(ir.text, input).toBe(input);
      expect(ir.styles, input).toEqual([]);
    }
  });
});
