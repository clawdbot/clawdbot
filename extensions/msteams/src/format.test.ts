import { describe, expect, it } from "vitest";
import { formatMSTeamsMarkdown } from "./format.js";

describe("formatMSTeamsMarkdown", () => {
  const fixtures = [
    {
      name: "falls headings back to bold text",
      before: "# Deployment status",
      after: "**Deployment status**",
    },
    {
      name: "falls unordered lists back to mobile-safe bullets",
      before: "- alpha\n- beta",
      after: "• alpha\n• beta",
    },
    {
      name: "falls ordered lists back to numbered text",
      before: "1. alpha\n2. beta",
      after: "1. alpha\n2. beta",
    },
    {
      name: "falls task lists back to checkbox text",
      before: "- [x] shipped\n- [ ] pending",
      after: "[x] shipped\n[ ] pending",
    },
    {
      name: "keeps partially supported strikethrough markers",
      before: "~~obsolete~~",
      after: "~~obsolete~~",
    },
    {
      name: "keeps supported blockquote markers",
      before: "> quoted",
      after: "> quoted",
    },
    {
      name: "keeps every paragraph inside a blockquote",
      before: "> one\n>\n> two",
      after: "> one\n> \n> two",
    },
    {
      name: "stops blockquote prefixes before following text",
      before: "> quoted\n\noutside",
      after: "> quoted\n\noutside",
    },
    {
      name: "does not linkify plain filenames",
      before: "See README.md",
      after: "See README.md",
    },
    {
      name: "preserves entity-encoded markdown literals",
      before: "&#42;&#42;literal&#42;&#42;",
      after: "&#42;&#42;literal&#42;&#42;",
    },
    {
      name: "preserves transport-owned mentions",
      before: "@[Alice](29:abc)",
      after: "@[Alice](29:abc)",
    },
    {
      name: "preserves escaped brackets in transport-owned mentions",
      before: String.raw`@[Alice \[Ops\]](29:abc)`,
      after: String.raw`@[Alice \[Ops\]](29:abc)`,
    },
    {
      name: "preserves transport-owned markdown images",
      before: "![chart](https://example.com/chart_(final).png)",
      after: "![chart](https://example.com/chart_(final).png)",
    },
    {
      name: "preserves images containing nested opener text",
      before: "![plot](https://example.com/a![b].png)",
      after: "![plot](https://example.com/a![b].png)",
    },
    {
      name: "includes protected image backticks when choosing code delimiters",
      before: "``![x`](https://example.com/x.png)``",
      after: "``![x`](https://example.com/x.png)``",
    },
    {
      name: "keeps every fenced-code line inside a blockquote",
      before: "> ```\n> one\n> two\n> ```",
      after: "> ```\n> one\n> two\n> ```",
    },
    {
      name: "keeps surrounding blockquote text around inline code",
      before: "> Run `status` now.",
      after: "> Run `status` now.",
    },
    {
      name: "keeps escaped markdown literal",
      before: String.raw`\*literal\*`,
      after: String.raw`\*literal\*`,
    },
    {
      name: "keeps escaped literal backticks",
      before: String.raw`\`literal\``,
      after: String.raw`\`literal\``,
    },
    {
      name: "restores escaped markdown nested inside code",
      before: "`\\*`",
      after: "`\\*`",
    },
    {
      name: "falls nested lists back without treating indentation as code",
      before: "- parent\n    - child",
      after: "• parent\n  • child",
    },
    {
      name: "keeps inline code delimiters that protect embedded backticks",
      before: "``value `with` ticks``",
      after: "``value `with` ticks``",
    },
    {
      name: "includes escaped backticks when choosing inline code delimiters",
      before: "``a \\` b``",
      after: "``a \\` b``",
    },
    {
      name: "preserves inline code semantics while normalizing boundary spaces",
      before: "`  foo  `",
      after: "` foo`",
    },
    {
      name: "serializes link destinations with angle brackets",
      before: "[x](https://host/a)",
      after: "[x](<https://host/a>)",
    },
    {
      name: "drops code language while keeping a collision-safe fence",
      before: ["````md", "```", "example", "```", "````"].join("\n"),
      after: ["````", "```", "example", "```", "````"].join("\n"),
    },
    {
      name: "normalizes indented code to a collision-safe fence",
      before: "    **literal code**",
      after: ["```", "**literal code**", "```"].join("\n"),
    },
  ];

  for (const fixture of fixtures) {
    it(fixture.name, () => {
      expect(formatMSTeamsMarkdown(fixture.before, "off")).toBe(fixture.after);
    });
  }

  it("keeps raw tables when table conversion is disabled", () => {
    const table = ["| Name | State |", "|---|---|", "| deploy | ready |"].join("\n");
    expect(formatMSTeamsMarkdown(table, "off")).toBe(table);
  });

  it("keeps one-column raw tables when table conversion is disabled", () => {
    const table = ["| Name |", "|---|", "| deploy |"].join("\n");
    expect(formatMSTeamsMarkdown(table, "off")).toBe(table);
  });

  it("keeps raw tables with tab-padded delimiter cells", () => {
    const table = ["| A | B |", "|\t---\t|\t---\t|", "| x | y |"].join("\n");
    expect(formatMSTeamsMarkdown(table, "off")).toBe(table);
  });

  it("keeps pipe-less body rows in raw tables when conversion is disabled", () => {
    const table = ["| Name | State |", "|---|---|", "[deploy](https://host/a)"].join("\n");
    expect(formatMSTeamsMarkdown(table, "off")).toBe(table);
  });

  it("does not treat tables inside fenced code as raw table blocks", () => {
    const before = ["```", "| A | B |", "|---|---|", "| x | y |", "```", "", "# Next"].join("\n");
    const after = ["```", "| A | B |", "|---|---|", "| x | y |", "```", "**Next**"].join("\n");
    expect(formatMSTeamsMarkdown(before, "off")).toBe(after);
  });

  it("protects table-looking fenced blocks inside blockquotes", () => {
    const fence = [
      "> ```",
      "> | A | B |",
      "> |---|---|",
      "> ![x](https://e.test/a?x=1&amp;y=2)",
      "> ```",
    ].join("\n");
    expect(formatMSTeamsMarkdown(`${fence}\n\n# Next`, "off")).toBe(`${fence}\n**Next**`);
  });

  it("stops blockquoted raw tables at quote-only lines", () => {
    const before = ["> | A | B |", "> |---|---|", "> | x | y |", ">", "> # Next"].join("\n");
    const after = ["> | A | B |", "> |---|---|", "> | x | y |", "> ", "> **Next**"].join("\n");
    expect(formatMSTeamsMarkdown(before, "off")).toBe(after);
  });

  it("stops quoted raw tables when following content leaves the quote", () => {
    const before = ["> | A | B |", "> |---|---|", "> | x | y |", "# Next"].join("\n");
    const after = ["> | A | B |", "> |---|---|", "> | x | y |", "", "**Next**"].join("\n");
    expect(formatMSTeamsMarkdown(before, "off")).toBe(after);
  });

  it("ends unclosed quoted fences when the quote container ends", () => {
    const before = ["> ```", "> code", "", "| A | B |", "|---|---|", "| x | y |"].join("\n");
    const after = ["> ```", "> code", "> ```", "| A | B |", "|---|---|", "| x | y |"].join("\n");
    expect(formatMSTeamsMarkdown(before, "off")).toBe(after);
  });

  it("preserves quoted text around fenced code", () => {
    const before = ["> Before", ">", "> ```", "> code", "> ```", ">", "> After"].join("\n");
    const output = formatMSTeamsMarkdown(before, "off");
    expect(output).toContain("> Before");
    expect(output).toContain("> ```\n> code\n> ```");
    expect(output).toContain("> After");
    expect(output).not.toContain("```> ");
  });

  it("measures raw table quote depth from leading markers only", () => {
    const table = ["| A > B | State |", "|---|---|", "[x](https://host/a)"].join("\n");
    expect(formatMSTeamsMarkdown(table, "off")).toBe(table);
  });

  it("stops nested quoted tables at quote-only lines", () => {
    const before = ["> > | A | B |", "> > |---|---|", "> > | x | y |", "> >", "> > # Next"].join(
      "\n",
    );
    const output = formatMSTeamsMarkdown(before, "off");
    expect(output).toContain("**Next**");
    expect(output).not.toContain("# Next");
  });

  it("stops quoted tables at quote-only lines with trailing whitespace", () => {
    const before = ["> | A | B |", "> |---|---|", "> | x | y |", ">  ", "> # Next"].join("\n");
    expect(formatMSTeamsMarkdown(before, "off")).toContain("**Next**");
  });

  it("ends list-contained fence state on outdent", () => {
    const before = ["- ```", "  code", "", "| A | B |", "|---|---|", "[x](https://host/a)"].join(
      "\n",
    );
    expect(formatMSTeamsMarkdown(before, "off")).toContain("[x](https://host/a)");
  });

  it("stops raw tables at interrupting headings without a blank line", () => {
    const before = ["| A | B |", "|---|---|", "| x | y |", "# Next"].join("\n");
    expect(formatMSTeamsMarkdown(before, "off")).toContain("**Next**");
  });

  it("does not hide later blocks behind malformed images", () => {
    const output = formatMSTeamsMarkdown("![x](bad\n\n# Next)", "off");
    expect(output).toContain("**Next");
    expect(output).not.toContain("# Next");
  });

  it("does not let nested images complete malformed outer candidates", () => {
    const output = formatMSTeamsMarkdown("![broken\n# Next ![x](https://e.test/x.png)", "off");
    expect(output).toContain("**Next");
    expect(output).toContain("![x](https://e.test/x.png)");
  });

  it("tracks fences opened on list continuation lines", () => {
    const before = [
      "- item",
      "  ```",
      "  code",
      "",
      "| A | B |",
      "|---|---|",
      "[x](https://host/a)",
    ].join("\n");
    expect(formatMSTeamsMarkdown(before, "off")).toContain("[x](https://host/a)");
  });

  it("rejects backticks in backtick fence info strings", () => {
    const before = ["```bad`", "", "| A | B |", "|---|---|", "[x](https://host/a)"].join("\n");
    expect(formatMSTeamsMarkdown(before, "off")).toContain("[x](https://host/a)");
  });

  it("treats tab-indented fence markers as indented code", () => {
    const before = ["\t```", "", "| A | B |", "|---|---|", "[x](https://host/a)"].join("\n");
    expect(formatMSTeamsMarkdown(before, "off")).toContain("[x](https://host/a)");
  });

  it("treats over-indented quoted fence markers as indented code", () => {
    const before = ["    > ```", "", "> | A | B |", "> |---|---|", "> [x](https://host/a)"].join(
      "\n",
    );
    expect(formatMSTeamsMarkdown(before, "off")).toContain("> [x](https://host/a)");
  });

  it("formats surrounding constructs while preserving a disabled raw table", () => {
    const table = ["| Name | State |", "|---|---|", "| deploy | ready |"].join("\n");
    const before = `# Status\n\n${table}\n\n- next`;
    expect(formatMSTeamsMarkdown(before, "off")).toBe(`**Status**\n\n${table}\n\n• next`);
  });

  it("keeps blockquoted tables raw when table conversion is disabled", () => {
    const table = ["> | Name | State |", "> |---|---|", "> | deploy | ready |"].join("\n");
    expect(formatMSTeamsMarkdown(table, "off")).toBe(table);
  });

  it("does not restore forged placeholders decoded from character references", () => {
    const source = "&#xE000;msteamsformat&#xE001;m0&#xE002; @[Alice](29:abc)";
    const output = formatMSTeamsMarkdown(source, "off");
    expect(output.match(/@\[Alice\]/gu)).toHaveLength(1);
    expect(output).toContain("&#xE000;msteamsformat&#xE001;m0&#xE002;");
  });
});
