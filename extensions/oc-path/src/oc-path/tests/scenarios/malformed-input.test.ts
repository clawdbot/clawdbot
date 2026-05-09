import { describe, expect, it } from "vitest";
import { parseMd } from "../../parse.js";

describe("malformed-input", () => {
  it("truncated mid-frontmatter (no close fence)", () => {
    const raw = "---\nname: github\n";
    const { ast, diagnostics } = parseMd(raw);
    expect(diagnostics.some((d) => d.code === "OC_FRONTMATTER_UNCLOSED")).toBe(true);
    expect(ast.frontmatter).toEqual([]);
  });

  it("truncated mid-section", () => {
    const raw = "## H\n- item\nmid-line";
    const { ast } = parseMd(raw);
    expect(ast.blocks.length).toBe(1);
  });

  it("only `---` (single fence, no content)", () => {
    expect(() => parseMd("---\n")).not.toThrow();
  });

  it("only `---\\n---`", () => {
    const { ast } = parseMd("---\n---");
    expect(ast.frontmatter).toEqual([]);
  });

  it("binary-ish bytes (non-ASCII control chars)", () => {
    const raw = "## H\n\x00\x01\x02\n";
    expect(() => parseMd(raw)).not.toThrow();
  });

  it("very long single line (10k chars)", () => {
    const raw = `## H\n${"x".repeat(10_000)}\n`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.heading).toBe("H");
  });

  it("deeply repeated headings (1000 H2 blocks)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(`## H${i}`);
      lines.push(`- item ${i}`);
    }
    const raw = lines.join("\n") + "\n";
    const { ast } = parseMd(raw);
    expect(ast.blocks.length).toBe(1000);
  });

  it("bullet shape that isn't actually a bullet (`-not-a-bullet`)", () => {
    const { ast } = parseMd("## H\n-not-a-bullet\n- real\n");
    expect(ast.blocks[0]?.items.length).toBe(1);
  });

  it("unclosed code fence", () => {
    const raw = "## H\n```\nbody\n";
    expect(() => parseMd(raw)).not.toThrow();
  });

  it("mismatched fence (open with ``` close with ~~~)", () => {
    const raw = "## H\n```\nbody\n~~~\n";
    expect(() => parseMd(raw)).not.toThrow();
  });

  it("nested fences (treated linearly, not nested)", () => {
    const raw = "## H\n```\n```\nstill-in-second\n```\n";
    expect(() => parseMd(raw)).not.toThrow();
  });

  it("empty file", () => {
    const { ast, diagnostics } = parseMd("");
    expect(ast.raw).toBe("");
    expect(ast.frontmatter).toEqual([]);
    expect(ast.blocks).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("single character file", () => {
    const { ast } = parseMd("x");
    expect(ast.preamble).toBe("x");
    expect(ast.blocks).toEqual([]);
  });

  it("single newline file", () => {
    const { ast } = parseMd("\n");
    expect(ast.blocks).toEqual([]);
  });

  it("file with mixed indentation extremes (tabs, spaces, mixed)", () => {
    const raw = "## H\n\t- tabbed\n  - spaced\n\t  - mixed\n";
    expect(() => parseMd(raw)).not.toThrow();
  });

  it("frontmatter with frontmatter-shaped content inside (---)", () => {
    const raw = "---\nk: v\n---\n\n---\nshould not parse as second frontmatter\n---\n";
    const { ast } = parseMd(raw);
    expect(ast.frontmatter.map((e) => e.key)).toEqual(["k"]);
    // Second `---` block becomes part of preamble/body (it's not at file start).
    expect(ast.preamble).toContain("---");
  });

  it("lines starting with `#` but not heading (raw `#` chars in body)", () => {
    const raw = "## H\n\n# This is text starting with #\n#### h4 not parsed as block\n";
    const { ast } = parseMd(raw);
    expect(ast.blocks.length).toBe(1);
    expect(ast.blocks[0]?.bodyText).toContain("# This is text");
  });

  it("lines starting with multiple ## but malformed (####, ######)", () => {
    const { ast } = parseMd("## Real\n#### Not block\n###### Not block\n");
    expect(ast.blocks.length).toBe(1);
    expect(ast.blocks[0]?.heading).toBe("Real");
  });

  it("file with just whitespace", () => {
    expect(() => parseMd("     \n\t\n   \n")).not.toThrow();
  });

  it("file with only BOM", () => {
    const { ast } = parseMd("﻿");
    expect(ast.raw).toBe("﻿");
  });

  it("file mixing BOM + frontmatter + body + sections", () => {
    const raw = "﻿---\nk: v\n---\n\nbody\n## Section\n- item\n";
    expect(() => parseMd(raw)).not.toThrow();
    const { ast } = parseMd(raw);
    expect(ast.frontmatter[0]?.value).toBe("v");
    expect(ast.blocks[0]?.heading).toBe("Section");
  });

  it("line endings: legacy CR-only (Mac classic)", () => {
    // Our regex /\r?\n/ doesn't split on CR-only. Treats whole as one line.
    const raw = "line1\rline2\r## Heading\r";
    expect(() => parseMd(raw)).not.toThrow();
  });

  it("100 KB file", () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push("## H" + i);
      for (let j = 0; j < 5; j++) {
        lines.push(`- item-${i}-${j}: value with some text content here`);
      }
    }
    const raw = lines.join("\n");
    expect(() => parseMd(raw)).not.toThrow();
  });
});
