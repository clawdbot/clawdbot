// Normalization Core tests cover record coerce behavior.
import { describe, expect, it } from "vitest";
import {
  asNonArrayRecord,
  asNullableRecord,
  asOptionalRecord,
  isStringRecord,
} from "./record-coerce.js";

describe("record-coerce", () => {
  it("keeps record coercion behavior for optional and nullable variants", () => {
    expect(asOptionalRecord({ ok: true })).toEqual({ ok: true });
    expect(asOptionalRecord(null)).toBeUndefined();
    expect(asOptionalRecord([{ ok: true }])).toBeUndefined();
    expect(asNullableRecord({ ok: true })).toEqual({ ok: true });
    expect(asNullableRecord(null)).toBeNull();
    expect(asNullableRecord([{ ok: true }])).toBeNull();
  });

  it("preserves accepted record identity and returns fresh ordinary fallbacks", () => {
    class ExampleRecord {
      marker = true;
    }
    const record = Object.create(null) as Record<string, unknown>;
    const date = new Date();
    const instance = new ExampleRecord();
    const firstFallback = asNonArrayRecord(null);
    const secondFallback = asNonArrayRecord([]);

    expect(asNonArrayRecord(record)).toBe(record);
    expect(asNonArrayRecord(date)).toBe(date);
    expect(asNonArrayRecord(instance)).toBe(instance);
    expect(firstFallback).toEqual({});
    expect(Object.getPrototypeOf(firstFallback)).toBe(Object.prototype);
    expect(secondFallback).toEqual({});
    expect(secondFallback).not.toBe(firstFallback);
  });

  it("preserves the canonical proxy trap behavior", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => asNonArrayRecord(proxy)).toThrow(TypeError);
    expect(() => isStringRecord(proxy)).toThrow(TypeError);
  });

  it.each([
    { value: {}, expected: true },
    { value: { first: "one", second: "two" }, expected: true },
    { value: Object.assign(Object.create(null), { first: "one" }), expected: true },
    { value: new Date(), expected: true },
    { value: { first: "one", second: 2 }, expected: false },
    { value: ["one"], expected: false },
    { value: null, expected: false },
  ])("validates all-or-nothing string records", ({ value, expected }) => {
    expect(isStringRecord(value)).toBe(expected);
  });
});
