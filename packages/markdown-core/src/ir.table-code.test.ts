// Markdown Core tests cover ir.table code behavior.
import { describe, expect, it } from "vitest";
import { markdownToIR } from "./ir.js";

describe("markdownToIR tableMode code", () => {
  it("aligns CJK and emoji cells by display width", () => {
    const md = `
| Kind | Value |
| --- | --- |
| 类型 | Frontend |
| 👨‍👩‍👧‍👦 | Family |
`.trim();

    const ir = markdownToIR(md, { tableMode: "code" });

    expect(ir.text).toBe(
      [
        "| Kind | Value    |",
        "| ---- | -------- |",
        "| 类型 | Frontend |",
        "| 👨‍👩‍👧‍👦   | Family   |",
        "",
      ].join("\n"),
    );
  });

  it("keeps text-presentation and incomplete emoji sequences narrow", () => {
    const md = `
| I | L |
| --- | --- |
| © | text |
| 1️ | selector |
| A | ascii |
`.trim();

    const ir = markdownToIR(md, { tableMode: "code" });

    expect(ir.text).toBe(
      [
        "| I | L        |",
        "| --- | -------- |",
        "| © | text     |",
        "| 1️ | selector |",
        "| A | ascii    |",
        "",
      ].join("\n"),
    );
  });

  it("strips inner styles from code-mode table cells", () => {
    const md = `
| Name | Value |
|------|-------|
| **Bold** | *Italic* |
| [\`Code\`](https://example.com) | ~~Strike~~ |
`.trim();

    const ir = markdownToIR(md, { tableMode: "code" });

    expect(ir.styles).toEqual([
      {
        start: 0,
        end: ir.text.trimEnd().length + 1,
        style: "code_block",
      },
    ]);
    expect(ir.links).toEqual([]);
  });

  it.each([
    { name: "leading", cell: "` a`", expected: "| V  |\n| --- |\n|  a |\n" },
    { name: "trailing", cell: "`a `", expected: "| V  |\n| --- |\n| a  |\n" },
  ])("measures code-owned $name space as cell content", ({ cell, expected }) => {
    expect(markdownToIR(`| V |\n| --- |\n| ${cell} |`, { tableMode: "code" })).toEqual({
      text: expected,
      styles: [{ start: 0, end: expected.length, style: "code_block" }],
      links: [],
    });
  });
});
