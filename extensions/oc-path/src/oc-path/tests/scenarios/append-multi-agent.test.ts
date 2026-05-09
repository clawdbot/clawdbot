import { describe, expect, it } from "vitest";
import type { JsoncValue } from "../../jsonc/ast.js";
import { appendJsonlOcPath } from "../../jsonl/edit.js";
import { emitJsonl } from "../../jsonl/emit.js";
import { parseJsonl } from "../../jsonl/parse.js";

function event(name: string, n: number): JsoncValue {
  return {
    kind: "object",
    entries: [
      { key: "event", line: 0, value: { kind: "string", value: name } },
      { key: "n", line: 0, value: { kind: "number", value: n } },
    ],
  };
}

describe("jsonl append + multi-agent session sim", () => {
  it("single agent appends 100 events in order", () => {
    let ast = parseJsonl("").ast;
    for (let i = 0; i < 100; i++) {
      ast = appendJsonlOcPath(ast, event("step", i));
    }
    const lines = emitJsonl(ast)
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(100);
    expect(JSON.parse(lines[0] ?? "")).toEqual({ event: "step", n: 0 });
    expect(JSON.parse(lines[99] ?? "")).toEqual({ event: "step", n: 99 });
  });

  it("two agents alternating appends preserve interleave order", () => {
    let ast = parseJsonl("").ast;
    for (let i = 0; i < 10; i++) {
      const agent = i % 2 === 0 ? "a" : "b";
      ast = appendJsonlOcPath(ast, event(agent, i));
    }
    const lines = emitJsonl(ast)
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      const expected = i % 2 === 0 ? "a" : "b";
      expect(JSON.parse(lines[i] ?? "").event).toBe(expected);
    }
  });

  it("append after a malformed line preserves both", () => {
    let ast = parseJsonl('{"a":1}\nbroken\n').ast;
    ast = appendJsonlOcPath(ast, event("start", 1));
    const out = emitJsonl(ast);
    expect(out).toContain("broken");
    expect(out).toContain('"event":"start"');
  });

  it("append to empty file produces a single value line", () => {
    let ast = parseJsonl("").ast;
    ast = appendJsonlOcPath(ast, event("first", 0));
    const out = emitJsonl(ast);
    expect(JSON.parse(out)).toEqual({ event: "first", n: 0 });
  });

  it("append assigns line numbers monotonically", () => {
    let ast = parseJsonl("").ast;
    ast = appendJsonlOcPath(ast, event("a", 0));
    ast = appendJsonlOcPath(ast, event("b", 1));
    ast = appendJsonlOcPath(ast, event("c", 2));
    expect(ast.lines.map((l) => l.line)).toEqual([1, 2, 3]);
  });

  it("append after blank lines preserves line-number gaps correctly", () => {
    let ast = parseJsonl('{"a":1}\n\n\n').ast;
    ast = appendJsonlOcPath(ast, event("after", 0));
    // Existing lines: L1 value, L2 blank, L3 blank. Appended line is L4.
    expect(ast.lines.length).toBe(4);
    expect(ast.lines[3]?.line).toBe(4);
  });

  it("1000-event session sim is deterministic", () => {
    let ast = parseJsonl("").ast;
    for (let i = 0; i < 1000; i++) {
      ast = appendJsonlOcPath(ast, event("e", i));
    }
    const lines = emitJsonl(ast)
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1000);
    expect(JSON.parse(lines[999] ?? "").n).toBe(999);
  });

  it("append is non-mutating on the input AST", () => {
    const ast = parseJsonl('{"a":1}\n').ast;
    const before = JSON.stringify(ast);
    appendJsonlOcPath(ast, event("x", 0));
    expect(JSON.stringify(ast)).toBe(before);
  });

  it("append preserves prior raw bytes (renders new tail)", () => {
    let ast = parseJsonl('{"a":1}\n').ast;
    ast = appendJsonlOcPath(ast, event("b", 1));
    const out = emitJsonl(ast);
    const lines = out.split("\n");
    // First line content unchanged.
    expect(lines[0]).toContain('"a":1');
    // Second line is the new event.
    expect(JSON.parse(lines[1] ?? "")).toEqual({ event: "b", n: 1 });
  });

  it("deterministic line-number assignment after malformed lines", () => {
    let ast = parseJsonl('{"a":1}\nbroken\n{"b":2}\n').ast;
    ast = appendJsonlOcPath(ast, event("c", 2));
    expect(ast.lines.map((l) => l.line)).toEqual([1, 2, 3, 4]);
  });
});
