import { describe, expect, it } from "vitest";
import {
  boundedJsonUtf8Bytes,
  firstEnumerableOwnKeys,
  jsonUtf8Bytes,
  jsonUtf8BytesOrInfinity,
} from "./json-utf8-bytes.js";

function createCircularValue() {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  return circular;
}

describe("jsonUtf8Bytes", () => {
  it.each([
    {
      name: "object payloads",
      value: { a: "x", b: [1, 2, 3] },
      expected: Buffer.byteLength(JSON.stringify({ a: "x", b: [1, 2, 3] }), "utf8"),
    },
    {
      name: "strings",
      value: "hello",
      expected: Buffer.byteLength(JSON.stringify("hello"), "utf8"),
    },
    {
      name: "undefined via string fallback",
      value: undefined,
      expected: Buffer.byteLength("undefined", "utf8"),
    },
    {
      name: "unicode strings",
      value: "🙂",
      expected: Buffer.byteLength(JSON.stringify("🙂"), "utf8"),
    },
  ])("returns utf8 byte length for $name", ({ value, expected }) => {
    expect(jsonUtf8Bytes(value)).toBe(expected);
  });

  it.each([
    {
      name: "circular serialization failures",
      value: createCircularValue(),
      expected: "[object Object]",
    },
    { name: "BigInt serialization failures", value: 12n, expected: "12" },
    { name: "symbol serialization failures", value: Symbol("token"), expected: "Symbol(token)" },
  ])("uses string conversion for $name", ({ value, expected }) => {
    expect(jsonUtf8Bytes(value)).toBe(Buffer.byteLength(expected, "utf8"));
  });
});

describe("jsonUtf8BytesOrInfinity", () => {
  it("returns exact JSON byte length for serializable values", () => {
    const value = { a: "x", b: [1, 2, null] };
    expect(jsonUtf8BytesOrInfinity(value)).toBe(Buffer.byteLength(JSON.stringify(value), "utf8"));
  });

  it.each([createCircularValue(), 12n, undefined])(
    "returns infinity for values that cannot be serialized as JSON",
    (value) => {
      expect(jsonUtf8BytesOrInfinity(value)).toBe(Number.POSITIVE_INFINITY);
    },
  );
});

describe("boundedJsonUtf8Bytes", () => {
  it.each([
    { name: "plain object", value: { a: "x", b: [1, 2, null] } },
    { name: "unicode string", value: { value: "🙂" } },
    {
      name: "array holes and undefined",
      value: (() => {
        const value = [undefined, () => undefined] as unknown[];
        value.length = 3;
        return value;
      })(),
    },
    { name: "non-finite numbers", value: [Number.NaN, Number.POSITIVE_INFINITY] },
    { name: "date", value: { at: new Date("2026-04-25T12:00:00.000Z") } },
  ])("matches JSON.stringify byte length for $name", ({ value }) => {
    expect(boundedJsonUtf8Bytes(value, 100_000)).toEqual({
      bytes: Buffer.byteLength(JSON.stringify(value), "utf8"),
      complete: true,
    });
  });

  it("stops once the byte limit is exceeded", () => {
    expect(boundedJsonUtf8Bytes({ value: "x".repeat(50_000) }, 8_192)).toEqual({
      bytes: 8_193,
      complete: false,
    });
  });

  it.each([
    { name: "circular objects", value: createCircularValue() },
    { name: "BigInt", value: { value: 12n } },
    { name: "custom toJSON", value: { toJSON: () => ({ ok: true }) } },
  ])("marks $name incomplete instead of invoking unsafe JSON serialization", ({ value }) => {
    const result = boundedJsonUtf8Bytes(value, 8_192);
    expect(result.complete).toBe(false);
    expect(result.bytes).toBeGreaterThan(8_192);
  });
});

describe("firstEnumerableOwnKeys", () => {
  it("returns only own enumerable keys up to the limit", () => {
    const inherited = { inherited: true };
    const value = Object.create(inherited) as Record<string, unknown>;
    value.a = 1;
    value.b = 2;
    value.c = 3;
    Object.defineProperty(value, "hidden", { enumerable: false, value: true });

    expect(firstEnumerableOwnKeys(value, 2)).toEqual(["a", "b"]);
  });
});
