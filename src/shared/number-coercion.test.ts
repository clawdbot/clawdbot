import { describe, expect, test } from "vitest";
import {
  asFiniteNumber,
  asFiniteNumberInRange,
  asSafeIntegerInRange,
  parseFiniteNumber,
  resolveIntegerOption,
  resolveNonNegativeIntegerOption,
  resolveOptionalIntegerOption,
  parseStrictFiniteNumber,
  parseStrictInteger,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "./number-coercion.js";

describe("number-coercion", () => {
  test("asFiniteNumber accepts only finite numbers", () => {
    expect(asFiniteNumber(4)).toBe(4);
    expect(asFiniteNumber("4")).toBeUndefined();
    expect(asFiniteNumber(Number.NaN)).toBeUndefined();
    expect(asFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  test("asFiniteNumberInRange enforces inclusive and exclusive bounds", () => {
    expect(asFiniteNumberInRange(0.5, { min: 0.5, max: 2 })).toBe(0.5);
    expect(asFiniteNumberInRange(2, { min: 0.5, max: 2 })).toBe(2);
    expect(asFiniteNumberInRange(0.5, { min: 0.5, minExclusive: true })).toBeUndefined();
    expect(asFiniteNumberInRange(10, { max: 10, maxExclusive: true })).toBeUndefined();
    expect(asFiniteNumberInRange("1", { min: 0, max: 2 })).toBeUndefined();
  });

  test("asSafeIntegerInRange accepts only safe integers inside inclusive bounds", () => {
    expect(asSafeIntegerInRange(-1, { min: -1, max: 10 })).toBe(-1);
    expect(asSafeIntegerInRange(10, { min: -1, max: 10 })).toBe(10);
    expect(asSafeIntegerInRange(1.5, { min: -1, max: 10 })).toBeUndefined();
    expect(asSafeIntegerInRange(11, { min: -1, max: 10 })).toBeUndefined();
    expect(asSafeIntegerInRange(Number.NaN, { min: -1, max: 10 })).toBeUndefined();
  });

  test("parseFiniteNumber accepts finite numbers and numeric strings", () => {
    expect(parseFiniteNumber(4)).toBe(4);
    expect(parseFiniteNumber("4.5")).toBe(4.5);
    expect(parseFiniteNumber("4.5ms")).toBeUndefined();
    expect(parseFiniteNumber("")).toBeUndefined();
    expect(parseFiniteNumber("nope")).toBeUndefined();
  });

  test("parseStrictInteger accepts only safe integer tokens", () => {
    expect(parseStrictInteger("42")).toBe(42);
    expect(parseStrictInteger(" -7 ")).toBe(-7);
    expect(parseStrictInteger("+9")).toBe(9);
    expect(parseStrictInteger("1.5")).toBeUndefined();
    expect(parseStrictInteger("1e3")).toBeUndefined();
    expect(parseStrictInteger(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
  });

  test("parseStrictFiniteNumber rejects partial numeric strings", () => {
    expect(parseStrictFiniteNumber("42")).toBe(42);
    expect(parseStrictFiniteNumber(".5")).toBe(0.5);
    expect(parseStrictFiniteNumber("1e3")).toBe(1000);
    expect(parseStrictFiniteNumber("3.14ms")).toBeUndefined();
    expect(parseStrictFiniteNumber("0x10")).toBeUndefined();
  });

  test("strict integer range helpers enforce sign", () => {
    expect(parseStrictPositiveInteger("9")).toBe(9);
    expect(parseStrictPositiveInteger("0")).toBeUndefined();
    expect(parseStrictNonNegativeInteger("0")).toBe(0);
    expect(parseStrictNonNegativeInteger("-1")).toBeUndefined();
  });

  test("integer option helpers floor finite values and fall back for non-finite values", () => {
    expect(resolveIntegerOption(7.9, 1, { min: 1, max: 10 })).toBe(7);
    expect(resolveIntegerOption(Number.NaN, 4.9, { min: 1 })).toBe(4);
    expect(resolveIntegerOption(Number.NEGATIVE_INFINITY, 4, { min: 1 })).toBe(4);
    expect(resolveIntegerOption(-4, 1, { min: 0 })).toBe(0);
    expect(resolveIntegerOption(40, 1, { max: 10 })).toBe(10);
    expect(resolveNonNegativeIntegerOption(Number.NaN, 3.9)).toBe(3);
  });

  test("optional integer option helper rejects non-finite values", () => {
    expect(resolveOptionalIntegerOption(7.9, { min: 1, max: 10 })).toBe(7);
    expect(resolveOptionalIntegerOption(Number.NaN, { min: 1 })).toBeUndefined();
    expect(resolveOptionalIntegerOption(Number.POSITIVE_INFINITY, { min: 1 })).toBeUndefined();
    expect(resolveOptionalIntegerOption(-4, { min: 0 })).toBe(0);
    expect(resolveOptionalIntegerOption(40, { max: 10 })).toBe(10);
  });
});
