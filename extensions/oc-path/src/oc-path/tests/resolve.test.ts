import { describe, expect, it } from "vitest";
import { parseMd } from "../parse.js";
import { resolveMdOcPath as resolveOcPath } from "../resolve.js";

const SAMPLE = `---
name: github
description: gh CLI
---

Preamble.

## Boundaries

- never write to /etc
- deny: secrets

## Tools

- gh: GitHub CLI
- curl: HTTP client
`;

describe("resolveOcPath", () => {
  const { ast } = parseMd(SAMPLE);

  it("resolves root", () => {
    const m = resolveOcPath(ast, { file: "AGENTS.md" });
    expect(m?.kind).toBe("root");
  });

  it("resolves block by slug", () => {
    const m = resolveOcPath(ast, { file: "AGENTS.md", section: "boundaries" });
    expect(m?.kind).toBe("block");
    if (m?.kind === "block") {
      expect(m.node.heading).toBe("Boundaries");
    }
  });

  it("resolves item by slug", () => {
    const m = resolveOcPath(ast, {
      file: "AGENTS.md",
      section: "tools",
      item: "gh",
    });
    expect(m?.kind).toBe("item");
    if (m?.kind === "item") {
      expect(m.node.kv?.value).toBe("GitHub CLI");
      expect(m.block.heading).toBe("Tools");
    }
  });

  it("resolves item-field via kv", () => {
    const m = resolveOcPath(ast, {
      file: "AGENTS.md",
      section: "tools",
      item: "gh",
      field: "gh",
    });
    expect(m?.kind).toBe("item-field");
    if (m?.kind === "item-field") {
      expect(m.value).toBe("GitHub CLI");
    }
  });

  it("resolves frontmatter via [frontmatter] sentinel section", () => {
    const m = resolveOcPath(ast, {
      file: "AGENTS.md",
      section: "[frontmatter]",
      field: "name",
    });
    expect(m?.kind).toBe("frontmatter");
    if (m?.kind === "frontmatter") {
      expect(m.node.value).toBe("github");
    }
  });

  it("returns null for unknown section", () => {
    const m = resolveOcPath(ast, { file: "AGENTS.md", section: "nonexistent" });
    expect(m).toBeNull();
  });

  it("returns null for unknown item", () => {
    const m = resolveOcPath(ast, {
      file: "AGENTS.md",
      section: "tools",
      item: "nonexistent",
    });
    expect(m).toBeNull();
  });

  it("returns null for field on non-kv item", () => {
    const m = resolveOcPath(ast, {
      file: "AGENTS.md",
      section: "boundaries",
      item: "never-write-to-etc",
      field: "risk",
    });
    expect(m).toBeNull();
  });
});
