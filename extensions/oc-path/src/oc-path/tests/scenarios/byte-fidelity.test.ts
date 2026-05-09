import { describe, expect, it } from "vitest";
import { emitMd } from "../../emit.js";
import { parseMd } from "../../parse.js";

function roundTrip(raw: string): string {
  const { ast } = parseMd(raw);
  return emitMd(ast);
}

describe("byte-fidelity", () => {
  it("empty file", () => {
    expect(roundTrip("")).toBe("");
  });

  it("whitespace-only file", () => {
    expect(roundTrip("   \n\n   \n")).toBe("   \n\n   \n");
  });

  it("single newline", () => {
    expect(roundTrip("\n")).toBe("\n");
  });

  it("file without trailing newline", () => {
    expect(roundTrip("## H\n- item")).toBe("## H\n- item");
  });

  it("file with trailing newline", () => {
    expect(roundTrip("## H\n- item\n")).toBe("## H\n- item\n");
  });

  it("file with multiple trailing newlines", () => {
    expect(roundTrip("## H\n- item\n\n\n")).toBe("## H\n- item\n\n\n");
  });

  it("BOM at start", () => {
    const raw = "﻿## Heading\n- item\n";
    expect(roundTrip(raw)).toBe(raw);
  });

  it("CRLF line endings", () => {
    const raw = "## H\r\n\r\n- item\r\n";
    expect(roundTrip(raw)).toBe(raw);
  });

  it("mixed line endings (CRLF + LF)", () => {
    const raw = "## H\r\n- item\n- another\r\n";
    expect(roundTrip(raw)).toBe(raw);
  });

  it("tabs preserved in body", () => {
    const raw = "## H\n\n\tindented body\n";
    expect(roundTrip(raw)).toBe(raw);
  });

  it("trailing whitespace on lines preserved", () => {
    const raw = "## Heading   \n- item   \n";
    expect(roundTrip(raw)).toBe(raw);
  });

  it("multiple consecutive blank lines preserved", () => {
    const raw = "## H\n\n\n\n- item\n";
    expect(roundTrip(raw)).toBe(raw);
  });

  it("frontmatter only, no body", () => {
    const raw = "---\nname: x\n---\n";
    expect(roundTrip(raw)).toBe(raw);
  });

  it("body only, no frontmatter, no headings", () => {
    const raw = "Just some prose.\nNo structure.\n";
    expect(roundTrip(raw)).toBe(raw);
  });

  it("frontmatter + body + multiple sections", () => {
    const raw = `---
name: github
description: gh CLI
---

Preamble.

## Boundaries

- never write to /etc

## Tools

- gh: GitHub CLI
- curl: HTTP client
`;
    expect(roundTrip(raw)).toBe(raw);
  });

  it("unicode content preserved", () => {
    const raw = "## Café Section\n\n- résumé item\n- 日本語\n";
    expect(roundTrip(raw)).toBe(raw);
  });

  it("emoji preserved", () => {
    const raw = "## 🚀 Launch\n\n- ✅ ready\n- 🔒 secure\n";
    expect(roundTrip(raw)).toBe(raw);
  });

  it("frontmatter with special chars in values", () => {
    const raw = `---\nurl: https://example.com:443/path?q=1&a=2\n---\n`;
    expect(roundTrip(raw)).toBe(raw);
  });

  it("file with mixed bullet markers (-, *, +)", () => {
    const raw = "## H\n\n- dash\n* star\n+ plus\n";
    expect(roundTrip(raw)).toBe(raw);
  });

  it("raw === parse(raw).raw === emitMd(parse(raw)) for 50 random shapes", () => {
    const inputs = [
      "",
      "\n",
      "## A\n",
      "## A\n## B\n",
      "---\n---\n",
      "---\nk: v\n---\n",
      "---\nk: v\n---\nbody\n",
      "## H\n- a\n- b\n## I\n- c\n",
      "﻿\n",
      "\r\n",
      "\t\n",
      "plain\n",
      "`code`\n",
      "```\nfence\n```\n",
      "```ts\nconst x = 1;\n```\n",
      "| a | b |\n| - | - |\n| 1 | 2 |\n",
      "> quote\n",
      "# H1 not split\n## H2 split\n",
      "preamble\n## block\nbody\n",
      "preamble\n## block\nbody\n## block2\nbody2\n",
      "## h\n\n\n\n",
      "   ## indented heading (not parsed)\n",
      "##NoSpace\n",
      "## With trailing spaces   \n- item\n",
      "## H\n- nested\n  - sub\n",
      "## H\n\n```md\n## inside code\n```\n",
      "---\na: 1\nb: \"two\"\nc: 'three'\n---\n",
      "---\nopen\nbut no close\n\nbody\n",
      "mixed\r\nline\nendings\r\n",
      "﻿---\nname: bom\n---\nbody\n",
      "## h\n- k: v\n- k2: v2\n- plain\n",
      "## h\n\n| a | b |\n|---|---|\n",
      "## h\n```sql\nSELECT 1\n```\n",
      "## h\n\n- url: http://x.example.com:80/p?q=1\n",
      "## h\n\n- key: value with: colons\n",
      '## h\n\n- key: "quoted: value"\n',
      "## h\n\n- a-b: c-d\n",
      "## h with `inline code`\n",
      "no blocks\nat all\n",
      "No body or section\n\n\n\n",
      "   \n   \n",
      "## h\n## h2\n## h3\n",
      "##\n", // empty heading
      "##  \n", // heading whitespace only
      "\n\n## h\n\n\n",
      "---\n\n---\n",
      "## h\n- \n", // empty bullet
      "## h\n\n\n```\nempty fence body\n```\n",
      "## h\n```\nunclosed fence",
      "## empty section\n## next\n",
      "0\n",
    ];
    for (const raw of inputs) {
      expect(roundTrip(raw), `failed on: ${JSON.stringify(raw.slice(0, 60))}`).toBe(raw);
    }
  });
});
