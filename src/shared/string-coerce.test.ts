import { describe, expect, it } from "vitest";
import { normalizeStringifiedEntries } from "./string-coerce.js";

describe("shared/string-coerce", () => {
  it("normalizes primitive stringified entries", () => {
    expect(normalizeStringifiedEntries([" a ", 42, true, 0n, "", "  ", null, {}])).toEqual([
      "a",
      "42",
      "true",
      "0",
    ]);
    expect(normalizeStringifiedEntries(undefined)).toEqual([]);
  });
});
