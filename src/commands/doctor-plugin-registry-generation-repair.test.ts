import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "../plugins/install-paths.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  readPersistedInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../plugins/installed-plugin-index-records.js";
import {
  cleanupRetainedManagedNpmInstallGenerations,
  hasRetainedManagedNpmInstallMarker,
  resolveRetainedManagedNpmInstallPackageInfo,
} from "../plugins/managed-npm-retention.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { maybeRepairStaleManagedNpmInstallGenerations } from "./doctor-plugin-generations.js";
import { maybeRepairPluginRegistryState } from "./doctor-plugin-registry.js";

const PACKAGE_NAME = "@proof/openclaw-generation";
const PLUGIN_ID = "generation-proof";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeStateDir(): string {
  return tempDirs.make("openclaw-doctor-plugin-generation-");
}

function writeManagedFlat(stateDir: string, version: string): string {
  const npmDir = path.join(stateDir, "npm");
  writeManagedNpmPlugin({ stateDir, packageName: PACKAGE_NAME, pluginId: PLUGIN_ID, version });
  return path.join(
    resolvePluginNpmProjectDir({ npmDir, packageName: PACKAGE_NAME }),
    "node_modules",
    ...PACKAGE_NAME.split("/"),
  );
}

function writeManagedGeneration(stateDir: string, version: string): string {
  const npmDir = path.join(stateDir, "npm");
  writeManagedNpmPlugin({ stateDir, packageName: PACKAGE_NAME, pluginId: PLUGIN_ID, version });
  const flatProjectRoot = resolvePluginNpmProjectDir({ npmDir, packageName: PACKAGE_NAME });
  const generationProjectRoot = resolvePluginNpmGenerationProjectDir({
    npmDir,
    packageName: PACKAGE_NAME,
    generationKey: `${PACKAGE_NAME}@${version}`,
  });
  fs.renameSync(flatProjectRoot, generationProjectRoot);
  return path.join(generationProjectRoot, "node_modules", ...PACKAGE_NAME.split("/"));
}

function setInstallTimestamp(packageDir: string, timestamp: Date): void {
  const packageInfo = resolveRetainedManagedNpmInstallPackageInfo(packageDir);
  if (!packageInfo) {
    throw new Error(`Expected managed npm package dir: ${packageDir}`);
  }
  fs.utimesSync(path.join(packageDir, "package.json"), timestamp, timestamp);
  fs.utimesSync(packageDir, timestamp, timestamp);
  fs.utimesSync(path.join(packageInfo.projectRoot, "package.json"), timestamp, timestamp);
  fs.utimesSync(packageInfo.projectRoot, timestamp, timestamp);
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  clearLoadInstalledPluginIndexInstallRecordsCache();
});

describe("doctor managed npm generation repair", () => {
  it("retires the stale flat install and prunes it after gateway shutdown", async () => {
    const stateDir = makeStateDir();
    const npmDir = path.join(stateDir, "npm");
    const activePackageDir = writeManagedGeneration(stateDir, "2026.7.1");
    const stalePackageDir = writeManagedFlat(stateDir, "2026.6.11");
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        [PLUGIN_ID]: {
          source: "npm",
          spec: `${PACKAGE_NAME}@latest`,
          installPath: activePackageDir,
          resolvedName: PACKAGE_NAME,
          resolvedSpec: `${PACKAGE_NAME}@2026.7.1`,
          resolvedVersion: "2026.7.1",
          version: "2026.7.1",
        },
      },
      { stateDir, candidates: [] },
    );

    await expect(
      maybeRepairStaleManagedNpmInstallGenerations({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        prompter: { shouldRepair: true },
        stateDir,
      }),
    ).resolves.toBe(true);
    expect(hasRetainedManagedNpmInstallMarker(stalePackageDir)).toBe(true);
    expect(hasRetainedManagedNpmInstallMarker(activePackageDir)).toBe(false);

    await expect(
      cleanupRetainedManagedNpmInstallGenerations({
        activeInstallPaths: [activePackageDir],
        npmDir,
      }),
    ).resolves.toBe(1);
    expect(fs.existsSync(stalePackageDir)).toBe(false);
    expect(fs.existsSync(activePackageDir)).toBe(true);
  });

  it("persists the recency fallback when no authoritative record exists", async () => {
    const stateDir = makeStateDir();
    const activePackageDir = writeManagedGeneration(stateDir, "1.0.0");
    const stalePackageDir = writeManagedFlat(stateDir, "9.0.0");
    const activeTimestamp = new Date("2026-01-02T00:00:00.000Z");
    const staleTimestamp = new Date("2026-01-01T00:00:00.000Z");
    setInstallTimestamp(activePackageDir, activeTimestamp);
    setInstallTimestamp(stalePackageDir, staleTimestamp);
    await writePersistedInstalledPluginIndexInstallRecords({}, { stateDir, candidates: [] });
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    await maybeRepairPluginRegistryState({
      config: {
        plugins: {
          allow: [PLUGIN_ID],
          entries: { [PLUGIN_ID]: { enabled: true } },
        },
      },
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      prompter: { shouldRepair: true },
      stateDir,
    });

    const persisted = await readPersistedInstalledPluginIndexInstallRecords({ stateDir });
    expect(persisted?.[PLUGIN_ID]?.installPath).toBe(activePackageDir);
    expect(hasRetainedManagedNpmInstallMarker(stalePackageDir)).toBe(true);
    expect(hasRetainedManagedNpmInstallMarker(activePackageDir)).toBe(false);
  });
});
