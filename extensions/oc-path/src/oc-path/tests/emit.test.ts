import { describe, expect, it } from "vitest";
import { emitMd } from "../emit.js";
import { parseMd } from "../parse.js";
import { OcEmitSentinelError } from "../sentinel.js";

describe("emit — round-trip mode (default)", () => {
  it("returns the raw bytes byte-for-byte", () => {
    const raw = `---\nname: x\n---\n\n## Sec\n\n- a\n- b\n`;
    const { ast } = parseMd(raw);
    expect(emitMd(ast)).toBe(raw);
  });

  it("round-trips CRLF line endings", () => {
    const raw = "## Heading\r\n\r\n- item\r\n";
    const { ast } = parseMd(raw);
    expect(emitMd(ast)).toBe(raw);
  });

  it("round-trips a file with no frontmatter and no sections", () => {
    const raw = "Just preamble. No structure.\n";
    const { ast } = parseMd(raw);
    expect(emitMd(ast)).toBe(raw);
  });

  it("echoes raw bytes containing the sentinel by default; strict mode rejects", () => {
    // Round-trip trusts parsed bytes — see emit.ts policy comment.
    // Strict mode (acceptPreExistingSentinel: false) is the opt-in
    // path for callers that want LKG-style fingerprint verification.
    const raw = "## Section\n\n- token: __OPENCLAW_REDACTED__\n";
    const { ast } = parseMd(raw);
    expect(emitMd(ast)).toBe(raw);
    expect(() => emitMd(ast, { acceptPreExistingSentinel: false })).toThrow(OcEmitSentinelError);
  });
});

describe("emit — render mode", () => {
  it("renders frontmatter + blocks", () => {
    const ast = {
      kind: "md" as const,
      raw: "",
      frontmatter: [
        { key: "name", value: "github", line: 2 },
        { key: "description", value: "gh CLI", line: 3 },
      ],
      preamble: "",
      blocks: [
        {
          heading: "Tools",
          slug: "tools",
          line: 5,
          bodyText: "- gh: GitHub",
          items: [{ text: "gh: GitHub", slug: "gh", line: 7, kv: { key: "gh", value: "GitHub" } }],
          tables: [],
          codeBlocks: [],
        },
      ],
    };
    const output = emitMd(ast, { mode: "render" });
    expect(output).toContain("name: github");
    expect(output).toContain("description: gh CLI");
    expect(output).toContain("## Tools");
    expect(output).toContain("- gh: GitHub");
  });

  it("quotes frontmatter values containing special chars", () => {
    const ast = {
      kind: "md" as const,
      raw: "",
      frontmatter: [{ key: "title", value: "a: b", line: 2 }],
      preamble: "",
      blocks: [],
    };
    const output = emitMd(ast, { mode: "render" });
    expect(output).toContain('title: "a: b"');
  });

  it("throws if a kv item value matches the sentinel", () => {
    const ast = {
      kind: "md" as const,
      raw: "",
      frontmatter: [],
      preamble: "",
      blocks: [
        {
          heading: "Secrets",
          slug: "secrets",
          line: 1,
          bodyText: "- token: __OPENCLAW_REDACTED__",
          items: [
            {
              text: "token: __OPENCLAW_REDACTED__",
              slug: "token",
              line: 2,
              kv: { key: "token", value: "__OPENCLAW_REDACTED__" },
            },
          ],
          tables: [],
          codeBlocks: [],
        },
      ],
    };
    expect(() => emitMd(ast, { mode: "render", fileNameForGuard: "AGENTS.md" })).toThrow(
      OcEmitSentinelError,
    );
  });
});
