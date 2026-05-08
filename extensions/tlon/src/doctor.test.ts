import { describe, expect, it } from "vitest";
import { tlonDoctor } from "./doctor.js";

function getTlonCompatibilityNormalizer(): NonNullable<
  typeof tlonDoctor.normalizeCompatibilityConfig
> {
  const normalize = tlonDoctor.normalizeCompatibilityConfig;
  if (!normalize) {
    throw new Error("Expected tlon doctor to expose normalizeCompatibilityConfig");
  }
  return normalize;
}

describe("tlon doctor", () => {
  it("normalizes legacy private-network aliases", () => {
    const normalize = getTlonCompatibilityNormalizer();

    const result = normalize({
      cfg: {
        channels: {
          tlon: {
            allowPrivateNetwork: true,
            accounts: {
              alt: {
                allowPrivateNetwork: false,
              },
            },
          },
        },
      } as never,
    });

    expect(result.config.channels?.tlon?.network).toEqual({
      dangerouslyAllowPrivateNetwork: true,
    });
    expect(
      (
        result.config.channels?.tlon?.accounts?.alt as
          | { network?: Record<string, unknown> }
          | undefined
      )?.network,
    ).toEqual({
      dangerouslyAllowPrivateNetwork: false,
    });
  });
});
