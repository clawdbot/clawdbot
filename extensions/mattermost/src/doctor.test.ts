import { describe, expect, it } from "vitest";
import { mattermostDoctor } from "./doctor.js";

function getMattermostCompatibilityNormalizer(): NonNullable<
  typeof mattermostDoctor.normalizeCompatibilityConfig
> {
  const normalize = mattermostDoctor.normalizeCompatibilityConfig;
  if (!normalize) {
    throw new Error("Expected mattermost doctor to expose normalizeCompatibilityConfig");
  }
  return normalize;
}

describe("mattermost doctor", () => {
  it("normalizes legacy private-network aliases", () => {
    const normalize = getMattermostCompatibilityNormalizer();

    const result = normalize({
      cfg: {
        channels: {
          mattermost: {
            allowPrivateNetwork: true,
            accounts: {
              work: {
                allowPrivateNetwork: false,
              },
            },
          },
        },
      } as never,
    });

    expect(result.config.channels?.mattermost?.network).toEqual({
      dangerouslyAllowPrivateNetwork: true,
    });
    expect(
      (
        result.config.channels?.mattermost?.accounts?.work as
          | { network?: Record<string, unknown> }
          | undefined
      )?.network,
    ).toEqual({
      dangerouslyAllowPrivateNetwork: false,
    });
  });
});
