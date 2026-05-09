import { describe, expect, it } from "vitest";
import { emitMd } from "../../emit.js";
import { setJsoncOcPath } from "../../jsonc/edit.js";
import { emitJsonc } from "../../jsonc/emit.js";
import { parseJsonc } from "../../jsonc/parse.js";
import { emitJsonl } from "../../jsonl/emit.js";
import { parseJsonl } from "../../jsonl/parse.js";
import { parseOcPath } from "../../oc-path.js";
import { parseMd } from "../../parse.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../../sentinel.js";

describe("sentinel guard cross-kind", () => {
  it("jsonc round-trip echoes safely when raw contains pre-existing sentinel", () => {
    // Pre-existing sentinel bytes are trusted — see emit-policy comment
    // in jsonc/emit.ts. The strict mode below is the opt-in path for
    // callers who want LKG-style fingerprint verification.
    const raw = `{ "x": "${REDACTED_SENTINEL}" }`;
    const ast = parseJsonc(raw).ast;
    expect(emitJsonc(ast)).toBe(raw);
    // Strict mode still rejects pre-existing sentinel for callers who
    // explicitly opt in.
    expect(() => emitJsonc(ast, { acceptPreExistingSentinel: false })).toThrow(OcEmitSentinelError);
  });

  it("jsonl round-trip echoes safely; strict mode rejects", () => {
    const raw = `{"x":"${REDACTED_SENTINEL}"}\n`;
    const ast = parseJsonl(raw).ast;
    expect(emitJsonl(ast)).toBe(raw);
    expect(() => emitJsonl(ast, { acceptPreExistingSentinel: false })).toThrow(OcEmitSentinelError);
  });

  it("md round-trip echoes safely; strict mode rejects", () => {
    const raw = `## Body\n\n- ${REDACTED_SENTINEL}\n`;
    const ast = parseMd(raw).ast;
    expect(emitMd(ast)).toBe(raw);
    expect(() => emitMd(ast, { acceptPreExistingSentinel: false })).toThrow(OcEmitSentinelError);
  });

  it("jsonc render mode walks every leaf for sentinel", () => {
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

  it("jsonl render mode walks every value-line leaf", () => {
    const ast = parseJsonl('{"a":"ok"}\n').ast;
    const tampered = {
      ...ast,
      lines: [
        {
          kind: "value" as const,
          line: 1,
          raw: '{"a":"ok"}',
          value: {
            kind: "object" as const,
            entries: [
              {
                key: "a",
                line: 1,
                value: { kind: "string" as const, value: REDACTED_SENTINEL },
              },
            ],
          },
        },
      ],
    };
    expect(() => emitJsonl(tampered, { mode: "render" })).toThrow(OcEmitSentinelError);
  });

  it("setJsoncOcPath itself throws when the new value contains the sentinel", () => {
    // The substrate guard fires at write-time: setJsoncOcPath rebuilds
    // raw via render mode emit, which scans every leaf. Defense-in-depth
    // — even if a caller forgets to call emit afterward, the sentinel
    // can't make it into an in-memory AST that pretends to be valid.
    const ast = parseJsonc('{ "x": "ok" }').ast;
    expect(() =>
      setJsoncOcPath(ast, parseOcPath("oc://config/x"), {
        kind: "string",
        value: REDACTED_SENTINEL,
      }),
    ).toThrow(OcEmitSentinelError);
  });

  it("sentinel embedded in deep nesting — render mode catches the leaf", () => {
    // Round-trip echoes the pre-existing bytes (the workspace contract:
    // a parsed file containing the sentinel as data is not "writing" it
    // on emit). Render mode walks every leaf and rejects this caller-
    // injected pattern — and a `setOcPath` followed by emit lands here.
    const raw = JSON.stringify({ a: { b: { c: REDACTED_SENTINEL } } });
    const ast = parseJsonc(raw).ast;
    expect(emitJsonc(ast)).toBe(raw); // round-trip echo
    expect(() => emitJsonc(ast, { mode: "render" })).toThrow(OcEmitSentinelError);
  });

  it("sentinel inside an array element triggers guard in render mode", () => {
    const raw = JSON.stringify({ arr: ["ok", REDACTED_SENTINEL, "ok"] });
    const ast = parseJsonc(raw).ast;
    expect(() => emitJsonc(ast, { mode: "render" })).toThrow(OcEmitSentinelError);
  });

  it("sentinel as object key in raw — strict mode catches it", () => {
    const raw = `{ "${REDACTED_SENTINEL}": 1 }`;
    const ast = parseJsonc(raw).ast;
    expect(emitJsonc(ast)).toBe(raw); // default-mode echo
    expect(() => emitJsonc(ast, { acceptPreExistingSentinel: false })).toThrow(OcEmitSentinelError);
  });

  it("sentinel in jsonl malformed line — strict mode catches it", () => {
    const raw = `${REDACTED_SENTINEL}\n`;
    const ast = parseJsonl(raw).ast;
    expect(emitJsonl(ast)).toBe(raw); // round-trip echoes verbatim
    expect(() => emitJsonl(ast, { acceptPreExistingSentinel: false })).toThrow(OcEmitSentinelError);
  });

  it("partial sentinel substring does NOT trigger guard", () => {
    const raw = '{ "x": "OPENCLAW_REDACTED" }';
    const ast = parseJsonc(raw).ast;
    expect(() => emitJsonc(ast)).not.toThrow();
  });

  it("sentinel guard error message includes the OcPath context (render mode)", () => {
    // Render mode is the path that actually rejects caller-injected
    // sentinel — round-trip just echoes, so the error context surfaces
    // when render walks the offending leaf and constructs the path.
    const raw = `{ "secret": "${REDACTED_SENTINEL}" }`;
    const ast = parseJsonc(raw).ast;
    try {
      emitJsonc(ast, { mode: "render", fileNameForGuard: "config" });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(OcEmitSentinelError);
      expect(String(e)).toContain("oc://");
      expect(String(e)).toContain("config");
    }
  });
});
