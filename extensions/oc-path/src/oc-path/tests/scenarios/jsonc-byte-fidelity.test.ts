import { describe, expect, it } from "vitest";
import type { JsoncValue } from "../../jsonc/ast.js";
import { emitJsonc } from "../../jsonc/emit.js";
import { parseJsonc } from "../../jsonc/parse.js";

function rt(raw: string): string {
  return emitJsonc(parseJsonc(raw).ast);
}

/**
 * Verify the parser actually produced a structural tree (not just a
 * `null` root with echoed `raw`). Without this, a parser that
 * delegated everything to `raw` would pass the byte-fidelity test
 * trivially. Returns the parsed root for follow-up structural asserts.
 */
function assertParseable(raw: string): JsoncValue {
  const result = parseJsonc(raw);
  if (result.ast.root === null) {
    throw new Error("expected parseable JSONC root");
  }
  return result.ast.root;
}

/**
 * The complement: malformed input round-trips bytes verbatim AND
 * emits an error diagnostic. JC-17 needs this — without the
 * diagnostic check, the test would pass even if the parser silently
 * dropped malformed content.
 */
function assertNotParseable(raw: string): void {
  const result = parseJsonc(raw);
  expect(result.ast.root).toBeNull();
  expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
}

describe("jsonc byte-fidelity", () => {
  it("empty file", () => {
    expect(rt("")).toBe("");
  });

  it("whitespace-only", () => {
    expect(rt("   \n\n   \n")).toBe("   \n\n   \n");
  });

  it("empty object", () => {
    expect(rt("{}")).toBe("{}");
    const root = assertParseable("{}");
    expect(root.kind).toBe("object");
    if (root.kind === "object") {
      expect(root.entries).toHaveLength(0);
    }
  });

  it("empty array", () => {
    expect(rt("[]")).toBe("[]");
    const root = assertParseable("[]");
    expect(root.kind).toBe("array");
    if (root.kind === "array") {
      expect(root.items).toHaveLength(0);
    }
  });

  it("trivial scalar root", () => {
    expect(rt("42")).toBe("42");
    expect(rt('"x"')).toBe('"x"');
    expect(rt("true")).toBe("true");
    expect(rt("null")).toBe("null");
    expect(assertParseable("42").kind).toBe("number");
    expect(assertParseable('"x"').kind).toBe("string");
    expect(assertParseable("true").kind).toBe("boolean");
    expect(assertParseable("null").kind).toBe("null");
  });

  it("line comments preserved", () => {
    const raw = '// a leading comment\n{ "x": 1 } // trailing\n';
    expect(rt(raw)).toBe(raw);
    expect(assertParseable(raw).kind).toBe("object");
  });

  it("block comments preserved", () => {
    const raw = '/* header */\n{\n  /* inline */\n  "x": 1\n}\n';
    expect(rt(raw)).toBe(raw);
    const root = assertParseable(raw);
    expect(root.kind).toBe("object");
  });

  it("trailing commas preserved", () => {
    const raw = '{\n  "x": 1,\n  "y": 2,\n}';
    expect(rt(raw)).toBe(raw);
    const root = assertParseable(raw);
    if (root.kind === "object") {
      expect(root.entries).toHaveLength(2);
    }
  });

  it("mixed CRLF + LF preserved", () => {
    const raw = '{\r\n  "x": 1,\n  "y": 2\r\n}';
    expect(rt(raw)).toBe(raw);
    const root = assertParseable(raw);
    if (root.kind === "object") {
      expect(root.entries.map((e) => e.key)).toEqual(["x", "y"]);
    }
  });

  it("BOM preserved on raw, stripped for parse", () => {
    const raw = '﻿{ "x": 1 }';
    expect(rt(raw)).toBe(raw);
    expect(assertParseable(raw).kind).toBe("object");
  });

  it("deeply nested structures preserved", () => {
    const raw = '{ "a": { "b": { "c": { "d": [1, [2, [3, [4]]]] } } } }';
    expect(rt(raw)).toBe(raw);
    expect(assertParseable(raw).kind).toBe("object");
  });

  it("string with escape sequences preserved (parsed value has decoded chars)", () => {
    const raw = '{ "s": "a\\nb\\tc\\u0041\\\\d\\"e" }';
    expect(rt(raw)).toBe(raw);
    const root = assertParseable(raw);
    if (root.kind === "object") {
      const s = root.entries[0]?.value;
      if (s?.kind === "string") {
        expect(s.value).toBe('a\nb\tcA\\d"e');
      }
    }
  });

  it("numbers in scientific / negative / decimal forms preserved", () => {
    const raw = "[ 0, -0, 1.5, -3.14, 1e3, -2.5e-10, 1E+5 ]";
    expect(rt(raw)).toBe(raw);
    const root = assertParseable(raw);
    if (root.kind === "array") {
      expect(root.items).toHaveLength(7);
      expect(root.items.every((v) => v.kind === "number")).toBe(true);
    }
  });

  it("unicode characters preserved verbatim", () => {
    const raw = '{ "name": "héllo 世界 🎉" }';
    expect(rt(raw)).toBe(raw);
    const root = assertParseable(raw);
    if (root.kind === "object") {
      const v = root.entries[0]?.value;
      if (v?.kind === "string") {
        expect(v.value).toBe("héllo 世界 🎉");
      }
    }
  });

  it("idiosyncratic whitespace preserved", () => {
    const raw = '{    "x"   :     1    ,\n   "y":   2}';
    expect(rt(raw)).toBe(raw);
    expect(assertParseable(raw).kind).toBe("object");
  });

  it("file-level trailing whitespace preserved", () => {
    const raw = '{ "x": 1 }\n\n\n';
    expect(rt(raw)).toBe(raw);
    expect(assertParseable(raw).kind).toBe("object");
  });

  it("malformed input still emits raw verbatim AND emits a diagnostic", () => {
    const raw = '{ broken json with "key": value }';
    expect(rt(raw)).toBe(raw);
    assertNotParseable(raw);
  });

  it("comments-only file preserved", () => {
    const raw = "// just a comment\n/* and a block */\n";
    expect(rt(raw)).toBe(raw);
    expect(parseJsonc(raw).ast.root).toBeNull();
  });
});
