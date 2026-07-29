// Documents model tool-support compatibility defaults.
import { describe, expect, it } from "vitest";
import { supportsModelTools } from "./model-tool-support.js";

describe("supportsModelTools", () => {
  it("defaults to true when the model has no compat override", () => {
    expect(supportsModelTools({} as never)).toBe(true);
  });

  it("returns true when compat.supportsTools is true", () => {
    expect(supportsModelTools({ compat: { supportsTools: true } } as never)).toBe(true);
  });

  it("returns false when compat.supportsTools is false", () => {
    expect(supportsModelTools({ compat: { supportsTools: false } } as never)).toBe(false);
  });
});
