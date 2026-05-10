import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { promoteConfigSnapshotToLastKnownGood, readConfigFileSnapshot } from "../config/config.js";
import { withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";

describe("runDoctorConfigPreflight", () => {
  it("collects legacy config issues outside the normal config read path", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        memorySearch: {
          provider: "local",
          fallback: "none",
        },
      });

      const preflight = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
      });

      expect(preflight.snapshot.valid).toBe(false);
      expect(preflight.snapshot.legacyIssues.map((issue) => issue.path)).toContain("memorySearch");
      const memorySearch = (
        preflight.baseConfig as {
          memorySearch?: { provider?: unknown; fallback?: unknown };
        }
      ).memorySearch;
      expect(memorySearch?.provider).toBe("local");
      expect(memorySearch?.fallback).toBe("none");
    });
  });

  it("restores invalid config from last-known-good only during repair preflight", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", port: 19091 },
      });
      await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot());
      const lastGoodRaw = await fs.readFile(configPath, "utf-8");
      await fs.writeFile(configPath, "{ invalid json", "utf-8");

      const inspectOnly = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
      });
      expect(inspectOnly.snapshot.valid).toBe(false);

      const repaired = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      });

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.mode).toBe("local");
      expect(await fs.readFile(configPath, "utf-8")).toBe(lastGoodRaw);
    });
  });
});
