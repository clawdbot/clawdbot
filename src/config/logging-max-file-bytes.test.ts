import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("logging.maxFileBytes config", () => {
  it("accepts a positive maxFileBytes", () => {
    const res = validateConfigObject({
      logging: {
        maxFileBytes: 1024,
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects non-positive maxFileBytes", () => {
    const res = validateConfigObject({
      logging: {
        maxFileBytes: 0,
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toEqual([
        {
          path: "logging.maxFileBytes",
          message: "Too small: expected number to be >0",
        },
      ]);
    }
  });
});
