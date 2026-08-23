import { describe, expect, it } from "vitest";
import { validateHooksStatusParams } from "../index.js";

describe("hook protocol schemas", () => {
  it("accepts an empty status request and rejects extra fields", () => {
    expect(validateHooksStatusParams({})).toBe(true);
    expect(validateHooksStatusParams({ reload: true })).toBe(false);
  });
});
