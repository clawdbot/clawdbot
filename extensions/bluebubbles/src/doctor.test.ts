import { describe, expect, it } from "vitest";
import { bluebubblesDoctor } from "./doctor.js";

describe("bluebubbles doctor", () => {
  it("normalizes legacy private-network aliases", () => {
    const normalize = bluebubblesDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
      cfg: {
        channels: {
          bluebubbles: {
            allowPrivateNetwork: true,
            accounts: {
              default: {
                allowPrivateNetwork: false,
              },
            },
          },
        },
      } as never,
    });

    expect(result.config.channels?.bluebubbles?.network).toEqual({
      dangerouslyAllowPrivateNetwork: true,
    });
    expect(
      (
        result.config.channels?.bluebubbles?.accounts?.default as {
          network?: { dangerouslyAllowPrivateNetwork?: boolean };
        }
      )?.network,
    ).toEqual({
      dangerouslyAllowPrivateNetwork: false,
    });
  });
});
