// Markdown Core tests cover tables behavior.
import MarkdownIt from "markdown-it";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markdownToIR } from "./ir.js";
import { convertMarkdownTables } from "./tables.js";

const markdownToIRWithMetaMock = vi.hoisted(() => vi.fn());

vi.mock("./ir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ir.js")>();
  markdownToIRWithMetaMock.mockImplementation(actual.markdownToIRWithMeta);
  return { ...actual, markdownToIRWithMeta: markdownToIRWithMetaMock };
});

describe("convertMarkdownTables", () => {
  beforeEach(() => {
    markdownToIRWithMetaMock.mockClear();
  });

  it.each(["code", "bullets", "block"] as const)(
    "preserves non-table Markdown source in %s mode",
    (mode) => {
      const before = "# Heading\n\nKeep \\*stars\\* and ``a`b`` literal.\n\n";
      const after = "\n\n> Keep this quote.\n";
      const rendered = convertMarkdownTables(
        `${before}| A | B |\n| --- | --- |\n| 1 | 2 |${after}`,
        mode,
      );

      expect(rendered.startsWith(before)).toBe(true);
      expect(rendered.endsWith(after)).toBe(true);
    },
  );

  it("preserves escaped literals, code delimiters and reference links in bullet cells", () => {
    const references = '\n\n[docs]: https://example.com/guide "Guide"\n';
    const rendered = convertMarkdownTables(
      "| Name | Value |\n| --- | --- |\n| Entry | \\*stars\\*, ``a`b`` and [manual][docs] |" +
        references,
      "bullets",
    );
    const html = new MarkdownIt().render(rendered);

    expect(html).toContain("*stars*");
    expect(html).not.toContain("<em>stars</em>");
    expect(html).toContain("<code>a`b</code>");
    expect(html).toContain('<a href="https://example.com/guide" title="Guide">manual</a>');
    expect(rendered.endsWith(references)).toBe(true);
  });

  it.each([
    ["single-column rows", "| A |\n| --- |\n| x |\n| y |", "• A: x\n\n• A: y"],
    ["empty middle row", "| A |\n| --- |\n| x |\n| |\n| y |", "• A: x\n\n\n• A: y"],
    ["empty edge rows", "| A |\n| --- |\n| |\n| x |\n| |", "\n• A: x"],
    ["only empty rows", "| A |\n| --- |\n| |\n| |", ""],
    [
      "empty labeled row",
      "| A | B |\n| --- | --- |\n| x | 1 |\n| | |\n| y | 2 |",
      "**x**\n• B: 1\n\n\n**y**\n• B: 2",
    ],
  ])("preserves existing bullet spacing for %s", (_name, input, expected) => {
    expect(convertMarkdownTables(input, "bullets")).toBe(expected);
    expect(markdownToIR(input, { tableMode: "bullets" }).text).toBe(expected.replaceAll("**", ""));
  });

  it("keeps the existing table recognition for list-like headers", () => {
    const rendered = convertMarkdownTables("- A | B\n---|---\nx|y", "code");

    expect(rendered).toContain("| - A | B |");
    expect(new MarkdownIt().render(rendered)).toContain("<pre><code>");
  });

  it.each(["code", "bullets"] as const)("preserves escaped table pipes in %s cells", (mode) => {
    const rendered = convertMarkdownTables(
      "| Name | Value |\n| --- | --- |\n| Entry | a\\|b and ``x`y`` |",
      mode,
    );
    const html = new MarkdownIt().render(rendered);

    expect(html).toContain("a|b");
    expect(html).toContain(mode === "bullets" ? "<code>x`y</code>" : "x`y");
  });

  it("chooses a code fence that contains literal backtick runs", () => {
    const rendered = convertMarkdownTables(
      "| A | B |\n| --- | --- |\n| 1 | ````a```b```` |",
      "code",
    );

    expect(new MarkdownIt().render(rendered)).toContain("a```b");
    expect(rendered.startsWith("````\n")).toBe(true);
  });

  it("converts separate tables without changing the Markdown between them", () => {
    const between = "\n\n## Middle\n\nKeep ``a`b`` and \\*literal\\*.\n\n";
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const rendered = convertMarkdownTables(table + between + table, "code");

    expect(rendered.split(between)).toHaveLength(2);
    expect(new MarkdownIt().render(rendered).match(/<pre><code>/g)).toHaveLength(2);
  });

  it.each([
    ["blockquote", "> ", "> ", "<blockquote>"],
    ["list", "- ", "  ", "<ul>"],
    ["quoted list", "> - ", ">   ", "<blockquote>\n<ul>"],
  ])("keeps a converted table in its %s container", (_label, first, continuation, container) => {
    const input = [
      `${first}| A | B |`,
      `${continuation}| --- | --- |`,
      `${continuation}| 1 | 2 |`,
    ].join("\n");
    const rendered = convertMarkdownTables(input, "code");
    const html = new MarkdownIt().render(rendered);

    expect(rendered.startsWith(`${first}\`\`\``)).toBe(true);
    expect(html).toContain(container);
    expect(html).toContain("<pre><code>| A | B |");
  });

  it("keeps reference labels in code tables and leaves document definitions untouched", () => {
    const references = "\n\n[docs]: https://example.com/guide\n";
    const rendered = convertMarkdownTables(
      "| Name | Value |\n| --- | --- |\n| Entry | [manual][docs] |" + references,
      "code",
    );

    expect(rendered).toContain("| Entry | manual |");
    expect(rendered.endsWith(references)).toBe(true);
  });

  it("preserves CRLF source around a table", () => {
    const before = "Keep \\*literal\\*.\r\n\r\n";
    const after = "\r\n\r\nAfter.\r\n";
    const rendered = convertMarkdownTables(
      `${before}| A | B |\r\n| --- | --- |\r\n| 1 | 2 |${after}`,
      "code",
    );

    expect(rendered.startsWith(before)).toBe(true);
    expect(rendered.endsWith(after)).toBe(true);
  });

  it("leaves table-shaped text inside fences untouched", () => {
    const input = "```markdown\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```\n";

    expect(convertMarkdownTables(input, "bullets")).toBe(input);
  });

  it("falls back to code rendering for block mode", () => {
    const rendered = convertMarkdownTables("| A | B |\n|---|---|\n| 1 | 2 |", "block");

    expect(rendered).toBe("```\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```");
  });

  it("does not parse ordinary text that cannot contain a table", () => {
    const text = "Ordinary iMessage reply with **bold** and _emphasis_.";

    expect(convertMarkdownTables(text, "code")).toBe(text);
    expect(markdownToIRWithMetaMock).not.toHaveBeenCalled();
  });
});
