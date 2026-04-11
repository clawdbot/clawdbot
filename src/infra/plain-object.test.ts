import { describe, expect, it } from "vitest";
import { isPlainObject } from "./plain-object.js";

describe("isPlainObject", () => {
  it.each([
    {},
    { a: 1 },
    Object.create(null),
    new (class X {
      readonly marker = true;
    })(),
    { [Symbol.toStringTag]: "Object" },
  ])("accepts object-tag values: %j", (value) => {
    expect(isPlainObject(value)).toBe(true);
  });

  it.each([
    null,
    [],
    new Date(),
    /re/,
    "x",
    42,
    () => null,
    new Map(),
    { [Symbol.toStringTag]: "Array" },
  ])("rejects non-plain values: %j", (value) => {
    expect(isPlainObject(value)).toBe(false);
  });
});
