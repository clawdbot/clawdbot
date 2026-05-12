import { describe, expect, it } from "vitest";
import { SessionSchema } from "./zod-schema.session.js";

describe("SessionSchema maintenance extensions", () => {
  it("accepts session write-lock acquire timeout", () => {
    const result = SessionSchema.safeParse({
      writeLock: {
        acquireTimeoutMs: 60_000,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid session write-lock acquire timeout values", () => {
    expect(() =>
      SessionSchema.parse({
        writeLock: {
          acquireTimeoutMs: 0,
        },
      }),
    ).toThrow(/acquireTimeoutMs|number/i);
  });

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
});
