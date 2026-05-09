import { describe, expect, it } from "vitest";
import { MAX_JSONC_INPUT_BYTES, parseJsonc } from "../../jsonc/parse.js";

describe("parseJsonc — basic shapes", () => {
  it("parses an empty object", () => {
    const { ast, diagnostics } = parseJsonc("{}");
    expect(diagnostics).toEqual([]);
    expect(ast.kind).toBe("jsonc");
    expect(ast.root).toEqual({ kind: "object", entries: [], line: 1 });
  });

  it("parses an empty array", () => {
    const { ast, diagnostics } = parseJsonc("[]");
    expect(diagnostics).toEqual([]);
    expect(ast.root).toEqual({ kind: "array", items: [], line: 1 });
  });

  it("parses an empty input as null root", () => {
    const { ast, diagnostics } = parseJsonc("");
    expect(diagnostics).toEqual([]);
    expect(ast.root).toBeNull();
  });

  it("parses scalars", () => {
    expect(parseJsonc("42").ast.root).toEqual({ kind: "number", value: 42, line: 1 });
    expect(parseJsonc("-3.14").ast.root).toEqual({ kind: "number", value: -3.14, line: 1 });
    expect(parseJsonc("1e3").ast.root).toEqual({ kind: "number", value: 1000, line: 1 });
    expect(parseJsonc('"hello"').ast.root).toEqual({ kind: "string", value: "hello", line: 1 });
    expect(parseJsonc("true").ast.root).toEqual({ kind: "boolean", value: true, line: 1 });
    expect(parseJsonc("false").ast.root).toEqual({ kind: "boolean", value: false, line: 1 });
    expect(parseJsonc("null").ast.root).toEqual({ kind: "null", line: 1 });
  });

  it("parses nested object/array", () => {
    const raw = '{ "plugins": { "entries": ["a", "b"] } }';
    const { ast, diagnostics } = parseJsonc(raw);
    expect(diagnostics).toEqual([]);
    expect(ast.root).toEqual({
      kind: "object",
      line: 1,
      entries: [
        {
          key: "plugins",
          line: 1,
          value: {
            kind: "object",
            line: 1,
            entries: [
              {
                key: "entries",
                line: 1,
                value: {
                  kind: "array",
                  line: 1,
                  items: [
                    { kind: "string", value: "a", line: 1 },
                    { kind: "string", value: "b", line: 1 },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
  });

  it("preserves raw on the AST root for byte-fidelity emit", () => {
    const raw = '{\n  "x": 1\n}\n';
    const { ast } = parseJsonc(raw);
    expect(ast.raw).toBe(raw);
  });
});

describe("parseJsonc — JSONC extensions", () => {
  it("skips line comments", () => {
    const raw = `{
      // comment
      "x": 1 // trailing comment
    }`;
    const { ast, diagnostics } = parseJsonc(raw);
    expect(diagnostics).toEqual([]);
    expect(ast.root).toEqual({
      kind: "object",
      line: 1,
      entries: [{ key: "x", value: { kind: "number", value: 1, line: 3 }, line: 3 }],
    });
  });

  it("skips block comments", () => {
    const raw = '{ /* hi */ "x": /* mid */ 1 }';
    const { ast, diagnostics } = parseJsonc(raw);
    expect(diagnostics).toEqual([]);
    expect(ast.root).toEqual({
      kind: "object",
      line: 1,
      entries: [{ key: "x", value: { kind: "number", value: 1, line: 1 }, line: 1 }],
    });
  });

  it("tolerates trailing commas in objects", () => {
    const { ast, diagnostics } = parseJsonc('{ "x": 1, }');
    expect(diagnostics).toEqual([]);
    expect(ast.root).toEqual({
      kind: "object",
      line: 1,
      entries: [{ key: "x", value: { kind: "number", value: 1, line: 1 }, line: 1 }],
    });
  });

  it("tolerates trailing commas in arrays", () => {
    const { ast } = parseJsonc("[1, 2, 3,]");
    expect(ast.root).toEqual({
      kind: "array",
      line: 1,
      items: [
        { kind: "number", value: 1, line: 1 },
        { kind: "number", value: 2, line: 1 },
        { kind: "number", value: 3, line: 1 },
      ],
    });
  });

  it("handles escape sequences in strings", () => {
    const { ast } = parseJsonc('"a\\nb\\tc\\u0041"');
    expect(ast.root).toEqual({ kind: "string", value: "a\nb\tcA", line: 1 });
  });
});

describe("parseJsonc — soft errors", () => {
  it("returns null root + error diagnostic on unrecoverable input", () => {
    const { ast, diagnostics } = parseJsonc('{ "x" 1 }');
    expect(ast.root).toBeNull();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe("error");
  });

  it("warns on trailing input after a valid value", () => {
    const { diagnostics } = parseJsonc("1 garbage");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe("warning");
    expect(diagnostics[0]?.code).toBe("OC_JSONC_TRAILING_INPUT");
  });

  it("rejects input larger than MAX_JSONC_INPUT_BYTES with a typed diagnostic", () => {
    // Construct an input one byte over the cap. We don't allocate the
    // full 16 MiB+ string in memory; `String#repeat` on a one-byte unit
    // is enough to push past the threshold without exercising the
    // expensive `parseTree` path (the cap fires before parse runs).
    const oversized = "a".repeat(MAX_JSONC_INPUT_BYTES + 1);
    const { ast, diagnostics } = parseJsonc(oversized);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe("error");
    expect(diagnostics[0]?.code).toBe("OC_JSONC_INPUT_TOO_LARGE");
    expect(ast.root).toBeNull();
  });

  it("accepts input up to the cap", () => {
    // Reasonable-shape JSON well within the cap parses normally.
    const { diagnostics, ast } = parseJsonc('{"key": "value"}');
    expect(diagnostics).toEqual([]);
    expect(ast.root?.kind).toBe("object");
  });
});
