// CUA tests cover the doctor-only migration for the retired daemon path.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

describe("cua-computer doctor contract", () => {
  it("flags the retired driver path for openclaw doctor --fix", () => {
    expect(legacyConfigRules).toEqual([
      expect.objectContaining({
        path: ["plugins", "entries", "cua-computer", "config", "driverPath"],
        message: expect.stringContaining("openclaw doctor --fix"),
      }),
    ]);
  });

  it("removes the shipped daemon path before strict plugin validation", () => {
    const config = {
      plugins: {
        entries: {
          "cua-computer": {
            enabled: true,
            config: { driverPath: "/usr/local/bin/cua-driver" },
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([
      "Removed retired plugins.entries.cua-computer.config.driverPath; CUA Driver SDK is configured directly by OpenClaw.",
    ]);
    expect(result.config.plugins?.entries?.["cua-computer"]).toEqual({
      enabled: true,
      config: {},
    });
    expect(config.plugins?.entries?.["cua-computer"]?.config).toEqual({
      driverPath: "/usr/local/bin/cua-driver",
    });
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });
});
