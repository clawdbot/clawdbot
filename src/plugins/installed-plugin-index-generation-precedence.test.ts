// Covers loader precedence between a plugin's flat project dir and newer
// `__openclaw-generation__` dirs when reconciling persisted install records.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
  loadInstalledPluginIndexInstallRecordsSync,
  writePersistedInstalledPluginIndexInstallRecords,
} from "./installed-plugin-index-records.js";
import {
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallPackageInfo,
} from "./managed-npm-retention.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const PACKAGE_NAME = "@openclaw/discord";
const PLUGIN_ID = "discord";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeStateDir(): string {
  return tempDirs.make("openclaw-plugin-generation-precedence-");
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

/** Writes a managed plugin version into an `__openclaw-generation__` dir. */
function writeManagedGeneration(params: {
  stateDir: string;
  version: string;
  generationKey: string;
}): string {
  const npmDir = path.join(params.stateDir, "npm");
  writeManagedNpmPlugin({
    stateDir: params.stateDir,
    packageName: PACKAGE_NAME,
    pluginId: PLUGIN_ID,
    version: params.version,
  });
  const flatProjectRoot = resolvePluginNpmProjectDir({ npmDir, packageName: PACKAGE_NAME });
  const generationProjectRoot = resolvePluginNpmGenerationProjectDir({
    npmDir,
    packageName: PACKAGE_NAME,
    generationKey: params.generationKey,
  });
  fs.renameSync(flatProjectRoot, generationProjectRoot);
  return path.join(generationProjectRoot, "node_modules", ...PACKAGE_NAME.split("/"));
}

/** Writes a managed plugin version into the flat project dir and leaves it there. */
function writeManagedFlat(stateDir: string, version: string): string {
  const npmDir = path.join(stateDir, "npm");
  writeManagedNpmPlugin({ stateDir, packageName: PACKAGE_NAME, pluginId: PLUGIN_ID, version });
  const flatProjectRoot = resolvePluginNpmProjectDir({ npmDir, packageName: PACKAGE_NAME });
  return path.join(flatProjectRoot, "node_modules", ...PACKAGE_NAME.split("/"));
}

function writeManagedLegacy(stateDir: string, version: string): string {
  return writeManagedNpmPlugin({
    stateDir,
    packageName: PACKAGE_NAME,
    pluginId: PLUGIN_ID,
    version,
    layout: "legacy",
  });
}

function setInstallTimestamp(packageDir: string, timestampMs: number): void {
  const packageInfo = resolveRetainedManagedNpmInstallPackageInfo(packageDir);
  if (!packageInfo) {
    throw new Error(`Expected managed npm package dir: ${packageDir}`);
  }
  const timestamp = new Date(timestampMs);
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

describe("managed npm generation-dir loader precedence", () => {
  it("loads the authoritative generation after an upgrade leaves the old flat install", async () => {
    const stateDir = makeStateDir();
    const staleVersion = "2026.6.11";
    const activeVersion = "2026.7.1";

    const activePackageDir = writeManagedGeneration({
      stateDir,
      version: activeVersion,
      generationKey: `discord-${activeVersion}`,
    });
    // Recreate the prior version at the flat project dir so it is still present
    // on disk (the case `isUnavailableManagedNpmInstallRecord` does not cover).
    const stalePackageDir = writeManagedFlat(stateDir, staleVersion);

    await writePersistedInstalledPluginIndexInstallRecords(
      {
        discord: {
          source: "npm",
          spec: `${PACKAGE_NAME}@latest`,
          installPath: activePackageDir,
          version: activeVersion,
          resolvedName: PACKAGE_NAME,
          resolvedVersion: activeVersion,
          resolvedSpec: `${PACKAGE_NAME}@${activeVersion}`,
          integrity: "sha512-active",
        },
      },
      { stateDir, candidates: [] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded.discord, {
      source: "npm",
      spec: `${PACKAGE_NAME}@latest`,
      installPath: activePackageDir,
      version: activeVersion,
      resolvedName: PACKAGE_NAME,
      resolvedVersion: activeVersion,
      resolvedSpec: `${PACKAGE_NAME}@${activeVersion}`,
      integrity: "sha512-active",
    });
    expect(fs.existsSync(stalePackageDir)).toBe(true);

    clearLoadInstalledPluginIndexInstallRecordsCache();
    expectRecordFields(loadInstalledPluginIndexInstallRecordsSync({ stateDir }).discord, {
      installPath: activePackageDir,
      resolvedVersion: activeVersion,
    });
  });

  it("preserves an intentional downgrade when a newer generation lingers", async () => {
    const stateDir = makeStateDir();
    const newerPackageDir = writeManagedGeneration({
      stateDir,
      version: "3.0.0",
      generationKey: "discord-three",
    });
    const downgradedPackageDir = writeManagedFlat(stateDir, "1.0.0");

    await writePersistedInstalledPluginIndexInstallRecords(
      {
        discord: {
          source: "npm",
          spec: `${PACKAGE_NAME}@1.0.0`,
          installPath: downgradedPackageDir,
          version: "1.0.0",
          resolvedName: PACKAGE_NAME,
          resolvedVersion: "1.0.0",
          resolvedSpec: `${PACKAGE_NAME}@1.0.0`,
        },
      },
      { stateDir, candidates: [] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded.discord, {
      installPath: downgradedPackageDir,
      resolvedVersion: "1.0.0",
    });
    expect(fs.existsSync(newerPackageDir)).toBe(true);
  });

  it("matches the authoritative generation case-insensitively on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const stateDir = makeStateDir();
    const newerPackageDir = writeManagedGeneration({
      stateDir,
      version: "3.0.0",
      generationKey: "discord-newer-on-windows",
    });
    const downgradedPackageDir = writeManagedFlat(stateDir, "1.0.0");
    setInstallTimestamp(downgradedPackageDir, Date.UTC(2026, 0, 1));
    setInstallTimestamp(newerPackageDir, Date.UTC(2026, 0, 2));
    const differentlyCasedActivePath = downgradedPackageDir.replace(
      stateDir,
      stateDir.toUpperCase(),
    );

    await writePersistedInstalledPluginIndexInstallRecords(
      {
        discord: {
          source: "npm",
          spec: `${PACKAGE_NAME}@1.0.0`,
          installPath: differentlyCasedActivePath,
          version: "1.0.0",
          resolvedName: PACKAGE_NAME,
          resolvedVersion: "1.0.0",
          resolvedSpec: `${PACKAGE_NAME}@1.0.0`,
        },
      },
      { stateDir, candidates: [] },
    );
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded.discord, {
      installPath: differentlyCasedActivePath,
      resolvedVersion: "1.0.0",
    });
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it("uses install recency with a structured warning when no authority exists", async () => {
    const stateDir = makeStateDir();
    const recentPackageDir = writeManagedGeneration({
      stateDir,
      version: "1.0.0",
      generationKey: "discord-recent",
    });
    const olderPackageDir = writeManagedFlat(stateDir, "9.0.0");
    setInstallTimestamp(olderPackageDir, Date.UTC(2026, 0, 1));
    setInstallTimestamp(recentPackageDir, Date.UTC(2026, 0, 2));
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded.discord, {
      installPath: recentPackageDir,
      resolvedVersion: "1.0.0",
    });
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining("without an authoritative active path"),
      expect.objectContaining({
        code: "OPENCLAW_PLUGIN_INSTALL_RECOVERY_FALLBACK",
        type: "OpenClawPluginRecoveryWarning",
      }),
    );
  });

  it("warns when install recency replaces a dangling managed authority", async () => {
    const stateDir = makeStateDir();
    const npmDir = path.join(stateDir, "npm");
    const recentPackageDir = writeManagedGeneration({
      stateDir,
      version: "1.0.0",
      generationKey: "discord-recent-after-dangling",
    });
    const olderPackageDir = writeManagedFlat(stateDir, "9.0.0");
    setInstallTimestamp(olderPackageDir, Date.UTC(2026, 0, 1));
    setInstallTimestamp(recentPackageDir, Date.UTC(2026, 0, 2));
    const missingPackageDir = path.join(
      resolvePluginNpmGenerationProjectDir({
        npmDir,
        packageName: PACKAGE_NAME,
        generationKey: "discord-missing",
      }),
      "node_modules",
      ...PACKAGE_NAME.split("/"),
    );
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        discord: {
          source: "npm",
          spec: `${PACKAGE_NAME}@latest`,
          installPath: missingPackageDir,
          resolvedName: PACKAGE_NAME,
          resolvedVersion: "2.0.0",
        },
      },
      { stateDir, candidates: [] },
    );
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded.discord, {
      installPath: recentPackageDir,
      resolvedVersion: "1.0.0",
    });
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining("without an authoritative active path"),
      expect.objectContaining({ code: "OPENCLAW_PLUGIN_INSTALL_RECOVERY_FALLBACK" }),
    );
  });

  it("does not treat unrelated legacy-root metadata changes as plugin recency", async () => {
    const stateDir = makeStateDir();
    const recentPackageDir = writeManagedGeneration({
      stateDir,
      version: "1.0.0",
      generationKey: "discord-recent-from-legacy",
    });
    const olderPackageDir = writeManagedLegacy(stateDir, "9.0.0");
    setInstallTimestamp(olderPackageDir, Date.UTC(2026, 0, 1));
    setInstallTimestamp(recentPackageDir, Date.UTC(2026, 0, 2));
    writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/unrelated",
      pluginId: "unrelated",
      version: "1.0.0",
      layout: "legacy",
    });
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded.discord, {
      installPath: recentPackageDir,
      resolvedVersion: "1.0.0",
    });
  });

  it("excludes doctor-retired generations when recovering without authority", async () => {
    const stateDir = makeStateDir();
    const retiredPackageDir = writeManagedGeneration({
      stateDir,
      version: "3.0.0",
      generationKey: "discord-retired",
    });
    const recoveredPackageDir = writeManagedFlat(stateDir, "1.0.0");
    await markRetainedManagedNpmInstall({
      packageDir: retiredPackageDir,
      pluginId: PLUGIN_ID,
      reason: "test-retired-generation",
    });

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded.discord, {
      installPath: recoveredPackageDir,
      resolvedVersion: "1.0.0",
    });
  });

  it("excludes a doctor-retired legacy-root package when recovering without authority", async () => {
    const stateDir = makeStateDir();
    const retiredPackageDir = writeManagedLegacy(stateDir, "3.0.0");
    const recoveredPackageDir = writeManagedGeneration({
      stateDir,
      version: "1.0.0",
      generationKey: "discord-after-retired-legacy",
    });
    await markRetainedManagedNpmInstall({
      packageDir: retiredPackageDir,
      pluginId: PLUGIN_ID,
      reason: "test-retired-legacy-root-package",
    });

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded.discord, {
      installPath: recoveredPackageDir,
      resolvedVersion: "1.0.0",
    });
  });

  it("does not repoint an intentional custom npm install outside the managed root", async () => {
    const stateDir = makeStateDir();
    // A managed generation with a higher version exists on disk...
    writeManagedGeneration({ stateDir, version: "2.0.0", generationKey: "discord-managed" });
    // ...but the persisted record points at a custom install outside the npm root.
    const customInstallPath = path.join(stateDir, "custom", "node_modules", "@openclaw", "discord");

    await writePersistedInstalledPluginIndexInstallRecords(
      {
        discord: {
          source: "npm",
          spec: `${PACKAGE_NAME}@beta`,
          installPath: customInstallPath,
          version: "1.0.0",
          resolvedName: PACKAGE_NAME,
          resolvedVersion: "1.0.0",
          resolvedSpec: `${PACKAGE_NAME}@1.0.0`,
          integrity: "sha512-custom",
        },
      },
      { stateDir, candidates: [] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded.discord, {
      source: "npm",
      spec: `${PACKAGE_NAME}@beta`,
      installPath: customInstallPath,
      resolvedVersion: "1.0.0",
      integrity: "sha512-custom",
    });
  });
});
