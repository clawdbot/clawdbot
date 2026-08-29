import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "../plugins/installed-plugin-index-records.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { maybeRepairPluginRegistryState } from "./doctor-plugin-registry.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  clearLoadInstalledPluginIndexInstallRecordsCache();
});

function createIndex(installPath: string): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    installRecords: {
      demo: {
        source: "path",
        installPath,
      },
    },
    plugins: [],
    diagnostics: [],
  };
}

async function readRequiredIndex(stateDir: string): Promise<InstalledPluginIndex> {
  const persisted = await readPersistedInstalledPluginIndex({ stateDir });
  if (!persisted) {
    throw new Error("Expected persisted installed plugin index");
  }
  return persisted;
}

describe("Doctor plugin registry cache boundary", () => {
  it("does not roll back install records cached before an earlier Doctor repair", async () => {
    const stateDir = tempDirs.make("openclaw-doctor-plugin-registry-cache-");
    const oldInstallPath = path.join(stateDir, "plugins", "demo-old");
    const freshInstallPath = path.join(stateDir, "plugins", "demo-fresh");
    fs.mkdirSync(oldInstallPath, { recursive: true });
    fs.mkdirSync(freshInstallPath, { recursive: true });

    await writePersistedInstalledPluginIndex(createIndex(oldInstallPath), { stateDir });
    const staleDoctorCache = createPluginCache();
    await withPluginCache(staleDoctorCache, () => readRequiredIndex(stateDir));

    await withPluginCache(createPluginCache(), () =>
      writePersistedInstalledPluginIndex(createIndex(freshInstallPath), { stateDir }),
    );

    await withPluginCache(staleDoctorCache, () =>
      maybeRepairPluginRegistryState({
        stateDir,
        candidates: [],
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_VERSION: "2026.4.25",
          VITEST: "true",
        },
        config: {},
        prompter: { shouldRepair: true },
      }),
    );

    const persisted = await withPluginCache(createPluginCache(), () => readRequiredIndex(stateDir));
    expect(persisted.refreshReason).toBe("migration");
    expect(persisted.installRecords.demo?.installPath).toBe(freshInstallPath);
  });
});
