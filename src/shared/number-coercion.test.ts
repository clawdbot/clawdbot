import { describe, expect, test } from "vitest";
import {
  asFiniteNumber,
  asFiniteNumberInRange,
  asSafeIntegerInRange,
  addTimerTimeoutGraceMs,
  clampPositiveTimerTimeoutMs,
  clampTimerTimeoutMs,
  finiteSecondsToTimerSafeMilliseconds,
  MAX_TIMER_TIMEOUT_MS,
  MAX_TIMER_TIMEOUT_SECONDS,
  nonNegativeSecondsToSafeMilliseconds,
  parseFiniteNumber,
  positiveSecondsToSafeMilliseconds,
  resolveIntegerOption,
  resolveExpiresAtMsFromDurationSeconds,
  resolveExpiresAtMsFromDurationOrEpoch,
  resolveExpiresAtMsFromEpochSeconds,
  resolveNonNegativeIntegerOption,
  resolveOptionalIntegerOption,
  resolvePositiveTimerTimeoutMs,
  parseStrictFiniteNumber,
  parseStrictInteger,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
  resolveTimerTimeoutMs,
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

  test("timer timeout helpers centralize Node-safe bounds", () => {
    expect(MAX_TIMER_TIMEOUT_SECONDS).toBe(2_147_000);
    expect(finiteSecondsToTimerSafeMilliseconds(1.5)).toBe(1_500);
    expect(finiteSecondsToTimerSafeMilliseconds(1.5, { floorSeconds: true })).toBe(1_000);
    expect(finiteSecondsToTimerSafeMilliseconds(10_000_000)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(finiteSecondsToTimerSafeMilliseconds("10")).toBeUndefined();
    expect(finiteSecondsToTimerSafeMilliseconds(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(clampTimerTimeoutMs(0, 10)).toBe(10);
    expect(clampTimerTimeoutMs(10_000_000_000)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(clampTimerTimeoutMs(Number.NaN)).toBeUndefined();
    expect(clampPositiveTimerTimeoutMs(0)).toBeUndefined();
    expect(clampPositiveTimerTimeoutMs(-1)).toBeUndefined();
    expect(clampPositiveTimerTimeoutMs(10_000_000_000)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolvePositiveTimerTimeoutMs(0, 5000)).toBe(5000);
    expect(resolvePositiveTimerTimeoutMs(Number.MAX_SAFE_INTEGER, 5000)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveTimerTimeoutMs(Number.NaN, 5000)).toBe(5000);
    expect(resolveTimerTimeoutMs(Number.NaN, 0, 0)).toBe(0);
    expect(resolveTimerTimeoutMs(Number.NaN, Number.POSITIVE_INFINITY, 25)).toBe(25);
    expect(resolveTimerTimeoutMs(Number.MAX_SAFE_INTEGER, 5000)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(addTimerTimeoutGraceMs(10_000)).toBe(15_000);
    expect(addTimerTimeoutGraceMs(10_000, 500)).toBe(10_500);
    expect(addTimerTimeoutGraceMs(MAX_TIMER_TIMEOUT_MS - 100, 500)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(addTimerTimeoutGraceMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(addTimerTimeoutGraceMs(Number.MAX_VALUE)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(addTimerTimeoutGraceMs(Number.NaN)).toBeUndefined();
  });

  test("seconds helpers reject unsafe millisecond values", () => {
    expect(positiveSecondsToSafeMilliseconds("10")).toBe(10_000);
    expect(positiveSecondsToSafeMilliseconds("0")).toBeUndefined();
    expect(positiveSecondsToSafeMilliseconds("1e309")).toBeUndefined();
    expect(nonNegativeSecondsToSafeMilliseconds("0")).toBe(0);
    expect(nonNegativeSecondsToSafeMilliseconds("-1")).toBeUndefined();
  });

  test("expiry helpers resolve safe absolute timestamps", () => {
    expect(
      resolveExpiresAtMsFromDurationSeconds("3600", {
        nowMs: 1_000,
        bufferMs: 300,
      }),
    ).toBe(3_600_700);
    expect(
      resolveExpiresAtMsFromDurationSeconds("10", {
        nowMs: 1_000,
        bufferMs: 20_000,
        minRemainingMs: 30_000,
      }),
    ).toBe(31_000);
    expect(resolveExpiresAtMsFromDurationSeconds("1e309", { nowMs: 1_000 })).toBeUndefined();
    expect(resolveExpiresAtMsFromEpochSeconds("3600", { bufferMs: 300 })).toBe(3_599_700);
    expect(resolveExpiresAtMsFromEpochSeconds("1e309")).toBeUndefined();
  });

  test("mixed expiry helper handles relative seconds, epoch seconds, and absolute milliseconds", () => {
    expect(resolveExpiresAtMsFromDurationOrEpoch(86_400, { nowMs: 1_700_000_000_000 })).toBe(
      1_700_086_400_000,
    );
    expect(resolveExpiresAtMsFromDurationOrEpoch(1_700_000_000)).toBe(1_700_000_000_000);
    expect(resolveExpiresAtMsFromDurationOrEpoch(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(resolveExpiresAtMsFromDurationOrEpoch(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(resolveExpiresAtMsFromDurationOrEpoch(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
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
