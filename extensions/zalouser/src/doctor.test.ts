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
  it("warns when mutable group names rely on disabled name matching", async () => {
    const warnings = await Promise.resolve(
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
      }) ?? [],
    );

    const mutableWarning = warnings.find((warning: string) =>
      warning.includes("mutable allowlist entry across zalouser"),
    );
    const groupPathWarning = warnings.find((warning: string) =>
      warning.includes("channels.zalouser.groups: group:trusted"),
    );
    expect(mutableWarning).toBeDefined();
    expect(groupPathWarning).toBeDefined();
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
    expect(result.changes).toEqual([
      "Moved channels.zalouser.groups.group:trusted.allow → channels.zalouser.groups.group:trusted.enabled (true).",
      "Moved channels.zalouser.accounts.work.groups.group:legacy.allow → channels.zalouser.accounts.work.groups.group:legacy.enabled (false).",
    ]);
  });
});
