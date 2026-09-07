import { describe, expect, it } from "vitest";
import { sortJsonValueKeys } from "../../scripts/lib/canonical-json.mjs";

describe("sortJsonValueKeys", () => {
  it("sorts nested keys without mutating the input", () => {
    const input = { z: { d: 1, c: 2 }, a: [{ b: 3, a: 4 }] };

    const result = sortJsonValueKeys(input) as Record<string, unknown>;

    expect(Object.keys(result)).toEqual(["a", "z"]);
    expect(Object.keys((result.z as Record<string, unknown>) ?? {})).toEqual(["c", "d"]);
    expect(input).toEqual({ z: { d: 1, c: 2 }, a: [{ b: 3, a: 4 }] });
  });

  it("uses the runtime locale ordering", () => {
    const keys = ["z", "ä", "a"];
    const result = sortJsonValueKeys(Object.fromEntries(keys.map((key) => [key, key])));

    expect(Object.keys(result as object)).toEqual(
      keys.toSorted((left, right) => left.localeCompare(right)),
    );
  });

  it("preserves sparse arrays and permissive leaf values", () => {
    const fn = () => "value";
    const symbol = Symbol("value");
    const input = new Array(3);
    input[1] = { z: undefined, y: -0, x: Number.NaN, w: 1n, v: fn, u: symbol };

    const result = sortJsonValueKeys(input) as unknown[];
    const entry = result[1] as Record<string, unknown>;

    expect(result).toHaveLength(3);
    expect(0 in result).toBe(false);
    expect(2 in result).toBe(false);
    expect(Object.keys(entry)).toEqual(["u", "v", "w", "x", "y", "z"]);
    expect(entry).toMatchObject({ u: symbol, v: fn, w: 1n, x: Number.NaN, z: undefined });
    expect(Object.is(entry.y, -0)).toBe(true);
  });

  it("uses Object.entries projection and getter evaluation order", () => {
    const reads: string[] = [];
    const input = Object.create({ inherited: true }) as Record<string | symbol, unknown>;
    Object.defineProperty(input, "hidden", { enumerable: false, value: true });
    Object.defineProperty(input, "z", {
      enumerable: true,
      get: () => (reads.push("z"), 1),
    });
    Object.defineProperty(input, "a", {
      enumerable: true,
      get: () => (reads.push("a"), 2),
    });
    input[Symbol("ignored")] = true;

    const result = sortJsonValueKeys(input);

    expect(reads).toEqual(["z", "a"]);
    expect(result).toEqual({ a: 2, z: 1 });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it("retains natural cycle failure", () => {
    const input: Record<string, unknown> = {};
    input.self = input;

    expect(() => sortJsonValueKeys(input)).toThrow(RangeError);
  });
});
