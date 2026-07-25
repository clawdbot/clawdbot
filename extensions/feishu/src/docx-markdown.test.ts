import { describe, expect, it } from "vitest";
import { createDocxMarkdownPlan, splitDocxMarkdownBySize } from "./docx-markdown.js";
import { parseFeishuMarkdown } from "./markdown.js";

describe("Feishu document Markdown planning", () => {
  it("collects parsed remote images without treating code as image syntax", () => {
    const markdown = [
      "![local](data:image/png;base64,AAAA)",
      "",
      "```md",
      "![not-an-image](https://fake.test/code.png)",
      "```",
      "",
      '![inline](https://cdn.test/image_(1).png "title")',
      "![referenced][hero]",
      "",
      '[hero]: https://cdn.test/hero.png "Hero"',
    ].join("\n");

    expect(createDocxMarkdownPlan(markdown).chunks.flatMap((chunk) => chunk.images)).toEqual([
      { url: undefined },
      { url: "https://cdn.test/image_(1).png" },
      { url: "https://cdn.test/hero.png" },
    ]);
  });

  it("splits at parsed level-one and level-two headings while preserving source", () => {
    const markdown = [
      "Intro",
      "---",
      "",
      "```md",
      "## not a heading",
      "```",
      "",
      "# Section",
      "body",
      "",
      "## Next",
      "tail",
    ].join("\n");

    const chunks = createDocxMarkdownPlan(markdown).chunks.map((chunk) => chunk.markdown);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toContain("## not a heading");
    expect(chunks[1]).toBe("# Section\nbody\n\n");
    expect(chunks[2]).toBe("## Next\ntail");
    expect(chunks.join("")).toBe(markdown);
  });

  it("resolves image references only within their independently converted chunk", () => {
    const markdown = [
      "![cross-chunk][hero]",
      "",
      "## Next",
      "![remote](https://cdn.test/remote.png)",
      "",
      "[hero]: https://cdn.test/hero.png",
    ].join("\n");

    const { chunks } = createDocxMarkdownPlan(markdown);

    expect(chunks.map((chunk) => chunk.images)).toEqual([
      [],
      [{ url: "https://cdn.test/remote.png" }],
    ]);
  });

  it("uses parsed block and plain-text boundaries for size fallback", () => {
    const markdown = `${"alpha ".repeat(80)}\n\n${"beta ".repeat(80)}`;

    const chunks = splitDocxMarkdownBySize(markdown, 240);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(markdown);
  });

  it("does not promote an inline block marker when splitting a long paragraph", () => {
    const markdown = `${"alpha ".repeat(50)}# literal heading marker ${"omega ".repeat(50)}`;

    const chunks = splitDocxMarkdownBySize(markdown, "alpha ".repeat(50).length);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(markdown);
    for (const chunk of chunks) {
      expect(parseFeishuMarkdown(chunk).children?.[0]?.type).toBe("paragraph");
    }
  });

  it("keeps an indivisible fenced block parseable when fallback must split it", () => {
    const markdown = [
      "```ts",
      ...Array.from({ length: 80 }, (_, index) => `line_${index}();`),
      "```",
    ].join("\n");

    const chunks = splitDocxMarkdownBySize(markdown, 160);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(parseFeishuMarkdown(chunk).children?.some((node) => node.type === "code")).toBe(true);
    }
  });

  it("splits indented code only where both chunks remain code", () => {
    const markdown = Array.from({ length: 20 }, (_, index) => `    line_${index}();`).join("\n");

    const chunks = splitDocxMarkdownBySize(markdown, 80);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(markdown);
    for (const chunk of chunks) {
      expect(parseFeishuMarkdown(chunk).children?.[0]?.type).toBe("code");
    }
  });

  it.each([
    {
      name: "list",
      markdown: Array.from({ length: 20 }, (_, index) => `- item ${index}`).join("\n"),
      nodeType: "list",
    },
    {
      name: "blockquote",
      markdown: Array.from({ length: 20 }, (_, index) => `> quote ${index}`).join("\n"),
      nodeType: "blockquote",
    },
  ])("splits a single long $name only at stable container boundaries", ({ markdown, nodeType }) => {
    const chunks = splitDocxMarkdownBySize(markdown, 80);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(markdown);
    for (const chunk of chunks) {
      expect(parseFeishuMarkdown(chunk).children?.[0]?.type).toBe(nodeType);
    }
  });

  it("splits a GFM table between rows and repeats its parsed header", () => {
    const header = "| Name | Value |\n| --- | --- |\n";
    const markdown = `${header}${Array.from(
      { length: 20 },
      (_, index) => `| item ${index} | value ${index} |`,
    ).join("\n")}`;

    const chunks = splitDocxMarkdownBySize(markdown, 180);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.startsWith(header)).toBe(true);
      expect(parseFeishuMarkdown(chunk).children?.[0]?.type).toBe("table");
    }
  });
});
