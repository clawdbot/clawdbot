// Verifies session maintenance extension schema parsing.
import { describe, expect, it } from "vitest";
import { SessionSchema } from "./zod-schema.session.js";

describe("SessionSchema maintenance extensions", () => {
  it("accepts valid maintenance extensions", () => {
    const result = SessionSchema.safeParse({
      maintenance: {
        resetArchiveRetention: "14d",
        maxDiskBytes: "500mb",
        highWaterBytes: "350mb",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts disabling reset archive cleanup", () => {
    const result = SessionSchema.safeParse({
      maintenance: {
        resetArchiveRetention: false,
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts disabling the session disk budget", () => {
    const result = SessionSchema.safeParse({
      maintenance: {
        maxDiskBytes: false,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid maintenance extension values", () => {
    expect(() =>
      SessionSchema.parse({
        maintenance: {
          resetArchiveRetention: "never",
        },
      }),
    ).toThrow(/resetArchiveRetention|duration/i);

    expect(() =>
      SessionSchema.parse({
        maintenance: {
          maxDiskBytes: "big",
        },
      }),
    ).toThrow(/maxDiskBytes|size/i);
  });

  it.each([0, "0h", "0d", "0ms", "0", "0s", "0m"])(
    "rejects zero-value resetArchiveRetention: %s",
    (resetArchiveRetention) => {
      const result = SessionSchema.safeParse({
        maintenance: { resetArchiveRetention },
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toContain("resetArchiveRetention");
    },
  );

  it("accepts positive resetArchiveRetention values", () => {
    expect(SessionSchema.safeParse({ maintenance: { resetArchiveRetention: "30d" } }).success).toBe(
      true,
    );
    expect(SessionSchema.safeParse({ maintenance: { resetArchiveRetention: "7d" } }).success).toBe(
      true,
    );
    expect(
      SessionSchema.safeParse({ maintenance: { resetArchiveRetention: "500ms" } }).success,
    ).toBe(true);
  });

  it("accepts resetArchiveRetention: false (documented disable)", () => {
    expect(SessionSchema.safeParse({ maintenance: { resetArchiveRetention: false } }).success).toBe(
      true,
    );
  });

  it.each([0, "0h", "0d", "0ms", "0", "0s", "0m"])(
    "rejects zero-value pruneAfter: %s",
    (pruneAfter) => {
      const result = SessionSchema.safeParse({
        maintenance: { pruneAfter },
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toContain("pruneAfter");
    },
  );

  it("accepts positive pruneAfter values", () => {
    expect(SessionSchema.safeParse({ maintenance: { pruneAfter: "30d" } }).success).toBe(true);
    expect(SessionSchema.safeParse({ maintenance: { pruneAfter: "24h" } }).success).toBe(true);
    expect(SessionSchema.safeParse({ maintenance: { pruneAfter: "500ms" } }).success).toBe(true);
  });
});
