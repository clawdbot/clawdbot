import { describe, expect, it } from "vitest";
import { markdownToIR } from "./ir.js";

describe("markdownToIR tableMode bullets", () => {
  it("converts simple table to bullets", () => {
    const md = `
| Name | Value |
|------|-------|
| A    | 1     |
| B    | 2     |
`.trim();

    const ir = markdownToIR(md, { tableMode: "bullets" });

    // Should contain bullet points with header:value format
    expect(ir.text).toContain("• Value: 1");
    expect(ir.text).toContain("• Value: 2");
    // Should use first column as labels
    expect(ir.text).toContain("A");
    expect(ir.text).toContain("B");
  });

  it("handles table with multiple columns", () => {
    const md = `
| Feature | SQLite | Postgres |
|---------|--------|----------|
| Speed   | Fast   | Medium   |
| Scale   | Small  | Large    |
`.trim();

    const ir = markdownToIR(md, { tableMode: "bullets" });

    // First column becomes row label
    expect(ir.text).toContain("Speed");
    expect(ir.text).toContain("Scale");
    // Other columns become bullet points
    expect(ir.text).toContain("• SQLite: Fast");
    expect(ir.text).toContain("• Postgres: Medium");
    expect(ir.text).toContain("• SQLite: Small");
    expect(ir.text).toContain("• Postgres: Large");
  });

  it("leaves table syntax untouched by default", () => {
    const md = `
| A | B |
|---|---|
| 1 | 2 |
`.trim();

    const ir = markdownToIR(md);

    // No table conversion by default
    expect(ir.text).toContain("| A | B |");
    expect(ir.text).toContain("| 1 | 2 |");
    expect(ir.text).not.toContain("•");
    expect(ir.styles.map((style) => style.style)).not.toContain("code_block");
  });

  it("handles empty cells gracefully", () => {
    const md = `
| Name | Value |
|------|-------|
| A    |       |
| B    | 2     |
`.trim();

    const ir = markdownToIR(md, { tableMode: "bullets" });

    // Should handle empty cell without crashing
    expect(ir.text).toContain("B");
    expect(ir.text).toContain("• Value: 2");
  });

  it("bolds row labels in bullets mode", () => {
    const md = `
| Name | Value |
|------|-------|
| Row1 | Data1 |
`.trim();

    const ir = markdownToIR(md, { tableMode: "bullets" });

    // Should have bold style for row label
    expect(
      ir.styles
        .filter((style) => style.style === "bold")
        .map((style) => ir.text.slice(style.start, style.end)),
    ).toContain("Row1");
  });

  it("renders tables as code blocks in code mode", () => {
    const md = `
| A | B |
|---|---|
| 1 | 2 |
`.trim();

    const ir = markdownToIR(md, { tableMode: "code" });

    expect(ir.text).toContain("| A | B |");
    expect(ir.text).toContain("| 1 | 2 |");
    expect(ir.styles.map((style) => style.style)).toContain("code_block");
  });

  it("preserves inline styles and links in bullets mode", () => {
    const md = `
| Name | Value |
|------|-------|
| _Row_ | [Link](https://example.com) |
`.trim();

    const ir = markdownToIR(md, { tableMode: "bullets" });

    expect(
      ir.styles
        .filter((style) => style.style === "italic")
        .map((style) => ir.text.slice(style.start, style.end)),
    ).toContain("Row");
    expect(ir.links.map((link) => link.href)).toContain("https://example.com");
  });
});
