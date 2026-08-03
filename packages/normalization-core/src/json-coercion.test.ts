import { describe, expect, it } from "vitest";
import { safeParseJson } from "./json-coercion.js";

describe("json-coercion", () => {
  it.each<[string, unknown]>([
    ['{"ok":true}', { ok: true }],
    ["[1]", [1]],
    ['"text"', "text"],
    ["null", null],
    ["{", undefined],
  ])("parses %s", (value, expected) => expect(safeParseJson(value)).toEqual(expected));
});
