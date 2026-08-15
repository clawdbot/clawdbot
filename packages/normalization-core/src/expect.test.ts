import { describe, expect, it } from "vitest";
import { expectDefined, first, last } from "./expect.js";

describe("expect helpers", () => {
  it("returns defined values", () => {
    expect(expectDefined(0, "number")).toBe(0);
  });

  it.each([null, undefined])("rejects missing values", (value) => {
    expect(() => expectDefined(value, "test value")).toThrow("expected test value to be defined");
  });

  it("reads array boundaries without claiming they exist", () => {
    expect(first(["a", "b"])).toBe("a");
    expect(last(["a", "b"])).toBe("b");
    expect(first([])).toBeUndefined();
    expect(last([])).toBeUndefined();
  });
});
