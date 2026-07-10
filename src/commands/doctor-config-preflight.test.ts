// Doctor config preflight tests cover last-known-good snapshots and config snapshot promotion.
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { promoteConfigSnapshotToLastKnownGood, readConfigFileSnapshot } from "../config/config.js";
import { withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  runDoctorConfigPreflight,
  shouldSkipPluginValidationForDoctorConfigPreflight,
} from "./doctor-config-preflight.js";

type ConfigHealthDatabase = Pick<OpenClawStateKyselyDatabase, "config_health_entries">;

function readConfigHealthRow(env: NodeJS.ProcessEnv, configPath: string) {
  const { db } = openOpenClawStateDatabase({ env });
  const healthDb = getNodeSqliteKysely<ConfigHealthDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    healthDb
      .selectFrom("config_health_entries")
      .select("config_path")
      .where("config_path", "=", configPath),
  );
}

describe("runDoctorConfigPreflight", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("supports non-observing config reads", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, { gateway: { mode: "local" } });

      await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        observe: false,
      });

      expect(readConfigHealthRow({ ...process.env, HOME: home }, configPath)).toBeUndefined();
    });
  });

  it("skips plugin schema validation while doctor is running inside update", () => {
    expect(
      shouldSkipPluginValidationForDoctorConfigPreflight({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      shouldSkipPluginValidationForDoctorConfigPreflight({
        OPENCLAW_UPDATE_IN_PROGRESS: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      shouldSkipPluginValidationForDoctorConfigPreflight({
        OPENCLAW_UPDATE_IN_PROGRESS: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

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

  it("does not restore last-known-good for stale plugins.deny entries", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", port: 19091 },
      });
      await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot());
      const currentConfig = {
        gateway: { mode: "local", port: 19092 },
        plugins: { deny: ["missing-deny"] },
      };
      await fs.writeFile(configPath, `${JSON.stringify(currentConfig, null, 2)}\n`, "utf-8");

      const repaired = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      });

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.port).toBe(19092);
      expect(repaired.snapshot.config.plugins?.deny).toEqual(["missing-deny"]);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"missing-deny"');
    });
  });

  it("restores last-known-good for malformed plugin policy values", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", port: 19091 },
      });
      await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot());
      const lastGoodRaw = await fs.readFile(configPath, "utf-8");
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 19092 }, plugins: { deny: "bad" } }, null, 2)}\n`,
        "utf-8",
      );

      const repaired = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      });

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.port).toBe(19091);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(lastGoodRaw);
    });
  });
});
