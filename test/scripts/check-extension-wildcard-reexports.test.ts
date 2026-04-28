import { describe, expect, it } from "vitest";
import { findLocalWildcardReexports } from "../../scripts/check-extension-wildcard-reexports.mjs";

describe("check-extension-wildcard-reexports", () => {
  it("flags local wildcard re-exports", () => {
    expect(
      findLocalWildcardReexports(
        [
          'export * from "./src/runtime-api.js";',
          'export type * from "../api.js";',
          'export { named } from "./src/runtime-api.js";',
        ].join("\n"),
      ),
    ).toEqual([
      { line: 1, text: 'export * from "./src/runtime-api.js";' },
      { line: 2, text: 'export type * from "../api.js";' },
    ]);
  });

  it("allows explicit local exports and external wildcard barrels", () => {
    expect(
      findLocalWildcardReexports(
        [
          'export { named } from "./src/runtime-api.js";',
          'export type { Named } from "../api.js";',
          'export * from "external-package";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
