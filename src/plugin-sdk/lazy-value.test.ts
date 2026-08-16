/** Tests cached lazy value getter memoization. */
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
});
