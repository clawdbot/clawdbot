import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  readBestEffortConfig,
  readConfigFileSnapshot,
  readSourceConfigBestEffort,
} from "./config.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";

describe("readBestEffortConfig", () => {
  it("does not restore suspicious direct edits from .bak during ordinary reads", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        meta: { lastTouchedAt: "2026-04-22T00:00:00.000Z" },
        update: { channel: "beta" },
        gateway: { mode: "local" },
      });
      await fs.copyFile(configPath, `${configPath}.bak`);
      const directEditRaw = `${JSON.stringify({ update: { channel: "beta" } }, null, 2)}\n`;
      await fs.writeFile(configPath, directEditRaw, "utf-8");

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.sourceConfig).toEqual({ update: { channel: "beta" } });
      expect(await fs.readFile(configPath, "utf-8")).toBe(directEditRaw);
      const entries = await fs.readdir(`${home}/.openclaw`);
      expect(entries.some((entry) => entry.startsWith("openclaw.json.clobbered."))).toBe(false);
    });
  });

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
