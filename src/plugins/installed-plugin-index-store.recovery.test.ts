// Covers policy refresh recovery from persisted plugin install records.
import fs from "node:fs";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-installed-plugin-index-recovery", tempDirs);
}

function createCandidate(rootDir: string, id: string): PluginCandidate {
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

function expectPluginFields(
  index: InstalledPluginIndex,
  pluginId: string,
  expected: Record<string, unknown>,
) {
  const plugin = index.plugins.find((candidate) => candidate.pluginId === pluginId);
  if (!plugin) {
    throw new Error(`Missing plugin ${pluginId}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    expect(plugin[key as keyof typeof plugin], key).toEqual(value);
  }
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

describe("installed plugin index policy recovery", () => {
  it("rebuilds policy refreshes when recoverable install records are missing from plugins", async () => {
    const stateDir = makeTempDir();
    const pathPluginDir = path.join(stateDir, "plugins", "path-demo");
    const npmPluginDir = path.join(stateDir, "plugins", "npm-demo");
    const sourceFallbackPluginDir = path.join(stateDir, "plugins", "source-fallback-demo");
    fs.mkdirSync(pathPluginDir, { recursive: true });
    fs.mkdirSync(npmPluginDir, { recursive: true });
    fs.mkdirSync(sourceFallbackPluginDir, { recursive: true });
    const pathCandidate = createCandidate(pathPluginDir, "path-demo");
    const npmCandidate = createCandidate(npmPluginDir, "npm-demo");
    const sourceFallbackCandidate = createCandidate(
      sourceFallbackPluginDir,
      "source-fallback-demo",
    );
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    let materializationCount = 0;
    const now = () => {
      materializationCount += 1;
      return new Date(1777118400000 + materializationCount);
    };
    const installRecords = {
      "path-demo": {
        source: "path" as const,
        sourcePath: pathPluginDir,
        installPath: pathPluginDir,
        spec: pathPluginDir,
      },
      "npm-demo": {
        source: "npm" as const,
        spec: "@vendor/npm-demo@1.2.3",
        installPath: npmPluginDir,
        resolvedName: "@vendor/npm-demo",
        resolvedVersion: "1.2.3",
      },
      "source-fallback-demo": {
        source: "path" as const,
        spec: sourceFallbackPluginDir,
        sourcePath: sourceFallbackPluginDir,
        installPath: "   ",
      },
    };
    const initial = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [pathCandidate, npmCandidate, sourceFallbackCandidate],
      env,
      installRecords,
      now,
    });
    await writePersistedInstalledPluginIndex(
      { ...initial, installRecords, plugins: [] },
      { stateDir },
    );

    materializationCount = 0;
    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      candidates: [pathCandidate, npmCandidate, sourceFallbackCandidate],
      env,
      config: {
        plugins: {
          entries: {
            "path-demo": { enabled: false },
            "npm-demo": { enabled: false },
            "source-fallback-demo": { enabled: false },
          },
        },
      },
      policyPluginIds: [],
      now,
    });

    expect(materializationCount).toBe(1);
    expectPluginIds(refreshed, ["path-demo", "npm-demo", "source-fallback-demo"]);
    expectPluginFields(refreshed, "path-demo", { enabled: false });
    expectPluginFields(refreshed, "npm-demo", { enabled: false });
    expectPluginFields(refreshed, "source-fallback-demo", { enabled: false });
    expectInstallRecord(refreshed, "path-demo", { source: "path", installPath: pathPluginDir });
    expectInstallRecord(refreshed, "npm-demo", { source: "npm", installPath: npmPluginDir });
    expectInstallRecord(refreshed, "source-fallback-demo", {
      source: "path",
      sourcePath: sourceFallbackPluginDir,
    });
  });

  it("rebuilds linked local TypeScript records through the normal discovery path", async () => {
    const stateDir = makeTempDir();
    const bundledDir = path.join(stateDir, "bundled");
    const pluginDir = path.join(stateDir, "plugins", "linked-source");
    fs.mkdirSync(path.join(pluginDir, "src"), { recursive: true });
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@vendor/linked-source",
        openclaw: { extensions: ["./src/index.ts"] },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({ id: "linked-source", configSchema: { type: "object" } }),
      "utf8",
    );
    fs.writeFileSync(path.join(pluginDir, "src", "index.ts"), "export default {};", "utf8");
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_HOME: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const installRecords = {
      "linked-source": {
        source: "path" as const,
        sourcePath: pluginDir,
        installPath: pluginDir,
        spec: pluginDir,
      },
    };
    await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      env,
      installRecords,
    });
    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      env,
      policyPluginIds: [],
    });
    expectPluginIds(refreshed, ["linked-source"]);
  });

  it("keeps policy refreshes on the fast path for unavailable install records", async () => {
    const stateDir = makeTempDir();
    const missingPluginDir = path.join(stateDir, "plugins", "missing");
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const installRecords = {
      missing: {
        source: "npm" as const,
        spec: "missing-plugin@1.0.0",
        installPath: missingPluginDir,
      },
    };
    await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      diagnostics: [{ level: "warn", message: "policy fast-path sentinel" }],
      env,
      installRecords,
    });
    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      env,
      policyPluginIds: [],
    });
    expectPluginIds(refreshed, []);
    expectInstallRecord(refreshed, "missing", {
      source: "npm",
      spec: "missing-plugin@1.0.0",
      installPath: missingPluginDir,
    });
    expect(refreshed.diagnostics).toEqual([
      { level: "warn", message: "policy fast-path sentinel" },
    ]);
  });

  describe("scan-free policy refresh on the normal no-candidate caller path", () => {
    afterEach(() => {
      vi.doUnmock("./discovery.js");
      vi.resetModules();
    });

    it("skips broad discovery for missing and invalid bundle records", async () => {
      const stateDir = makeTempDir();
      const env = {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
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
        "./installed-plugin-index-store.js?case=scan-free-policy-refresh",
      );
      const missingPluginDir = path.join(stateDir, "plugins", "missing");
      const invalidBundleDir = path.join(stateDir, "plugins", "invalid-bundle");
      fs.mkdirSync(path.join(invalidBundleDir, ".codex-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(invalidBundleDir, ".codex-plugin", "plugin.json"),
        "'still not an object'",
        "utf8",
      );
      const installRecords = {
        missing: {
          source: "npm" as const,
          spec: "missing-plugin@1.0.0",
          installPath: missingPluginDir,
        },
        "invalid-bundle": {
          source: "npm" as const,
          spec: "invalid-bundle@1.0.0",
          installPath: invalidBundleDir,
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
      expectInstallRecord(refreshed, "missing", {
        source: "npm",
        spec: "missing-plugin@1.0.0",
        installPath: missingPluginDir,
      });
      expectInstallRecord(refreshed, "invalid-bundle", {
        source: "npm",
        spec: "invalid-bundle@1.0.0",
        installPath: invalidBundleDir,
      });
      expect(refreshed.diagnostics).toEqual([
        { level: "warn", message: "policy fast-path sentinel" },
      ]);
    });

    it("skips broad discovery for an ordinary record with a malformed manifest", async () => {
      const stateDir = makeTempDir();
      const env = {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
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
        "./installed-plugin-index-store.js?case=malformed-ordinary-manifest",
      );
      const pluginDir = path.join(stateDir, "plugins", "malformed-ordinary");
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, "index.ts"), "export default {};", "utf8");
      fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), "{ malformed", "utf8");
      const installRecords = {
        "malformed-ordinary": {
          source: "npm" as const,
          spec: "malformed-ordinary@1.0.0",
          installPath: pluginDir,
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
      expectInstallRecord(refreshed, "malformed-ordinary", {
        source: "npm",
        spec: "malformed-ordinary@1.0.0",
        installPath: pluginDir,
      });
      expect(refreshed.diagnostics).toEqual([
        { level: "warn", message: "policy fast-path sentinel" },
      ]);
    });
  });
});
