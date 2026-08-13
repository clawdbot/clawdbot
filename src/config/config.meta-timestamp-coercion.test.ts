// Verifies config metadata timestamp coercion behavior.
import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("config metadata", () => {
  it("rejects retired lastTouchedAt config metadata", () => {
    const res = validateConfigObject({
      meta: {
        lastTouchedAt: "not-a-date",
      },
    });
    expect(res.ok).toBe(false);
  });

  it("accepts meta with only lastTouchedVersion (no lastTouchedAt)", () => {
    const res = validateConfigObject({
      meta: {
        lastTouchedVersion: "2026.2.6",
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts the model-policy migration completion marker", () => {
    const res = validateConfigObject({
      meta: {
        migrations: { modelPolicyAllowlist: true },
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.meta?.migrations?.modelPolicyAllowlist).toBe(true);
    }
  });
});
