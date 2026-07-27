// Covers JSONL serialization behavior, including fail-fast on non-serializable
// root values that JSON.stringify would otherwise coerce to the literal string
// "undefined" (a silent transcript-data-loss path).
import { describe, expect, it } from "vitest";
import {
  serializeJsonlEntry,
  serializeJsonlLine,
  serializeJsonlLines,
} from "./transcript-jsonl.js";

describe("serializeJsonlLine", () => {
  it("throws TypeError when the root value is undefined", () => {
    expect(() => serializeJsonlLine(undefined)).toThrow(TypeError);
    expect(() => serializeJsonlLine(undefined)).toThrow(/not JSON-serializable/);
  });

  it("throws TypeError when the root value is a function", () => {
    expect(() => serializeJsonlLine(() => 42)).toThrow(TypeError);
  });

  it("throws TypeError when the root value is a symbol", () => {
    expect(() => serializeJsonlLine(Symbol("x"))).toThrow(TypeError);
  });

  it("serializes null as the JSON literal 'null'", () => {
    expect(serializeJsonlLine(null)).toBe("null");
  });

  it("serializes primitives as their JSON representation", () => {
    expect(serializeJsonlLine("hello")).toBe('"hello"');
    expect(serializeJsonlLine(42)).toBe("42");
    expect(serializeJsonlLine(true)).toBe("true");
  });

  it("serializes plain objects and arrays (regression guard)", () => {
    expect(serializeJsonlLine({ msg: "hello" })).toBe('{"msg":"hello"}');
    expect(serializeJsonlLine([1, 2, 3])).toBe("[1,2,3]");
  });
});

describe("serializeJsonlEntry", () => {
  it("appends a newline terminator for serializable values", () => {
    expect(serializeJsonlEntry({ msg: "ok" })).toBe('{"msg":"ok"}\n');
  });

  it("throws for a non-serializable root value (does not emit 'undefined\\n')", () => {
    // Regression guard: the literal string "undefined" must never reach the file.
    expect(() => serializeJsonlEntry(undefined)).toThrow(TypeError);
  });
});

describe("serializeJsonlLines", () => {
  it("joins serialized lines and terminates the batch with a newline", () => {
    expect(serializeJsonlLines(['{"a":1}', '{"b":2}'])).toBe('{"a":1}\n{"b":2}\n');
  });

  it("returns an empty string for an empty batch", () => {
    expect(serializeJsonlLines([])).toBe("");
  });
});
