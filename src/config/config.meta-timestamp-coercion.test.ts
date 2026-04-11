import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("meta.lastTouchedAt numeric timestamp coercion", () => {
  it("accepts a numeric Unix timestamp and coerces it to an ISO string", () => {
    const numericTimestamp = 1770394758161;
    const res = validateConfigObject({
      meta: {
        lastTouchedAt: numericTimestamp,
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(typeof res.config.meta?.lastTouchedAt).toBe("string");
      expect(res.config.meta?.lastTouchedAt).toBe(new Date(numericTimestamp).toISOString());
    }
  });

  it("still accepts a string ISO timestamp unchanged", () => {
    const isoTimestamp = "2026-02-07T01:39:18.161Z";
    const res = validateConfigObject({
      meta: {
        lastTouchedAt: isoTimestamp,
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.meta?.lastTouchedAt).toBe(isoTimestamp);
    }
  });

  it("rejects out-of-range numeric timestamps without throwing", () => {
    const res = validateConfigObject({
      meta: {
        lastTouchedAt: 1e20,
      },
    });
    expect(res.ok).toBe(false);
  });

  it("passes non-date strings through unchanged (backwards-compatible)", () => {
    const res = validateConfigObject({
      meta: {
        lastTouchedAt: "not-a-date",
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.meta?.lastTouchedAt).toBe("not-a-date");
    }
  });

  it("accepts meta with only lastTouchedVersion (no lastTouchedAt)", () => {
    const res = validateConfigObject({
      meta: {
        lastTouchedVersion: "2026.2.6",
      },
    });
    expect(res.ok).toBe(true);
  });
});
