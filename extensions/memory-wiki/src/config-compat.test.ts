import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import {
  legacyConfigRules,
  migrateMemoryWikiLegacyConfig,
  normalizeCompatibilityConfig,
} from "./config-compat.js";

describe("memory-wiki config compatibility", () => {
  it("detects the legacy bridge artifact toggle", () => {
    expect(
      legacyConfigRules[0]?.match({
        readMemoryCore: true,
      }),
    ).toBe(true);
  });

  it("migrates readMemoryCore to readMemoryArtifacts", () => {
    const config = {
      plugins: {
        entries: {
          "memory-wiki": {
            config: {
              bridge: {
                enabled: true,
                readMemoryCore: false,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const migration = migrateMemoryWikiLegacyConfig(config);

    expect(migration?.changes).toEqual([
      "Moved plugins.entries.memory-wiki.config.bridge.readMemoryCore → plugins.entries.memory-wiki.config.bridge.readMemoryArtifacts.",
    ]);
    expect(
      (
        migration?.config.plugins?.entries?.["memory-wiki"] as {
          config?: { bridge?: Record<string, unknown> };
        }
      ).config?.bridge,
    ).toEqual({
      enabled: true,
      readMemoryArtifacts: false,
    });
  });

  it("keeps the canonical bridge toggle when both keys are present", () => {
    const config = {
      plugins: {
        entries: {
          "memory-wiki": {
            config: {
              bridge: {
                readMemoryCore: false,
                readMemoryArtifacts: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const migration = normalizeCompatibilityConfig({ cfg: config });

    expect(migration.changes).toEqual([
      "Removed legacy plugins.entries.memory-wiki.config.bridge.readMemoryCore; kept explicit plugins.entries.memory-wiki.config.bridge.readMemoryArtifacts.",
    ]);
    expect(
      (
        migration.config.plugins?.entries?.["memory-wiki"] as {
          config?: { bridge?: Record<string, unknown> };
        }
      ).config?.bridge,
    ).toEqual({
      readMemoryArtifacts: true,
    });
  });
});
