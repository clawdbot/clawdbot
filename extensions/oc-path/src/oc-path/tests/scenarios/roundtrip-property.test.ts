import { describe, expect, it } from "vitest";
import { emitMd } from "../../emit.js";
import { parseMd } from "../../parse.js";

function roundTrip(raw: string): string {
  return emitMd(parseMd(raw).ast);
}

describe("roundtrip-property", () => {
  it("byte-fidelity over 100 generated shapes", () => {
    const inputs = generateCorpus(100);
    for (const raw of inputs) {
      try {
        expect(roundTrip(raw)).toBe(raw);
      } catch (e) {
        // Surface which input failed for debugging.
        throw new Error(
          `round-trip failed for input (length ${raw.length}):\n${JSON.stringify(raw.slice(0, 200))}\nError: ${(e as Error).message}`,
          { cause: e },
        );
      }
    }
  });

  it("parser idempotence (parse → emit → parse → identical AST shape)", () => {
    const inputs = generateCorpus(50);
    for (const raw of inputs) {
      const a = parseMd(raw).ast;
      const a2 = parseMd(emitMd(a)).ast;
      // Compare structural fields; raw will of course be identical.
      expect(a2.frontmatter).toEqual(a.frontmatter);
      expect(a2.preamble).toEqual(a.preamble);
      expect(a2.blocks.map(stripDerived)).toEqual(a.blocks.map(stripDerived));
    }
  });

  it("stable output for identical input", () => {
    const raw = `---\nname: x\n---\n\n## A\n- a\n## B\n- b: c\n`;
    const out1 = roundTrip(raw);
    const out2 = roundTrip(raw);
    const out3 = roundTrip(raw);
    expect(out1).toBe(out2);
    expect(out2).toBe(out3);
  });

  it("ordering deterministic (no Object.keys / Set ordering surprises)", () => {
    const raw = `---\nb: 2\na: 1\nc: 3\n---\n## Z\n- z\n## A\n- a\n`;
    const a1 = parseMd(raw).ast;
    const a2 = parseMd(raw).ast;
    expect(a1.frontmatter.map((e) => e.key)).toEqual(a2.frontmatter.map((e) => e.key));
    expect(a1.blocks.map((b) => b.heading)).toEqual(a2.blocks.map((b) => b.heading));
  });

  it("round-trip preserves comment-like lines (no comment recognition at substrate)", () => {
    const raw = `## H\n\n<!-- a comment -->\n- bullet\n`;
    expect(roundTrip(raw)).toBe(raw);
  });

  it("round-trip preserves indented blocks (substrate doesn't reflow)", () => {
    const raw = `## H\n\n    indented code-ish block\n      more indented\n`;
    expect(roundTrip(raw)).toBe(raw);
  });

  it("round-trip preserves blockquotes", () => {
    const raw = `## H\n\n> quoted line 1\n> quoted line 2\n`;
    expect(roundTrip(raw)).toBe(raw);
  });

  it("round-trip preserves images / links", () => {
    const raw = `## H\n\n![alt](path/to/img.png)\n[link](http://example.com)\n`;
    expect(roundTrip(raw)).toBe(raw);
  });

  it("round-trip preserves HTML", () => {
    const raw = `## H\n\n<details><summary>x</summary>body</details>\n`;
    expect(roundTrip(raw)).toBe(raw);
  });

  it("round-trip preserves consecutive headings with no body between", () => {
    const raw = `## A\n## B\n## C\n`;
    expect(roundTrip(raw)).toBe(raw);
  });
});


function generateCorpus(count: number): string[] {
  const corpus: string[] = [];
  // Deterministic seed so flaky failures don't surface differently each run.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
  const choose = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];

  const headings = ["Boundaries", "Tools", "Memory", "Identity", "User", "Heartbeat", "Skills"];
  const fmKeys = ["name", "description", "tier", "enabled", "timeout", "url"];
  const fmValues = ["github", "gh CLI", "T1", "true", "15000", "https://example.com"];
  const itemTexts = ["never write to /etc", "always confirm", "gh: GitHub CLI", "curl: HTTP"];
  const eols = ["\n", "\r\n"];

  for (let i = 0; i < count; i++) {
    const eol = choose(eols);
    const parts: string[] = [];

    if (rand() < 0.5) {
      parts.push("---");
      const fmCount = Math.floor(rand() * 4);
      for (let k = 0; k < fmCount; k++) {
        parts.push(`${choose(fmKeys)}: ${choose(fmValues)}`);
      }
      parts.push("---");
      parts.push("");
    }

    if (rand() < 0.3) {
      parts.push("Some preamble.");
      parts.push("");
    }

    const blockCount = Math.floor(rand() * 3) + 1;
    for (let b = 0; b < blockCount; b++) {
      parts.push(`## ${choose(headings)}`);
      parts.push("");
      const itemCount = Math.floor(rand() * 4);
      for (let it = 0; it < itemCount; it++) {
        parts.push(`- ${choose(itemTexts)}`);
      }
      if (rand() < 0.2) {
        parts.push("```");
        parts.push("code");
        parts.push("```");
      }
      parts.push("");
    }

    corpus.push(parts.join(eol));
  }
  return corpus;
}

function stripDerived(b: { heading: string; slug: string; bodyText: string }): {
  heading: string;
  slug: string;
} {
  return { heading: b.heading, slug: b.slug };
}
