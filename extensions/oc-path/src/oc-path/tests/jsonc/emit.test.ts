import { describe, expect, it } from "vitest";
import { emitJsonc } from "../../jsonc/emit.js";
import { parseJsonc } from "../../jsonc/parse.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../../sentinel.js";

describe("emitJsonc — round-trip", () => {
  it("returns raw bytes verbatim by default", () => {
    const raw = `{
  // comment is preserved on round-trip
  "x": 1,
  "y": [/* inline */ 2, 3],
}
`;
    const { ast } = parseJsonc(raw);
    expect(emitJsonc(ast)).toBe(raw);
  });

  it("echoes pre-existing sentinel bytes by default; strict mode rejects", () => {
    // Round-trip trusts parsed bytes — workspace files legitimately
    // containing the sentinel (in code blocks, pasted error logs)
    // would otherwise become a workspace-wide emit DoS. Strict mode
    // is the opt-in path.
    const raw = `{ "x": "${REDACTED_SENTINEL}" }`;
    const { ast } = parseJsonc(raw);
    expect(emitJsonc(ast)).toBe(raw);
    expect(() =>
      emitJsonc(ast, { fileNameForGuard: "config", acceptPreExistingSentinel: false }),
    ).toThrow(OcEmitSentinelError);
  });
});

describe("emitJsonc — render mode", () => {
  it("re-stringifies the structural tree (no comments)", () => {
    const { ast } = parseJsonc('{ /* drop me */ "x": 1, "y": [2, 3] }');
    const out = emitJsonc(ast, { mode: "render" });
    expect(out).not.toContain("drop me");
    expect(JSON.parse(out)).toEqual({ x: 1, y: [2, 3] });
  });

  it("throws OcEmitSentinelError when a leaf string is the sentinel", () => {
    const ast = parseJsonc('{ "x": "ok" }').ast;
    const tampered = {
      ...ast,
      root: {
        kind: "object" as const,
        entries: [
          {
            key: "x",
            line: 1,
            value: { kind: "string" as const, value: REDACTED_SENTINEL },
          },
        ],
      },
    };
    expect(() => emitJsonc(tampered, { mode: "render" })).toThrow(OcEmitSentinelError);
  });

  it("throws when a leaf string EMBEDS the sentinel (prefix/suffix wrap)", () => {
    // Regression: prior to this fix, render mode used `value.value === SENTINEL`
    // (exact match), so `prefix__OPENCLAW_REDACTED__suffix` slipped through.
    // The roundtrip path always used `.includes()` for the same reason —
    // render must too. Catches the sentinel-guard bypass class.
    const ast = parseJsonc('{ "x": "ok" }').ast;
    const tampered = {
      ...ast,
      root: {
        kind: "object" as const,
        entries: [
          {
            key: "x",
            line: 1,
            value: {
              kind: "string" as const,
              value: `prefix-${REDACTED_SENTINEL}-suffix`,
            },
          },
        ],
      },
    };
    expect(() => emitJsonc(tampered, { mode: "render" })).toThrow(OcEmitSentinelError);
  });

  it("renders empty AST as empty string", () => {
    const { ast } = parseJsonc("");
    expect(emitJsonc(ast, { mode: "render" })).toBe("");
  });
});
