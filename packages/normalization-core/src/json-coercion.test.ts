import {
  safeParseJson as safeParseJsonFromRoot,
  safeParseJsonRecord as safeParseJsonRecordFromRoot,
} from "@openclaw/normalization-core";
import { safeParseJson, safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { describe, expect, it } from "vitest";

describe("json-coercion", () => {
  it("preserves the root exports alongside the focused package subpath", () => {
    expect(safeParseJsonFromRoot).toBe(safeParseJson);
    expect(safeParseJsonRecordFromRoot).toBe(safeParseJsonRecord);
  });

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
    {
      name: "JSON whitespace before an object",
      value: ' \t\r\n{"ok":true}',
      expected: { ok: true },
    },
    {
      name: "non-JSON whitespace before an object",
      value: '\u00a0{"ok":true}',
      expected: undefined,
    },
    { name: "a BOM before an object", value: '\ufeff{"ok":true}', expected: undefined },
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
