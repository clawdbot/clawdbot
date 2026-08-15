// Qa Lab tests cover qa credentials common plugin behavior.
import { describe, expect, it } from "vitest";
import { parseQaCredentialPositiveIntegerEnv } from "./qa-credentials-common.runtime.js";

describe("qa credential common runtime", () => {
  it("parses positive integer env values strictly", () => {
    expect(
      parseQaCredentialPositiveIntegerEnv({
        env: { TEST_LIMIT: "42" },
        fallback: 10,
        key: "TEST_LIMIT",
      }),
    ).toBe(42);
    expect(
      parseQaCredentialPositiveIntegerEnv({
        env: {},
        fallback: 10,
        key: "TEST_LIMIT",
      }),
    ).toBe(10);

    for (const value of ["0x10", "1e3", "4.5"]) {
      expect(() =>
        parseQaCredentialPositiveIntegerEnv({
          env: { TEST_LIMIT: value },
          fallback: 10,
          key: "TEST_LIMIT",
        }),
      ).toThrow("TEST_LIMIT must be a positive integer.");
    }
  });
});
