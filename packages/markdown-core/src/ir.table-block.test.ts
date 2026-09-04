// Markdown Core tests cover ir.table block behavior.
import { describe, expect, it } from "vitest";
import { markdownToIRWithMeta } from "./ir.js";

describe("markdownToIRWithMeta tableMode block", () => {
  it("collects table metadata without inlining table text", () => {
    const { ir, hasTables, tables } = markdownToIRWithMeta(
      "Before\n\n| Name | Age |\n|---|---|\n| Alice | 30 |\n\nAfter",
      { tableMode: "block" },
    );

    expect(hasTables).toBe(true);
    expect(tables).toEqual([
      {
        headers: ["Name", "Age"],
        rows: [["Alice", "30"]],
        headerCells: [
          { text: "Name", styles: [], links: [] },
          { text: "Age", styles: [], links: [] },
        ],
        rowCells: [
          [
            { text: "Alice", styles: [], links: [] },
            { text: "30", styles: [], links: [] },
          ],
        ],
        placeholderOffset: ir.text.indexOf("After"),
      },
    ]);
    expect(ir.text).toBe("Before\n\nAfter");
  });

  it.each([
    {
      name: "one-space code",
      cell: "` `",
      expected: { text: " ", styles: [{ start: 0, end: 1, style: "code" }], links: [] },
    },
    {
      name: "linked code-leading space",
      cell: "[` a`](https://example.com)",
      expected: {
        text: " a",
        styles: [{ start: 0, end: 2, style: "code" }],
        links: [{ start: 0, end: 2, href: "https://example.com" }],
      },
    },
    {
      name: "ordinary whitespace",
      cell: "&nbsp;a&nbsp;",
      expected: { text: "a", styles: [], links: [] },
    },
    {
      name: "code surrounded by ordinary whitespace",
      cell: "&nbsp;` `&nbsp;",
      expected: { text: " ", styles: [{ start: 0, end: 1, style: "code" }], links: [] },
    },
  ])("preserves code-owned cell edges: $name", ({ cell, expected }) => {
    const { tables } = markdownToIRWithMeta(`| V |\n| --- |\n| ${cell} |`, {
      tableMode: "block",
    });

    expect(tables[0]?.rowCells[0]?.[0]).toEqual(expected);
  });
});
