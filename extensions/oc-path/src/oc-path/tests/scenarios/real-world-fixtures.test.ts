import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { emitMd } from "../../emit.js";
import { parseMd } from "../../parse.js";
import { resolveMdOcPath as resolveOcPath } from "../../resolve.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures", "real");

function load(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf-8");
}

describe("real-world-fixtures", () => {
  it("SOUL.md parses + round-trips", () => {
    const raw = load("SOUL.md");
    const { ast, diagnostics } = parseMd(raw);
    expect(diagnostics).toEqual([]);
    expect(emitMd(ast)).toBe(raw);
    // Has at least one H2 block.
    expect(ast.blocks.length).toBeGreaterThan(0);
  });

  it("AGENTS.md parses + resolves Tools section", () => {
    const raw = load("AGENTS.md");
    const { ast } = parseMd(raw);
    expect(emitMd(ast)).toBe(raw);
    const tools = resolveOcPath(ast, { file: "AGENTS.md", section: "tools" });
    expect(tools?.kind).toBe("block");
    if (tools?.kind === "block") {
      expect(tools.node.items.some((i) => i.kv?.key === "gh")).toBe(true);
    }
  });

  it("MEMORY.md frontmatter scope resolves via [frontmatter]", () => {
    const raw = load("MEMORY.md");
    const { ast } = parseMd(raw);
    expect(emitMd(ast)).toBe(raw);
    const scope = resolveOcPath(ast, {
      file: "MEMORY.md",
      section: "[frontmatter]",
      field: "scope",
    });
    expect(scope?.kind).toBe("frontmatter");
    if (scope?.kind === "frontmatter") {
      expect(scope.node.value).toBe("project");
    }
  });

  it("TOOLS.md tool-guidance section resolves by slug", () => {
    const raw = load("TOOLS.md");
    const { ast } = parseMd(raw);
    expect(emitMd(ast)).toBe(raw);
    const guidance = resolveOcPath(ast, {
      file: "TOOLS.md",
      section: "tool-guidance",
    });
    expect(guidance?.kind).toBe("block");
  });

  it("IDENTITY.md sections resolvable by slug", () => {
    const raw = load("IDENTITY.md");
    const { ast } = parseMd(raw);
    expect(emitMd(ast)).toBe(raw);
    const trust = resolveOcPath(ast, {
      file: "IDENTITY.md",
      section: "trust-level",
    });
    expect(trust?.kind).toBe("block");
  });

  it("USER.md Preferences items extracted", () => {
    const raw = load("USER.md");
    const { ast } = parseMd(raw);
    expect(emitMd(ast)).toBe(raw);
    const prefs = resolveOcPath(ast, {
      file: "USER.md",
      section: "preferences",
    });
    expect(prefs?.kind).toBe("block");
    if (prefs?.kind === "block") {
      expect(prefs.node.items.length).toBeGreaterThan(0);
    }
  });

  it("HEARTBEAT.md schedules — H2 sections as triggers", () => {
    const raw = load("HEARTBEAT.md");
    const { ast } = parseMd(raw);
    expect(emitMd(ast)).toBe(raw);
    expect(ast.blocks.length).toBeGreaterThanOrEqual(3);
    const slugs = ast.blocks.map((b) => b.slug);
    expect(slugs).toContain("every-30m-wake");
    expect(slugs).toContain("every-4h-wake");
  });

  it("SKILL.md frontmatter has name + description + tier", () => {
    const raw = load("SKILL.md");
    const { ast } = parseMd(raw);
    expect(emitMd(ast)).toBe(raw);
    const fmKeys = ast.frontmatter.map((e) => e.key);
    expect(fmKeys).toContain("name");
    expect(fmKeys).toContain("description");
    expect(fmKeys).toContain("tier");
  });

  it("BOOTSTRAP.md round-trips", () => {
    const raw = load("BOOTSTRAP.md");
    const { ast } = parseMd(raw);
    expect(emitMd(ast)).toBe(raw);
  });

  it("all 8 fixtures combined round-trip-clean (sanity)", () => {
    const names = [
      "SOUL.md",
      "AGENTS.md",
      "MEMORY.md",
      "TOOLS.md",
      "IDENTITY.md",
      "USER.md",
      "HEARTBEAT.md",
      "SKILL.md",
      "BOOTSTRAP.md",
    ];
    for (const name of names) {
      const raw = load(name);
      expect(emitMd(parseMd(raw).ast), `${name} failed round-trip`).toBe(raw);
    }
  });
});
