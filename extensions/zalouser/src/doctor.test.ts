import { describe, expect, it } from "vitest";
import { zalouserDoctor } from "./doctor.js";

function getZaloUserCompatibilityNormalizer(): NonNullable<
  typeof zalouserDoctor.normalizeCompatibilityConfig
> {
  const normalize = zalouserDoctor.normalizeCompatibilityConfig;
  if (!normalize) {
    throw new Error("Expected zalouser doctor to expose normalizeCompatibilityConfig");
  }
  return normalize;
}

describe("zalouser doctor", () => {
  it("warns when mutable group names rely on disabled name matching", () => {
    expect(
      zalouserDoctor.collectMutableAllowlistWarnings?.({
        cfg: {
          channels: {
            zalouser: {
              groups: {
                "group:trusted": {
                  enabled: true,
                },
              },
            },
          },
        } as never,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("mutable allowlist entry across zalouser"),
        expect.stringContaining("channels.zalouser.groups: group:trusted"),
      ]),
    );
  });

  it("normalizes legacy group allow aliases to enabled", () => {
    const normalize = getZaloUserCompatibilityNormalizer();

    const result = normalize({
      cfg: {
        channels: {
          zalouser: {
            groups: {
              "group:trusted": {
                allow: true,
              },
            },
            accounts: {
              work: {
                groups: {
                  "group:legacy": {
                    allow: false,
                  },
                },
              },
            },
          },
        },
      } as never,
    });

    expect(result.config.channels?.zalouser?.groups?.["group:trusted"]).toEqual({
      enabled: true,
    });
    expect(
      (
        result.config.channels?.zalouser?.accounts?.work as
          | { groups?: Record<string, unknown> }
          | undefined
      )?.groups?.["group:legacy"],
    ).toEqual({
      enabled: false,
    });
    expect(result.changes).toEqual(
      expect.arrayContaining([
        "Moved channels.zalouser.groups.group:trusted.allow → channels.zalouser.groups.group:trusted.enabled (true).",
        "Moved channels.zalouser.accounts.work.groups.group:legacy.allow → channels.zalouser.accounts.work.groups.group:legacy.enabled (false).",
      ]),
    );
  });
});
