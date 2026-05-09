import { describe, expect, it } from "vitest";
import { emitMd } from "../../emit.js";
import { formatOcPath, parseOcPath } from "../../oc-path.js";
import { parseMd } from "../../parse.js";
import { resolveMdOcPath as resolveOcPath } from "../../resolve.js";

const SAMPLE = `---
name: github
description: gh CLI
---

Preamble.

## Boundaries

- never write to /etc
- always confirm

## Tools

- gh: GitHub CLI
- curl: HTTP client
`;

describe("cross-cutting", () => {
  it("parse → resolve → emit pipeline (block)", () => {
    const { ast } = parseMd(SAMPLE);
    const m = resolveOcPath(ast, { file: "AGENTS.md", section: "boundaries" });
    expect(m?.kind).toBe("block");
    expect(emitMd(ast)).toBe(SAMPLE);
  });

  it("OcPath round-trip via AST: parse + resolve + format", () => {
    const { ast } = parseMd(SAMPLE);
    for (const block of ast.blocks) {
      const path = parseOcPath(`oc://AGENTS.md/${block.slug}`);
      const m = resolveOcPath(ast, path);
      expect(m?.kind, `block ${block.slug} should resolve`).toBe("block");
      // Format the same path back; slug → URI shape should be stable.
      expect(formatOcPath(path)).toBe(`oc://AGENTS.md/${block.slug}`);
    }
  });

  it("every item in every block is OcPath-addressable", () => {
    const { ast } = parseMd(SAMPLE);
    for (const block of ast.blocks) {
      for (const item of block.items) {
        const path = parseOcPath(`oc://AGENTS.md/${block.slug}/${item.slug}`);
        const m = resolveOcPath(ast, path);
        expect(m?.kind, `${block.slug}/${item.slug} should resolve`).toBe("item");
      }
    }
  });

  it("every kv item field is OcPath-addressable", () => {
    const { ast } = parseMd(SAMPLE);
    for (const block of ast.blocks) {
      for (const item of block.items) {
        if (!item.kv) {
          continue;
        }
        const path = parseOcPath(`oc://AGENTS.md/${block.slug}/${item.slug}/${item.kv.key}`);
        const m = resolveOcPath(ast, path);
        expect(m?.kind).toBe("item-field");
      }
    }
  });

  it("every frontmatter entry is OcPath-addressable", () => {
    const { ast } = parseMd(SAMPLE);
    for (const fm of ast.frontmatter) {
      const path = parseOcPath(`oc://AGENTS.md/[frontmatter]/${fm.key}`);
      const m = resolveOcPath(ast, path);
      expect(m?.kind).toBe("frontmatter");
    }
  });

  it("slugs are stable across re-parses (deterministic)", () => {
    const a1 = parseMd(SAMPLE).ast;
    const a2 = parseMd(SAMPLE).ast;
    expect(a1.blocks.map((b) => b.slug)).toEqual(a2.blocks.map((b) => b.slug));
    expect(a1.blocks.map((b) => b.items.map((i) => i.slug))).toEqual(
      a2.blocks.map((b) => b.items.map((i) => i.slug)),
    );
  });

  it("modifying raw + re-parse produces consistent AST shape", () => {
    const a1 = parseMd(SAMPLE).ast;
    const modified = SAMPLE.replace("GitHub CLI", "GitHub command-line interface");
    const a2 = parseMd(modified).ast;
    // Block + item count + slugs unchanged.
    expect(a2.blocks.length).toBe(a1.blocks.length);
    const a1Tools = a1.blocks.find((b) => b.slug === "tools");
    const a2Tools = a2.blocks.find((b) => b.slug === "tools");
    expect(a2Tools?.items.length).toBe(a1Tools?.items.length);
    // KV value reflects the change.
    const ghItem = a2Tools?.items.find((i) => i.kv?.key === "gh");
    expect(ghItem?.kv?.value).toBe("GitHub command-line interface");
  });

  it("unknown OcPath returns null without affecting subsequent valid resolves", () => {
    const { ast } = parseMd(SAMPLE);
    expect(resolveOcPath(ast, { file: "X.md", section: "nonexistent" })).toBeNull();
    expect(resolveOcPath(ast, { file: "X.md", section: "tools" })?.kind).toBe("block");
  });

  it("resolve does not depend on file segment matching", () => {
    const { ast } = parseMd(SAMPLE);
    const a = resolveOcPath(ast, { file: "A.md", section: "tools" });
    const b = resolveOcPath(ast, { file: "B.md", section: "tools" });
    expect(a?.kind).toBe(b?.kind);
  });

  it("round-trip across all 9 valid OcPath shapes", () => {
    const { ast } = parseMd(SAMPLE);
    const cases = [
      { file: "X.md" },
      { file: "X.md", section: "tools" },
      { file: "X.md", section: "tools", item: "gh" },
      { file: "X.md", section: "tools", item: "gh", field: "gh" },
      { file: "X.md", section: "[frontmatter]", field: "name" },
      { file: "X.md", section: "boundaries" },
      { file: "X.md", section: "boundaries", item: "never-write-to-etc" },
      { file: "X.md", section: "boundaries", item: "always-confirm" },
      { file: "X.md", section: "[frontmatter]", field: "description" },
    ];
    for (const path of cases) {
      const m = resolveOcPath(ast, path);
      expect(m, `failed for ${JSON.stringify(path)}`).not.toBeNull();
    }
  });
});
