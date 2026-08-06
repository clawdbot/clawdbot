// Covers policy refresh recovery boundaries that should not cross install-record ownership.
import fs from "node:fs";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { PluginCandidate } from "./discovery.js";
import {
  refreshPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndex,
} from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.doUnmock("./discovery.js");
  vi.resetModules();
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-installed-plugin-index-recovery-boundary", tempDirs);
}

function createCandidate(rootDir: string, id: string): PluginCandidate {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load while persisting installed plugin index');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({ id, configSchema: { type: "object" } }),
    "utf8",
  );
  return { idHint: id, source: path.join(rootDir, "index.ts"), rootDir, origin: "global" };
}

function expectPluginIds(index: InstalledPluginIndex, expected: string[]) {
  expect(index.plugins.map((plugin) => plugin.pluginId)).toEqual(expected);
}

function expectInstallRecord(
  index: InstalledPluginIndex,
  pluginId: string,
  expected: Record<string, unknown>,
) {
  const record = index.installRecords[pluginId];
  if (!record) {
    throw new Error(`Missing install record ${pluginId}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key as keyof typeof record], key).toEqual(value);
  }
}

function createPathRecord(pluginDir: string): PluginInstallRecord {
  return {
    source: "path",
    sourcePath: pluginDir,
    installPath: pluginDir,
    spec: pluginDir,
  };
}

describe("installed plugin index policy recovery boundaries", () => {
  it("does not retain unrelated auto-discovered candidates for stale records", async () => {
    const stateDir = makeTempDir();
    const existingDir = path.join(stateDir, "plugins", "existing");
    const recoveredDir = path.join(stateDir, "plugins", "recovered");
    const autoDir = path.join(stateDir, "global", "auto-discovered");
    const staleRecordDir = path.join(stateDir, "plugins", "stale-auto-discovered");
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const existingCandidate = createCandidate(existingDir, "existing");
    const recoveredCandidate = createCandidate(recoveredDir, "recovered");
    const autoCandidate = createCandidate(autoDir, "auto-discovered");
    const installRecords = {
      existing: createPathRecord(existingDir),
      recovered: createPathRecord(recoveredDir),
      "auto-discovered": {
        source: "npm" as const,
        spec: "auto-discovered@1.0.0",
        installPath: staleRecordDir,
      },
    };
    const initial = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [existingCandidate, recoveredCandidate],
      env,
      installRecords,
    });
    await writePersistedInstalledPluginIndex(
      {
        ...initial,
        installRecords,
        plugins: initial.plugins.filter((plugin) => plugin.pluginId === "existing"),
      },
      { stateDir },
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      candidates: [recoveredCandidate, autoCandidate],
      env,
      policyPluginIds: [],
    });

    expectPluginIds(refreshed, ["existing", "recovered"]);
    expectInstallRecord(refreshed, "auto-discovered", {
      source: "npm",
      spec: "auto-discovered@1.0.0",
      installPath: staleRecordDir,
    });
  });

  it("skips broad discovery for an external bundle rejected by plugin API", async () => {
    const stateDir = makeTempDir();
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.27-beta.1",
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const discoverSpy = vi.fn(() => ({ candidates: [], diagnostics: [] }));
    vi.resetModules();
    vi.doMock("./discovery.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./discovery.js")>();
      return { ...actual, discoverOpenClawPlugins: discoverSpy };
    });
    const store = await importFreshModule<typeof import("./installed-plugin-index-store.js")>(
      import.meta.url,
      "./installed-plugin-index-store.js?case=incompatible-bundle-plugin-api",
    );
    const bundleDir = path.join(stateDir, "plugins", "future-bundle");
    fs.mkdirSync(path.join(bundleDir, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(bundleDir, "package.json"),
      JSON.stringify({
        name: "@vendor/future-bundle",
        openclaw: {
          compat: { pluginApi: ">=2026.5.27-beta.2" },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(bundleDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "future bundle", skills: "skills" }),
      "utf8",
    );
    const installRecords = {
      "future-bundle": {
        source: "npm" as const,
        spec: "future-bundle@1.0.0",
        installPath: bundleDir,
      },
    };
    await store.refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      diagnostics: [{ level: "warn", message: "policy fast-path sentinel" }],
      env,
      installRecords,
    });
    discoverSpy.mockClear();

    const refreshed = await store.refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      env,
      policyPluginIds: [],
    });

    expect(discoverSpy).not.toHaveBeenCalled();
    expectPluginIds(refreshed, []);
    expectInstallRecord(refreshed, "future-bundle", {
      source: "npm",
      spec: "future-bundle@1.0.0",
      installPath: bundleDir,
    });
    expect(refreshed.diagnostics).toEqual([
      { level: "warn", message: "policy fast-path sentinel" },
    ]);
  });
});
