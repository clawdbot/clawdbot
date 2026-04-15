import { describe, expect, it } from "vitest";
import { nextcloudTalkDoctor } from "./doctor.js";

describe("nextcloud-talk doctor", () => {
  it("normalizes legacy private-network aliases", () => {
    const normalize = nextcloudTalkDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

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
