import { describe, expect, it } from "vitest";
import { normalizeNpmPackJson } from "../../scripts/lib/npm-pack-json-compat.mjs";

describe("npm pack JSON compatibility", () => {
  it("preserves npm 11 array output", () => {
    expect(normalizeNpmPackJson('[{"filename":"demo.tgz"}]')).toEqual([{ filename: "demo.tgz" }]);
  });

  it("normalizes npm 12 keyed output", () => {
    expect(normalizeNpmPackJson('{"@openclaw/demo":{"filename":"openclaw-demo.tgz"}}')).toEqual([
      { filename: "openclaw-demo.tgz" },
    ]);
  });

  it("rejects non-object output", () => {
    expect(() => normalizeNpmPackJson('"demo.tgz"')).toThrow(
      "npm pack JSON must be an array or keyed object",
    );
  });
});
