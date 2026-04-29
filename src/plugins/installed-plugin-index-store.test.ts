import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginCandidate } from "./discovery.js";
import {
  inspectPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndex,
  refreshPersistedInstalledPluginIndex,
  resolveInstalledPluginIndexStorePath,
  writePersistedInstalledPluginIndex,
} from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-installed-plugin-index-store", tempDirs);
}

function createIndex(overrides: Partial<InstalledPluginIndex> = {}): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    installRecords: {},
    plugins: [
      {
        pluginId: "demo",
        manifestPath: "/plugins/demo/openclaw.plugin.json",
        manifestHash: "manifest-hash",
        rootDir: "/plugins/demo",
        origin: "global",
        enabled: true,
        syntheticAuthRefs: ["demo"],
        startup: {
          sidecar: false,
          memory: false,
          deferConfiguredChannelFullLoadUntilAfterListen: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

function createCandidate(rootDir: string): PluginCandidate {
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load while persisting installed plugin index');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "demo",
      name: "Demo",
      configSchema: { type: "object" },
      providers: ["demo"],
    }),
    "utf8",
  );
  return {
    idHint: "demo",
    source: path.join(rootDir, "index.ts"),
    rootDir,
    origin: "global",
  };
}

describe("installed plugin index persistence", () => {
  it("resolves the persisted index path under the state plugins directory", () => {
    const stateDir = makeTempDir();

    expect(resolveInstalledPluginIndexStorePath({ stateDir })).toBe(
      path.join(stateDir, "plugins", "installs.json"),
    );
  });

  it("writes and reads the installed plugin index atomically", async () => {
    const stateDir = makeTempDir();
    const filePath = resolveInstalledPluginIndexStorePath({ stateDir });
    const index = createIndex();

    await expect(writePersistedInstalledPluginIndex(index, { stateDir })).resolves.toBe(filePath);

    const raw = fs.readFileSync(filePath, "utf8");
    expect(raw).toContain('"warning": "DO NOT EDIT.');
    expect(raw).toContain('"pluginId": "demo"');
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toMatchObject(index);
  });

  it("does not preserve prototype poison keys from persisted index JSON", async () => {
    const stateDir = makeTempDir();
    const filePath = resolveInstalledPluginIndexStorePath({ stateDir });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const index = createIndex({
      installRecords: {
        demo: {
          source: "npm",
          spec: "demo@1.0.0",
        },
      },
    });
    Object.defineProperty(index, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    Object.defineProperty(index.installRecords, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    fs.writeFileSync(filePath, JSON.stringify(index), "utf8");

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });

    expect(persisted).toMatchObject({
      plugins: [expect.objectContaining({ pluginId: "demo" })],
      installRecords: {
        demo: expect.objectContaining({ source: "npm" }),
      },
    });
    expect(Object.prototype.hasOwnProperty.call(persisted as object, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(persisted?.installRecords ?? {}, "__proto__")).toBe(
      false,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("returns null for missing or invalid persisted indexes", async () => {
    const stateDir = makeTempDir();
    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toBeNull();

    const filePath = resolveInstalledPluginIndexStorePath({ stateDir });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 999 }), "utf8");

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toBeNull();
  });

  it("rejects pre-migration persisted indexes so update can rebuild them", async () => {
    const stateDir = makeTempDir();
    const filePath = resolveInstalledPluginIndexStorePath({ stateDir });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const legacyIndex = createIndex();
    delete (legacyIndex as unknown as Record<string, unknown>).migrationVersion;
    fs.writeFileSync(filePath, JSON.stringify(legacyIndex), "utf8");

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toBeNull();
  });

  it("inspects missing, fresh, and stale persisted index state without loading runtime", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };

    await expect(
      inspectPersistedInstalledPluginIndex({ stateDir, candidates: [candidate], env }),
    ).resolves.toMatchObject({
      state: "missing",
      refreshReasons: ["missing"],
      persisted: null,
      current: {
        plugins: [expect.objectContaining({ pluginId: "demo" })],
      },
    });

    const current = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env,
    });

    await expect(
      inspectPersistedInstalledPluginIndex({ stateDir, candidates: [candidate], env }),
    ).resolves.toMatchObject({
      state: "fresh",
      refreshReasons: [],
      persisted: current,
      current: {
        plugins: [expect.objectContaining({ pluginId: "demo", enabled: true })],
      },
    });

    await expect(
      inspectPersistedInstalledPluginIndex({
        stateDir,
        candidates: [candidate],
        config: {
          plugins: {
            entries: {
              demo: {
                enabled: false,
              },
            },
          },
        },
        env,
      }),
    ).resolves.toMatchObject({
      state: "stale",
      refreshReasons: ["policy-changed"],
      persisted: current,
      current: {
        plugins: [expect.objectContaining({ pluginId: "demo", enabled: false })],
      },
    });

    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        configSchema: { type: "object" },
        providers: ["demo", "demo-next"],
      }),
      "utf8",
    );

    await expect(
      inspectPersistedInstalledPluginIndex({ stateDir, candidates: [candidate], env }),
    ).resolves.toMatchObject({
      state: "stale",
      refreshReasons: ["stale-manifest"],
      persisted: current,
      current: {
        plugins: [
          expect.objectContaining({
            pluginId: "demo",
          }),
        ],
      },
    });
  });

  it("refreshes and persists a rebuilt index without loading plugin runtime", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);

    const index = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
    });

    expect(index.refreshReason).toBe("manual");
    expect(index.plugins.map((plugin) => plugin.pluginId)).toEqual(["demo"]);
    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toMatchObject({
      refreshReason: "manual",
      plugins: [expect.objectContaining({ pluginId: "demo" })],
    });
  });

  it("preserves existing install records when refreshing the manifest cache", async () => {
    const stateDir = makeTempDir();
    await writePersistedInstalledPluginIndex(
      createIndex({
        installRecords: {
          missing: {
            source: "npm",
            spec: "missing-plugin@1.0.0",
            installPath: path.join(stateDir, "plugins", "missing"),
          },
        },
        plugins: [],
      }),
      { stateDir },
    );

    const index = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
    });

    expect(index).toMatchObject({
      installRecords: {
        missing: {
          source: "npm",
          spec: "missing-plugin@1.0.0",
          installPath: path.join(stateDir, "plugins", "missing"),
        },
      },
      plugins: [],
    });
    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toMatchObject({
      installRecords: {
        missing: {
          source: "npm",
          spec: "missing-plugin@1.0.0",
          installPath: path.join(stateDir, "plugins", "missing"),
        },
      },
      plugins: [],
    });
  });
});
