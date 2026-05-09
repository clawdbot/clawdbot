import { describe, expect, it } from "vitest";
import { parseMd } from "../../parse.js";
import { resolveMdOcPath as resolveOcPath } from "../../resolve.js";

const SAMPLE = `---
name: github
description: gh CLI
url: https://example.com
---

Preamble prose.

## Boundaries

- never write to /etc
- always confirm before deleting

## Tools

- gh: GitHub CLI
- curl: HTTP client
- The Tool: with caps and spaces

## Multi-Word Section

- item one
`;

describe("oc-path-resolver-edges", () => {
  const { ast } = parseMd(SAMPLE);

  it("root resolves to AST", () => {
    const m = resolveOcPath(ast, { file: "X.md" });
    expect(m?.kind).toBe("root");
  });

  it("block by exact slug", () => {
    const m = resolveOcPath(ast, { file: "X.md", section: "boundaries" });
    expect(m?.kind).toBe("block");
  });

  it("block by case-mismatched slug (Boundaries → boundaries)", () => {
    const m = resolveOcPath(ast, { file: "X.md", section: "Boundaries" });
    expect(m?.kind).toBe("block");
  });

  it("block by uppercased slug", () => {
    const m = resolveOcPath(ast, { file: "X.md", section: "BOUNDARIES" });
    expect(m?.kind).toBe("block");
  });

  it("multi-word section by slug", () => {
    const m = resolveOcPath(ast, { file: "X.md", section: "multi-word-section" });
    expect(m?.kind).toBe("block");
    if (m?.kind === "block") {
      expect(m.node.heading).toBe("Multi-Word Section");
    }
  });

  it("multi-word section by exact heading text (case-folded)", () => {
    const m = resolveOcPath(ast, { file: "X.md", section: "Multi-Word Section" });
    // The OcPath section is matched case-insensitively against block.slug.
    // Block.slug for "Multi-Word Section" is "multi-word-section", and
    // path.section.toLowerCase() = "multi-word section" which does NOT
    // match "multi-word-section". Documented limit — callers must
    // pass slug form, not heading text. This is intentional.
    expect(m).toBeNull();
  });

  it("unknown section returns null", () => {
    const m = resolveOcPath(ast, { file: "X.md", section: "unknown" });
    expect(m).toBeNull();
  });

  it("item by slug under known section", () => {
    const m = resolveOcPath(ast, {
      file: "X.md",
      section: "tools",
      item: "gh",
    });
    expect(m?.kind).toBe("item");
  });

  it('R-09 item slug for KV uses kv.key (gh, not "gh-github-cli")', () => {
    const m = resolveOcPath(ast, {
      file: "X.md",
      section: "tools",
      item: "gh",
    });
    expect(m).not.toBeNull();
    if (m?.kind === "item") {
      expect(m.node.kv?.value).toBe("GitHub CLI");
    }
  });

  it("item slug for plain bullet uses text", () => {
    const m = resolveOcPath(ast, {
      file: "X.md",
      section: "boundaries",
      item: "never-write-to-etc",
    });
    expect(m?.kind).toBe("item");
  });

  it("item slug case-insensitive", () => {
    const m = resolveOcPath(ast, {
      file: "X.md",
      section: "tools",
      item: "GH",
    });
    expect(m?.kind).toBe("item");
  });

  it("item with spaces in key (slugified)", () => {
    const m = resolveOcPath(ast, {
      file: "X.md",
      section: "tools",
      item: "the-tool",
    });
    expect(m?.kind).toBe("item");
    if (m?.kind === "item") {
      expect(m.node.kv?.value).toBe("with caps and spaces");
    }
  });

  it("unknown item returns null", () => {
    const m = resolveOcPath(ast, {
      file: "X.md",
      section: "tools",
      item: "nonexistent",
    });
    expect(m).toBeNull();
  });

  it("item-field matches kv.key (case-insensitive)", () => {
    const m = resolveOcPath(ast, {
      file: "X.md",
      section: "tools",
      item: "gh",
      field: "gh",
    });
    expect(m?.kind).toBe("item-field");
  });

  it("field on plain (non-kv) item returns null", () => {
    const m = resolveOcPath(ast, {
      file: "X.md",
      section: "boundaries",
      item: "never-write-to-etc",
      field: "risk",
    });
    expect(m).toBeNull();
  });

  it("field that does not match kv.key returns null", () => {
    const m = resolveOcPath(ast, {
      file: "X.md",
      section: "tools",
      item: "gh",
      field: "nonexistent",
    });
    expect(m).toBeNull();
  });

  it("frontmatter via [frontmatter] sentinel section", () => {
    const m = resolveOcPath(ast, {
      file: "X.md",
      section: "[frontmatter]",
      field: "name",
    });
    expect(m?.kind).toBe("frontmatter");
    if (m?.kind === "frontmatter") {
      expect(m.node.value).toBe("github");
    }
  });

  it("frontmatter unknown key returns null", () => {
    const m = resolveOcPath(ast, {
      file: "X.md",
      section: "[frontmatter]",
      field: "nonexistent",
    });
    expect(m).toBeNull();
  });

  it("frontmatter without field returns null", () => {
    const m = resolveOcPath(ast, {
      file: "X.md",
      section: "[frontmatter]",
    });
    expect(m).toBeNull();
  });

  it("multiple frontmatter keys with same name — first match wins", () => {
    // Build an AST manually to test
    const dupeAst = {
      kind: "md" as const,
      raw: "",
      frontmatter: [
        { key: "k", value: "first", line: 2 },
        { key: "k", value: "second", line: 3 },
      ],
      preamble: "",
      blocks: [],
    };
    const m = resolveOcPath(dupeAst, {
      file: "X.md",
      section: "[frontmatter]",
      field: "k",
    });
    expect(m?.kind).toBe("frontmatter");
    if (m?.kind === "frontmatter") {
      expect(m.node.value).toBe("first");
    }
  });

  it("empty AST resolves root only", () => {
    const empty = { kind: "md" as const, raw: "", frontmatter: [], preamble: "", blocks: [] };
    expect(resolveOcPath(empty, { file: "X.md" })?.kind).toBe("root");
    expect(resolveOcPath(empty, { file: "X.md", section: "any" })).toBeNull();
  });

  it("resolver does not mutate the AST", () => {
    const before = JSON.stringify(ast);
    resolveOcPath(ast, { file: "X.md", section: "tools", item: "gh", field: "gh" });
    const after = JSON.stringify(ast);
    expect(after).toBe(before);
  });

  it("file segment is informational — resolver doesn't check it", () => {
    // The file name in OcPath is metadata; resolver assumes the AST
    // matches. Callers verify file mapping before passing the AST.
    const m1 = resolveOcPath(ast, { file: "SOUL.md", section: "tools" });
    const m2 = resolveOcPath(ast, { file: "AGENTS.md", section: "tools" });
    expect(m1?.kind).toBe(m2?.kind);
  });
});
