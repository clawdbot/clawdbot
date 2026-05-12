import { describe, expect, it } from "vitest";
import { parseMd } from "../parse.js";

describe("parseMd — frontmatter", () => {
  it("parses simple frontmatter", () => {
    const raw = `---
name: github
description: gh CLI for issues, PRs, runs
---

Body text.
`;
    const { ast, diagnostics } = parseMd(raw);
    expect(diagnostics).toEqual([]);
    expect(ast.frontmatter).toEqual([
      { key: "name", value: "github", line: 2 },
      { key: "description", value: "gh CLI for issues, PRs, runs", line: 3 },
    ]);
  });

  it("handles no frontmatter", () => {
    const raw = `## First section\n\nContent.\n`;
    const { ast } = parseMd(raw);
    expect(ast.frontmatter).toEqual([]);
    expect(ast.preamble).toBe("");
    expect(ast.blocks.length).toBe(1);
  });

  it("emits diagnostic for unclosed frontmatter", () => {
    const raw = `---
name: github
description: never closes

Body.
`;
    const { diagnostics } = parseMd(raw);
    expect(diagnostics).toStrictEqual([
      {
        line: 1,
        message: "frontmatter opens with --- but never closes",
        severity: "warning",
        code: "OC_FRONTMATTER_UNCLOSED",
      },
    ]);
  });

  it("strips quotes from values", () => {
    const raw = `---
title: "Hello world"
hint: 'quoted'
---
`;
    const { ast } = parseMd(raw);
    expect(ast.frontmatter[0]?.value).toBe("Hello world");
    expect(ast.frontmatter[1]?.value).toBe("quoted");
  });
});

describe("parseMd — H2 blocks", () => {
  it("splits sections", () => {
    const raw = `Preamble text.

## First

Body of first.

## Second

Body of second.
`;
    const { ast } = parseMd(raw);
    expect(ast.preamble.trim()).toBe("Preamble text.");
    expect(ast.blocks.length).toBe(2);
    expect(ast.blocks[0]?.heading).toBe("First");
    expect(ast.blocks[0]?.slug).toBe("first");
    expect(ast.blocks[1]?.heading).toBe("Second");
  });

  it("preserves line numbers (1-based)", () => {
    const raw = `Line 1
## Heading at line 2
Line 3
`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.line).toBe(2);
  });

  it("does NOT split on `## ` inside fenced code blocks", () => {
    const raw = `## Real section

\`\`\`md
## Not a heading
content
\`\`\`

## Another section
`;
    const { ast } = parseMd(raw);
    expect(ast.blocks.map((b) => b.heading)).toEqual(["Real section", "Another section"]);
  });
});

describe("parseMd — items", () => {
  it("extracts plain bullet items", () => {
    const raw = `## Boundaries

- never write to /etc
- always confirm before deleting
`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.items.length).toBe(2);
    expect(ast.blocks[0]?.items[0]?.text).toBe("never write to /etc");
    expect(ast.blocks[0]?.items[0]?.kv).toBeUndefined();
  });

  it("extracts kv items", () => {
    const raw = `## Tools

- gh: GitHub CLI
- curl: HTTP client
`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.items[0]?.kv).toEqual({ key: "gh", value: "GitHub CLI" });
    expect(ast.blocks[0]?.items[0]?.slug).toBe("gh");
    expect(ast.blocks[0]?.items[1]?.kv).toEqual({ key: "curl", value: "HTTP client" });
  });

  it("does NOT extract bullets inside fenced code", () => {
    const raw = `## Section

\`\`\`
- not a bullet
\`\`\`

- real bullet
`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.items.length).toBe(1);
    expect(ast.blocks[0]?.items[0]?.text).toBe("real bullet");
  });
});

describe("parseMd — byte-fidelity", () => {
  it("preserves raw on the AST", () => {
    const raw = `---\nname: x\n---\n\n## Sec\n\n- a\n- b\n`;
    const { ast } = parseMd(raw);
    expect(ast.raw).toBe(raw);
  });

  it("preserves BOM in raw but ignores it for parsing", () => {
    const raw = "﻿## Heading\n";
    const { ast } = parseMd(raw);
    expect(ast.raw).toBe(raw);
    expect(ast.blocks[0]?.heading).toBe("Heading");
  });

  it("handles CRLF line endings", () => {
    const raw = "## Heading\r\n\r\n- item\r\n";
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.heading).toBe("Heading");
    expect(ast.blocks[0]?.items[0]?.text).toBe("item");
  });
});
