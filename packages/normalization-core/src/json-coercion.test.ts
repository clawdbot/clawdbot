import { describe, expect, it } from "vitest";
import { safeParseJson, safeParseJsonRecord } from "./json-coercion.js";

describe("json-coercion", () => {
  it.each<[string, unknown]>([
    ['{"ok":true}', { ok: true }],
    ["[1]", [1]],
    ['"text"', "text"],
    ["null", null],
    ["{", undefined],
  ])("parses %s", (value, expected) => expect(safeParseJson(value)).toEqual(expected));

  const ownProtoRecord = {} as Record<string, unknown>;
  Object.defineProperty(ownProtoRecord, "__proto__", {
    value: { safe: true },
    enumerable: true,
  });

  it.each([
    { name: "an object", value: '{"ok":true}', expected: { ok: true } },
    { name: "null", value: "null", expected: undefined },
    { name: "an array", value: "[1]", expected: undefined },
    { name: "a scalar", value: '"text"', expected: undefined },
    { name: "malformed JSON", value: "{", expected: undefined },
    {
      name: "an own __proto__ data key",
      value: '{"__proto__":{"safe":true}}',
      expected: ownProtoRecord,
    },
  ])("parses $name as an optional record", ({ value, expected }) => {
    const result = safeParseJsonRecord(value);

    expect(result).toEqual(expected);
    if (Object.hasOwn(expected ?? {}, "__proto__")) {
      expect(Object.hasOwn(result ?? {}, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    }
  });
});
