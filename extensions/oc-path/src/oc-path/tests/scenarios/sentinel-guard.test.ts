import { describe, expect, it } from "vitest";
import { emitMd } from "../../emit.js";
import { parseMd } from "../../parse.js";
import { OcEmitSentinelError, REDACTED_SENTINEL, guardSentinel } from "../../sentinel.js";

describe("sentinel-guard", () => {
  it("sentinel constant matches the literal", () => {
    expect(REDACTED_SENTINEL).toBe("__OPENCLAW_REDACTED__");
  });

  it("guardSentinel passes normal strings", () => {
    expect(() => guardSentinel("safe", "oc://X.md")).not.toThrow();
  });

  it("guardSentinel passes non-string types", () => {
    expect(() => guardSentinel(42, "oc://X.md")).not.toThrow();
    expect(() => guardSentinel(null, "oc://X.md")).not.toThrow();
    expect(() => guardSentinel(undefined, "oc://X.md")).not.toThrow();
    expect(() => guardSentinel({}, "oc://X.md")).not.toThrow();
  });

  it("guardSentinel throws on exact match", () => {
    expect(() => guardSentinel(REDACTED_SENTINEL, "oc://X.md")).toThrow(OcEmitSentinelError);
  });

  it("guardSentinel throws on substring matches (sentinel embedded in larger string)", () => {
    // Substring scan — the sentinel anywhere in the value is a leak,
    // not just exact equality. A hostile caller smuggling
    // `prefix__OPENCLAW_REDACTED__suffix` would have bypassed the old
    // equality check; substring scan closes the gap.
    expect(() => guardSentinel(`prefix${REDACTED_SENTINEL}suffix`, "oc://X.md")).toThrow(
      OcEmitSentinelError,
    );
  });

  it("error attaches the OcPath context", () => {
    try {
      guardSentinel(REDACTED_SENTINEL, "oc://config/plugins.entries.foo.token");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OcEmitSentinelError);
      const e = err as OcEmitSentinelError;
      expect(e.path).toBe("oc://config/plugins.entries.foo.token");
      expect(e.code).toBe("OC_EMIT_SENTINEL");
    }
  });

  it("round-trip echoes pre-existing sentinel; strict mode rejects", () => {
    const raw = "## Section\n\n- token: __OPENCLAW_REDACTED__\n";
    const { ast } = parseMd(raw);
    expect(emitMd(ast)).toBe(raw);
    expect(() => emitMd(ast, { acceptPreExistingSentinel: false })).toThrow(OcEmitSentinelError);
  });

  it("round-trip emit allows sentinel-free content", () => {
    const raw = "## Section\n\n- token: redacted-but-not-sentinel\n";
    const { ast } = parseMd(raw);
    expect(() => emitMd(ast)).not.toThrow();
  });

  it("render mode catches sentinel in frontmatter", () => {
    const ast = {
      kind: "md" as const,
      raw: "",
      frontmatter: [{ key: "token", value: REDACTED_SENTINEL, line: 2 }],
      preamble: "",
      blocks: [],
    };
    expect(() => emitMd(ast, { mode: "render" })).toThrow(OcEmitSentinelError);
  });

  it("render mode catches sentinel in preamble", () => {
    const ast = {
      kind: "md" as const,
      raw: "",
      frontmatter: [],
      preamble: REDACTED_SENTINEL,
      blocks: [],
    };
    expect(() => emitMd(ast, { mode: "render" })).toThrow(OcEmitSentinelError);
  });

  it("render mode catches sentinel in block bodyText", () => {
    const ast = {
      kind: "md" as const,
      raw: "",
      frontmatter: [],
      preamble: "",
      blocks: [
        {
          heading: "Sec",
          slug: "sec",
          line: 1,
          bodyText: REDACTED_SENTINEL,
          items: [],
          tables: [],
          codeBlocks: [],
        },
      ],
    };
    expect(() => emitMd(ast, { mode: "render" })).toThrow(OcEmitSentinelError);
  });

  it("render mode catches sentinel in item kv.value", () => {
    const ast = {
      kind: "md" as const,
      raw: "",
      frontmatter: [],
      preamble: "",
      blocks: [
        {
          heading: "S",
          slug: "s",
          line: 1,
          bodyText: "- t: x",
          items: [
            {
              text: "t: x",
              slug: "t",
              line: 2,
              kv: { key: "t", value: REDACTED_SENTINEL },
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

  it("sentinel-as-substring in raw — strict mode catches it", () => {
    const raw = `Some prose ${REDACTED_SENTINEL} more prose.\n`;
    const { ast } = parseMd(raw);
    expect(emitMd(ast)).toBe(raw);
    expect(() => emitMd(ast, { acceptPreExistingSentinel: false })).toThrow(OcEmitSentinelError);
  });

  it("multiple sentinel occurrences in raw — strict mode catches them", () => {
    const raw = `## A\n${REDACTED_SENTINEL}\n${REDACTED_SENTINEL}\n`;
    const { ast } = parseMd(raw);
    expect(emitMd(ast)).toBe(raw);
    expect(() => emitMd(ast, { acceptPreExistingSentinel: false })).toThrow(OcEmitSentinelError);
  });

  it("fileNameForGuard appears in the error path", () => {
    const ast = {
      kind: "md" as const,
      raw: "",
      frontmatter: [{ key: "token", value: REDACTED_SENTINEL, line: 2 }],
      preamble: "",
      blocks: [],
    };
    try {
      emitMd(ast, { mode: "render", fileNameForGuard: "config" });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as OcEmitSentinelError).path).toContain("config");
    }
  });
});
