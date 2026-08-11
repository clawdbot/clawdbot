import { describe, expect, it } from "vitest";
import { isPromiseLike } from "./promise-like.js";

describe("isPromiseLike", () => {
  it("accepts thenables and rejects values without a callable then", () => {
    const thenable = {};
    // oxlint-disable-next-line unicorn/no-thenable -- An explicit thenable is the contract under test.
    Reflect.defineProperty(thenable, "then", { value: () => {} });
    const nonCallableThen = {};
    // oxlint-disable-next-line unicorn/no-thenable -- The guard must reject a non-callable then field.
    Reflect.defineProperty(nonCallableThen, "then", { value: true });

    expect(isPromiseLike(Promise.resolve())).toBe(true);
    expect(isPromiseLike(thenable)).toBe(true);
    expect(isPromiseLike(nonCallableThen)).toBe(false);
    expect(isPromiseLike(null)).toBe(false);
  });
});
