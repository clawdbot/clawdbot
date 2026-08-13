// OC Path tests cover perf determinism plugin behavior.
import { describe, expect, it } from "vitest";
import { emitMd } from "../../emit.js";
import { parseMd } from "../../parse.js";
import { resolveMdOcPath as resolveOcPath } from "../../resolve.js";

const perfBudgetMultiplier = process.env.CI ? 4 : 1;
const perfSampleCount = 3;

function expectWithinPerfBudget(run: () => void, localBudgetMs: number) {
  // Loaded shared-vCPU CI can pause any single sample, so use the best of a few runs.
  // The minimum still catches consistently slow regressions without treating contention as one.
  let bestElapsedMs = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < perfSampleCount; sample++) {
    const start = performance.now();
    run();
    bestElapsedMs = Math.min(bestElapsedMs, performance.now() - start);
  }
  expect(bestElapsedMs).toBeLessThan(localBudgetMs * perfBudgetMultiplier);
}

describe("perf + determinism", () => {
  it("parses 100 KB file within the parser budget", () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push("## H" + i);
      for (let j = 0; j < 5; j++) {
        lines.push(`- key${i}-${j}: value with content`);
      }
    }
    const raw = lines.join("\n");
    expectWithinPerfBudget(() => parseMd(raw), 200);
  });

  it("parses 1000 small files in under 500 ms", () => {
    const raw = `## H\n- a\n- b: c\n## I\n- d\n`;
    expectWithinPerfBudget(() => {
      for (let i = 0; i < 1000; i++) {
        parseMd(raw);
      }
    }, 500);
  });

  it("100k OcPath resolutions on parsed AST in under 500 ms", () => {
    const raw = `## A\n- a1\n- a2\n## B\n- b1\n- b2\n## C\n- c1: cv\n`;
    const { ast } = parseMd(raw);
    const path = { file: "X.md", section: "b", item: "b1" };
    expectWithinPerfBudget(() => {
      for (let i = 0; i < 100_000; i++) {
        resolveOcPath(ast, path);
      }
    }, 500);
  });

  it("same input → byte-identical AST.raw across runs", () => {
    const raw = `---\nb: 2\na: 1\n---\n## Z\n- z\n## A\n- a\n`;
    const a1 = parseMd(raw).ast;
    const a2 = parseMd(raw).ast;
    expect(a1.raw).toBe(a2.raw);
    expect(a1.frontmatter).toEqual(a2.frontmatter);
    expect(a1.blocks).toEqual(a2.blocks);
  });

  it("resolveOcPath is non-mutating", () => {
    const raw = `## A\n- a: x\n## B\n- b\n`;
    const { ast } = parseMd(raw);
    const before = JSON.stringify(ast);
    resolveOcPath(ast, { file: "X.md", section: "a", item: "a", field: "a" });
    resolveOcPath(ast, { file: "X.md", section: "b" });
    resolveOcPath(ast, { file: "X.md", section: "unknown" });
    expect(JSON.stringify(ast)).toBe(before);
  });

  it("AST is JSON-serializable (no functions, no cycles)", () => {
    const raw = `---\nk: v\n---\n## A\n- a\n\`\`\`ts\nx\n\`\`\`\n| h |\n| - |\n| 1 |\n`;
    const { ast } = parseMd(raw);
    const serialized = JSON.stringify(ast);
    const parsed = JSON.parse(serialized);
    expect(parsed.raw).toBe(ast.raw);
    expect(parsed.blocks.length).toBe(ast.blocks.length);
  });

  it("emit is non-mutating", () => {
    const raw = `## A\n- a\n`;
    const { ast } = parseMd(raw);
    const before = JSON.stringify(ast);
    emitMd(ast);
    emitMd(ast);
    emitMd(ast);
    expect(JSON.stringify(ast)).toBe(before);
  });

  it("frontmatter ordering is preserved (insertion order, not alphabetical)", () => {
    const raw = `---\nz: 1\nm: 2\na: 3\n---\n`;
    const { ast } = parseMd(raw);
    expect(ast.frontmatter.map((e) => e.key)).toEqual(["z", "m", "a"]);
  });

  it("block ordering is document order, not alphabetical", () => {
    const raw = `## Z\n## A\n## M\n`;
    const { ast } = parseMd(raw);
    expect(ast.blocks.map((b) => b.heading)).toEqual(["Z", "A", "M"]);
  });

  it("item ordering within block is document order", () => {
    const raw = `## H\n- z\n- a\n- m\n`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.items.map((i) => i.text)).toEqual(["z", "a", "m"]);
  });

  it("large fixture round-trip stays under 100 ms", () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(`## Section ${i}`);
      lines.push("");
      for (let j = 0; j < 10; j++) {
        lines.push(`- item-${i}-${j}: with some prose value content here`);
      }
      lines.push("");
    }
    const raw = lines.join("\n");
    let out = "";
    expectWithinPerfBudget(() => {
      const { ast } = parseMd(raw);
      out = emitMd(ast);
    }, 100);
    expect(out).toBe(raw);
  });
});
