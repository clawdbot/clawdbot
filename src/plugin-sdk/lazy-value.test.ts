/**
 * Tests cached lazy value getter behavior and fallback handling.
 */
import { describe, expect, it, vi } from "vitest";
import { createCachedLazyValueGetter } from "./lazy-value.js";

describe("createCachedLazyValueGetter", () => {
  it("memoizes lazy factories", () => {
    const resolveSchema = vi.fn(() => ({ type: "object" as const }));
    const getSchema = createCachedLazyValueGetter(resolveSchema);

    expect(getSchema()).toEqual({ type: "object" });
    expect(getSchema()).toEqual({ type: "object" });
    expect(resolveSchema).toHaveBeenCalledTimes(1);
  });

  it("uses the fallback when the lazy value resolves nullish", () => {
    const fallback = { type: "object" as const, properties: {} };
    const resolveSchema = (): typeof fallback | undefined => undefined;
    const getSchema = createCachedLazyValueGetter(resolveSchema, fallback);

    expect(getSchema()).toBe(fallback);
  });
});
