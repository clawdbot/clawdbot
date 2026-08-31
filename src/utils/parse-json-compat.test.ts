// Parse JSON compat tests cover strict-then-JSON5 fallback parsing.
import JSON5 from "json5";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseJsonWithJson5Fallback } from "./parse-json-compat.js";

describe("parseJsonWithJson5Fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses strict JSON via JSON.parse without invoking JSON5", () => {
    const jsonParseSpy = vi.spyOn(JSON, "parse");
    const json5ParseSpy = vi.spyOn(JSON5, "parse");

    expect(parseJsonWithJson5Fallback('{"a":1}')).toEqual({ a: 1 });
    expect(jsonParseSpy).toHaveBeenCalled();
    expect(json5ParseSpy).not.toHaveBeenCalled();
  });

  it("falls back to JSON5 when JSON.parse throws", () => {
    const json5ParseSpy = vi.spyOn(JSON5, "parse");

    expect(parseJsonWithJson5Fallback('{"a":1,}')).toEqual({ a: 1 });
    expect(json5ParseSpy).toHaveBeenCalled();
  });

  it("handles trailing commas via JSON5 fallback", () => {
    expect(parseJsonWithJson5Fallback("[1,2,]")).toEqual([1, 2]);
  });

  it("handles JSON5 comments", () => {
    expect(parseJsonWithJson5Fallback('{\n  // c\n  "a": 1\n}')).toEqual({
      a: 1,
    });
  });

  it("handles JSON5 single-quoted strings", () => {
    expect(parseJsonWithJson5Fallback("{'a':1}")).toEqual({ a: 1 });
  });

  it("throws when both JSON and JSON5 parsing fail", () => {
    expect(() => parseJsonWithJson5Fallback("{invalid")).toThrow();
  });
});
