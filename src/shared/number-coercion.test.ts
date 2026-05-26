import { describe, expect, test } from "vitest";
import { asFiniteNumber, parseFiniteNumber } from "./number-coercion.js";

describe("number-coercion", () => {
  test("asFiniteNumber accepts only finite numbers", () => {
    expect(asFiniteNumber(4)).toBe(4);
    expect(asFiniteNumber("4")).toBeUndefined();
    expect(asFiniteNumber(Number.NaN)).toBeUndefined();
    expect(asFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  test("parseFiniteNumber accepts finite numbers and numeric strings", () => {
    expect(parseFiniteNumber(4)).toBe(4);
    expect(parseFiniteNumber("4.5ms")).toBe(4.5);
    expect(parseFiniteNumber("")).toBeUndefined();
    expect(parseFiniteNumber("nope")).toBeUndefined();
  });
});
