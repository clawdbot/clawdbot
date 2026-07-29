// Common tool helper tests cover shared parsing used by multiple agent tools.
import { describe, expect, test } from "vitest";
import { parseAvailableTags } from "./common.js";

describe("parseAvailableTags", () => {
  test("returns undefined for non-array inputs", () => {
    expect(parseAvailableTags(undefined)).toBeUndefined();
    expect(parseAvailableTags(null)).toBeUndefined();
    expect(parseAvailableTags("oops")).toBeUndefined();
  });

  test("drops entries without a string name and returns undefined when empty", () => {
    expect(parseAvailableTags([{ id: "1" }])).toBeUndefined();
    expect(parseAvailableTags([{ name: 123 }])).toBeUndefined();
  });

  test("keeps falsy ids and sanitizes emoji fields", () => {
    const result = parseAvailableTags([
      { id: "0", name: "General", emoji_id: null },
      { id: "1", name: "Docs", emoji_name: "📚" },
      { name: "Bad", emoji_id: 123 },
    ]);
    expect(result).toEqual([
      { id: "0", name: "General", emoji_id: null },
      { id: "1", name: "Docs", emoji_name: "📚" },
      { name: "Bad" },
    ]);
  });
});
