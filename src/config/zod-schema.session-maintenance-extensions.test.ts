import { describe, expect, it } from "vitest";
import { SessionSchema } from "./zod-schema.session.js";

describe("SessionSchema maintenance extensions", () => {
  it("accepts valid maintenance extensions", () => {
    expect(() =>
      SessionSchema.parse({
        maintenance: {
          resetArchiveRetention: "14d",
          maxDiskBytes: "500mb",
          highWaterBytes: "350mb",
        },
      }),
    ).not.toThrow();
  });

  it("accepts disabling reset archive cleanup", () => {
    expect(() =>
      SessionSchema.parse({
        maintenance: {
          resetArchiveRetention: false,
        },
      }),
    ).not.toThrow();
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
