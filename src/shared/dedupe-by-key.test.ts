import { describe, expect, it, vi } from "vitest";
import { dedupeByKey } from "./dedupe-by-key.js";

describe("dedupeByKey", () => {
  it("keeps the first item for each key in stable input order", () => {
    const first = Object.freeze({ id: "first", key: "duplicate" });
    const duplicate = Object.freeze({ id: "second", key: "duplicate" });
    const last = Object.freeze({ id: "last", key: "unique" });
    const items = Object.freeze([first, duplicate, last]);
    const keyOf = vi.fn((item: (typeof items)[number]) => item.key);

    const result = dedupeByKey(items, keyOf);

    expect(result).toEqual([first, last]);
    expect(result[0]).toBe(first);
    expect(keyOf).toHaveBeenCalledTimes(items.length);
    expect(items).toEqual([first, duplicate, last]);
  });

  it("returns an empty array without reading a key", () => {
    const keyOf = vi.fn<(item: string) => string>();

    expect(dedupeByKey([], keyOf)).toEqual([]);
    expect(keyOf).not.toHaveBeenCalled();
  });

  it("propagates key errors and stops at the failing item", () => {
    const failure = new Error("key failed");
    const visited: string[] = [];
    const keyOf = (item: string) => {
      visited.push(item);
      if (item === "bad") {
        throw failure;
      }
      return item;
    };

    expect(() => dedupeByKey(["first", "bad", "unvisited"], keyOf)).toThrow(failure);
    expect(visited).toEqual(["first", "bad"]);
  });
});
