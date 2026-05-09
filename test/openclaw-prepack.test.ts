import { describe, expect, it } from "vitest";
import { collectPreparedPrepackErrors } from "../scripts/openclaw-prepack.ts";

describe("collectPreparedPrepackErrors", () => {
  it("accepts prepared release artifacts", () => {
    expect(
      collectPreparedPrepackErrors(
        ["dist/index.mjs", "dist/control-ui/index.html"],
        ["dist/control-ui/assets/index-Bu8rSoJV.js"],
      ),
    ).toStrictEqual([]);
  });

  it("reports missing build and control ui artifacts", () => {
    expect(collectPreparedPrepackErrors([], [])).toEqual([
      "missing required prepared artifact: dist/index.js or dist/index.mjs",
      "missing required prepared artifact: dist/control-ui/index.html",
      "missing prepared Control UI asset payload under dist/control-ui/assets/",
    ]);
  });
});
