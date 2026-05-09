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

    const mattermostConfig = result.config.channels?.mattermost;
    if (!mattermostConfig) {
      throw new Error("expected normalized Mattermost config");
    }
    expect(mattermostConfig.network).toEqual({
      dangerouslyAllowPrivateNetwork: true,
    });
    const workAccount = mattermostConfig.accounts?.work as
      | { network?: Record<string, unknown> }
      | undefined;
    if (!workAccount) {
      throw new Error("expected Mattermost work account config");
    }
    expect(workAccount.network).toEqual({
      dangerouslyAllowPrivateNetwork: false,
    });
  });
});
