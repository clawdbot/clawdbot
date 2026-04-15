import { describe, expect, it } from "vitest";
import {
  readBestEffortConfig,
  readConfigFileSnapshot,
  readSourceConfigBestEffort,
} from "./config.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";

describe("readBestEffortConfig", () => {
  it("reuses valid snapshots while preserving load-time defaults", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        auth: {
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
        },
      });

      const snapshot = await readConfigFileSnapshot();
      const bestEffort = await readBestEffortConfig();

      expect(snapshot.config.agents?.defaults?.contextPruning?.mode).toBeUndefined();
      expect(snapshot.config.agents?.defaults?.compaction?.mode).toBeUndefined();

      expect(bestEffort.agents?.defaults?.contextPruning?.mode).toBe("cache-ttl");
      expect(bestEffort.agents?.defaults?.contextPruning?.ttl).toBe("1h");
      expect(bestEffort.agents?.defaults?.compaction?.mode).toBe("safeguard");
      expect(
        bestEffort.agents?.defaults?.models?.["anthropic/claude-opus-4-6"]?.params?.cacheRetention,
      ).toBe("short");
    });
  });
});

describe("readSourceConfigBestEffort", () => {
  it("preserves the authored source config without load-time defaults", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        auth: {
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
        },
      });

      const snapshot = await readConfigFileSnapshot();
      const sourceBestEffort = await readSourceConfigBestEffort();

      expect(sourceBestEffort).toEqual(snapshot.resolved);
      expect(sourceBestEffort.agents?.defaults?.contextPruning?.mode).toBeUndefined();
      expect(sourceBestEffort.agents?.defaults?.compaction?.mode).toBeUndefined();
    });
  });
});
