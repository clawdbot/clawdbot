// Safe JSON tests cover defensive stringify for diagnostic logging.
import { describe, expect, it } from "vitest";
import { safeJsonStringify } from "./safe-json.js";

describe("safeJsonStringify", () => {
  it("stringifies regular objects", () => {
    expect(safeJsonStringify({ a: 1 })).toBe('{"a":1}');
    expect(safeJsonStringify([1, 2, 3])).toBe("[1,2,3]");
  });

  it("stringifies bigint values as decimal strings", () => {
    const result = safeJsonStringify({ n: BigInt(123) });
    expect(JSON.parse(result!)).toEqual({ n: "123" });
  });

  it("replaces functions with a placeholder", () => {
    const result = safeJsonStringify({ fn() {} });
    expect(JSON.parse(result!)).toEqual({ fn: "[Function]" });
  });

  it("converts Error objects to plain diagnostic objects", () => {
    const err = new Error("boom");
    const result = safeJsonStringify({ error: err });
    const parsed = JSON.parse(result!);
    expect(parsed.error).toEqual({
      name: "Error",
      message: "boom",
      stack: err.stack,
    });
  });

  it("base64-encodes Uint8Array payloads", () => {
    const buf = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    const result = safeJsonStringify({ data: buf });
    const parsed = JSON.parse(result!);
    expect(parsed.data).toEqual({
      type: "Uint8Array",
      data: "SGVsbG8=",
    });
  });

  it("returns null for circular structures", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(safeJsonStringify(obj)).toBeNull();
  });
});
