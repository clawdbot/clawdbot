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
});
