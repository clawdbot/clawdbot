import { describe, expect, it } from "vitest";
import {
  CONTROL_MODEL_DEFAULT_BOUNDS,
  CONTROL_MODEL_SESSION_REFRESH_DEFAULTS,
} from "./defaults.js";

describe("Control Model finite defaults", () => {
  it("keeps every retained-state and refresh default finite and positive", () => {
    for (const value of Object.values({
      ...CONTROL_MODEL_DEFAULT_BOUNDS,
      ...CONTROL_MODEL_SESSION_REFRESH_DEFAULTS,
    })) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
    expect(Object.isFrozen(CONTROL_MODEL_DEFAULT_BOUNDS)).toBe(true);
    expect(Object.isFrozen(CONTROL_MODEL_SESSION_REFRESH_DEFAULTS)).toBe(true);
  });
});
