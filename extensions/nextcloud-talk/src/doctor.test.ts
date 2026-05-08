import { describe, expect, it } from "vitest";
import { nextcloudTalkDoctor } from "./doctor.js";

function getNextcloudTalkCompatibilityNormalizer(): NonNullable<
  typeof nextcloudTalkDoctor.normalizeCompatibilityConfig
> {
  const normalize = nextcloudTalkDoctor.normalizeCompatibilityConfig;
  if (!normalize) {
    throw new Error("Expected nextcloud-talk doctor to expose normalizeCompatibilityConfig");
  }
  return normalize;
}

describe("nextcloud-talk doctor", () => {
  it("normalizes legacy private-network aliases", () => {
    const normalize = getNextcloudTalkCompatibilityNormalizer();

    const result = normalize({
      cfg: {
        channels: {
          "nextcloud-talk": {
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

    expect(result.config.channels?.["nextcloud-talk"]?.network).toEqual({
      dangerouslyAllowPrivateNetwork: true,
    });
    expect(
      (
        result.config.channels?.["nextcloud-talk"]?.accounts?.work as
          | { network?: Record<string, unknown> }
          | undefined
      )?.network,
    ).toEqual({
      dangerouslyAllowPrivateNetwork: false,
    });
  });
});
