// Run-main owns these modules eagerly, so lazy imports only add ineffective bundle edges.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./run-main.ts", import.meta.url), "utf8");

describe("run-main import boundary", () => {
  it("does not lazy-import its eager startup owners", () => {
    for (const specifier of ["../config/paths.js", "./command-startup-policy.js"]) {
      expect(source).toContain(`from "${specifier}"`);
      expect(source).not.toContain(`import("${specifier}")`);
    }
  });
});
