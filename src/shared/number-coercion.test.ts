import { describe, expect, it } from "vitest";
import { resolveNonNegativeNumber } from "./number-coercion.js";

describe("resolveNonNegativeNumber", () => {
  it.each([0, -0, 1.25, Number.MIN_VALUE, Number.MAX_VALUE])(
    "preserves finite non-negative value %s",
    (value) => {
      expect(resolveNonNegativeNumber(value)).toBe(value);
    },
  );

  it.each([-1, -0.1, Number.NaN, Infinity, -Infinity, null, undefined])(
    "rejects invalid value %s",
    (value) => {
      expect(resolveNonNegativeNumber(value)).toBeUndefined();
    },
  );
});
