import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginCandidate } from "../plugins/discovery.js";
import {
  readPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndex,
} from "../plugins/installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import { note } from "../terminal/note.js";
import { maybeRepairPluginRegistryState } from "./doctor-plugin-registry.js";
import { DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV } from "./doctor/shared/plugin-registry-migration.js";

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

const tempDirs: string[] = [];

afterEach(() => {
  vi.mocked(note).mockReset();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-doctor-plugin-registry", tempDirs);
}

async function readRequiredPersistedInstalledPluginIndex(
  stateDir: string,
): Promise<InstalledPluginIndex> {
  const persisted = await readPersistedInstalledPluginIndex({ stateDir });
  if (!persisted) {
    throw new Error("Expected persisted installed plugin index");
  }
  return persisted;
}

function hermeticEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_VERSION: "2026.4.25",
    VITEST: "true",
    ...overrides,
  };
}

function createCandidate(rootDir: string, id = "demo"): PluginCandidate {
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load during doctor registry repair');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      name: id,
      configSchema: { type: "object" },
      providers: [id],
    }),
    "utf8",
  );
  return {
    idHint: id,
    source: path.join(rootDir, "index.ts"),
    rootDir,
    origin: "global",
  };
}

function createBundledCandidate(params: {
  rootDir: string;
  id: string;
  packageName: string;
  version: string;
}): PluginCandidate {
  fs.writeFileSync(
    path.join(params.rootDir, "index.ts"),
    "throw new Error('runtime entry should not load during doctor registry repair');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(params.rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.id,
      name: params.id,
      configSchema: { type: "object" },
      providers: [params.id],
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(params.rootDir, "package.json"),
    JSON.stringify({
      name: params.packageName,
      version: params.version,
    }),
    "utf8",
  );
  return {
    idHint: params.id,
    source: path.join(params.rootDir, "index.ts"),
    rootDir: params.rootDir,
    origin: "bundled",
    packageName: params.packageName,
    packageVersion: params.version,
  };
}

function createManagedNpmPlugin(params: {
  stateDir: string;
  id: string;
  packageName: string;
  version: string;
  peerDependencies?: Record<string, string>;
  packageLock?: boolean;
}) {
  const npmRoot = path.join(params.stateDir, "npm");
  const packageDir = path.join(npmRoot, "node_modules", params.packageName);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(npmRoot, "package.json"),
    JSON.stringify({
      dependencies: {
        [params.packageName]: params.version,
      },
    }),
    "utf8",
  );
  if (params.packageLock) {
    fs.writeFileSync(
      path.join(npmRoot, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": {
            dependencies: {
              [params.packageName]: params.version,
              "other-plugin": "1.0.0",
            },
          },
          [`node_modules/${params.packageName}`]: {
            version: params.version,
          },
          "node_modules/other-plugin": {
            version: "1.0.0",
          },
        },
        dependencies: {
          [params.packageName]: {
            version: params.version,
          },
          "other-plugin": {
            version: "1.0.0",
          },
        },
      }),
      "utf8",
    );
  }
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: params.packageName,
      version: params.version,
      ...(params.peerDependencies ? { peerDependencies: params.peerDependencies } : {}),
      openclaw: {
        extensions: ["."],
      },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(packageDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.id,
      name: params.id,
      configSchema: {
        type: "object",
      },
    }),
    "utf8",
  );
  return { npmRoot, packageDir };
}

function createCurrentIndex(): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  };
}

function createCurrentIndexWithNpmRecord(params: {
  pluginId: string;
  packageName: string;
  packageDir: string;
  version: string;
}): InstalledPluginIndex {
  return {
    ...createCurrentIndex(),
    installRecords: {
      [params.pluginId]: {
        source: "npm",
        spec: `${params.packageName}@${params.version}`,
        installPath: params.packageDir,
        version: params.version,
        resolvedName: params.packageName,
        resolvedVersion: params.version,
        resolvedSpec: `${params.packageName}@${params.version}`,
      },
    },
  };
}

function expectedPluginIndexRecord(params: {
  rootDir: string;
  pluginId: string;
  origin: "bundled" | "global";
  packageName?: string;
  packageVersion?: string;
}) {
  return {
    pluginId: params.pluginId,
    ...(params.packageName ? { packageName: params.packageName } : {}),
    ...(params.packageVersion ? { packageVersion: params.packageVersion } : {}),
    manifestPath: path.join(params.rootDir, "openclaw.plugin.json"),
    manifestHash: expect.any(String),
    manifestFile: {
      size: expect.any(Number),
      mtimeMs: expect.any(Number),
      ctimeMs: expect.any(Number),
    },
    source: path.join(params.rootDir, "index.ts"),
    rootDir: params.rootDir,
    origin: params.origin,
    enabled: true,
    startup: {
      sidecar: false,
      memory: false,
      deferConfiguredChannelFullLoadUntilAfterListen: false,
      agentHarnesses: [],
    },
    compat: [],
  };
}

describe("maybeRepairPluginRegistryState", () => {
  it("refreshes an existing registry during repair", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    await writePersistedInstalledPluginIndex(createCurrentIndex(), { stateDir });

    const nextConfig = await maybeRepairPluginRegistryState({
      stateDir,
      candidates: [createCandidate(pluginDir)],
      env: hermeticEnv(),
      config: {},
      prompter: { shouldRepair: true },
    });

    expect(nextConfig).toStrictEqual({});
    const persisted = await readRequiredPersistedInstalledPluginIndex(stateDir);
    expect(persisted.refreshReason).toBe("migration");
    expect(persisted.plugins).toStrictEqual([
      expectedPluginIndexRecord({
        pluginId: "demo",
        rootDir: pluginDir,
        origin: "global",
      }),
    ]);
  });

  it("does not repair when registry migration is disabled", async () => {
    const stateDir = makeTempDir();

    const nextConfig = await maybeRepairPluginRegistryState({
      stateDir,
      env: hermeticEnv({
        [DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV]: "1",
      }),
      config: {},
      prompter: { shouldRepair: true },
    });

    expect(nextConfig).toStrictEqual({});
    expect(vi.mocked(note).mock.calls.join("\n")).toContain(DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV);
  });

  it("warns about stale managed npm packages that shadow bundled plugins", async () => {
    const stateDir = makeTempDir();
    const bundledDir = path.join(stateDir, "bundled", "google-meet");
    fs.mkdirSync(bundledDir, { recursive: true });
    createManagedNpmPlugin({
      stateDir,
      id: "google-meet",
      packageName: "@openclaw/google-meet",
      version: "2026.5.2",
    });
    await writePersistedInstalledPluginIndex(createCurrentIndex(), { stateDir });

    await maybeRepairPluginRegistryState({
      stateDir,
      candidates: [
        createBundledCandidate({
          rootDir: bundledDir,
          id: "google-meet",
          packageName: "@openclaw/google-meet",
          version: "2026.5.3",
        }),
      ],
      env: hermeticEnv(),
      config: {
        plugins: {
          allow: ["google-meet"],
          entries: {
            "google-meet": {
              enabled: true,
              config: {},
            },
          },
        },
      },
      prompter: { shouldRepair: false },
    });

    expect(vi.mocked(note).mock.calls.join("\n")).toContain(
      "Managed npm plugin packages shadow bundled plugins",
    );
    expect(vi.mocked(note).mock.calls.join("\n")).toContain("@openclaw/google-meet@2026.5.2");
    expect(
      fs.existsSync(path.join(stateDir, "npm", "node_modules", "@openclaw", "google-meet")),
    ).toBe(true);
  });

  it("removes stale managed npm packages that shadow bundled plugins during repair", async () => {
    const stateDir = makeTempDir();
    const bundledDir = path.join(stateDir, "bundled", "google-meet");
    fs.mkdirSync(bundledDir, { recursive: true });
    createManagedNpmPlugin({
      stateDir,
      id: "google-meet",
      packageName: "@openclaw/google-meet",
      version: "2026.5.2",
    });
    await writePersistedInstalledPluginIndex(createCurrentIndex(), { stateDir });

    await maybeRepairPluginRegistryState({
      stateDir,
      candidates: [
        createBundledCandidate({
          rootDir: bundledDir,
          id: "google-meet",
          packageName: "@openclaw/google-meet",
          version: "2026.5.3",
        }),
      ],
      env: hermeticEnv(),
      config: {
        plugins: {
          allow: ["google-meet"],
          entries: {
            "google-meet": {
              enabled: true,
              config: {},
            },
          },
        },
      },
      prompter: { shouldRepair: true },
    });

    expect(
      fs.existsSync(path.join(stateDir, "npm", "node_modules", "@openclaw", "google-meet")),
    ).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, "npm", "package.json"), "utf8")),
    ).not.toHaveProperty("dependencies");
    const persisted = await readRequiredPersistedInstalledPluginIndex(stateDir);
    expect(persisted.refreshReason).toBe("migration");
    expect(persisted.plugins).toStrictEqual([
      expectedPluginIndexRecord({
        pluginId: "google-meet",
        rootDir: bundledDir,
        origin: "bundled",
        packageName: "@openclaw/google-meet",
        packageVersion: "2026.5.3",
      }),
    ]);
    expect(vi.mocked(note).mock.calls.join("\n")).toContain(
      "Removed stale managed npm plugin package",
    );
  });

  it("removes recovered npm install records when a managed package shadows a bundled plugin", async () => {
    const stateDir = makeTempDir();
    const bundledDir = path.join(stateDir, "bundled", "google-meet");
    fs.mkdirSync(bundledDir, { recursive: true });
    const managed = createManagedNpmPlugin({
      stateDir,
      id: "google-meet",
      packageName: "@openclaw/google-meet",
      version: "2026.5.3",
    });
    await writePersistedInstalledPluginIndex(
      createCurrentIndexWithNpmRecord({
        pluginId: "google-meet",
        packageName: "@openclaw/google-meet",
        packageDir: managed.packageDir,
        version: "2026.5.3",
      }),
      { stateDir },
    );

    await maybeRepairPluginRegistryState({
      stateDir,
      candidates: [
        createBundledCandidate({
          rootDir: bundledDir,
          id: "google-meet",
          packageName: "@openclaw/google-meet",
          version: "2026.5.3",
        }),
      ],
      env: hermeticEnv(),
      config: {
        plugins: {
          allow: ["google-meet"],
          entries: {
            "google-meet": {
              enabled: true,
              config: {},
            },
          },
        },
      },
      prompter: { shouldRepair: true },
    });

    expect(fs.existsSync(managed.packageDir)).toBe(false);
    const persisted = await readRequiredPersistedInstalledPluginIndex(stateDir);
    expect(persisted.installRecords).toStrictEqual({});
    expect(persisted.refreshReason).toBe("migration");
    expect(persisted.plugins).toStrictEqual([
      expectedPluginIndexRecord({
        pluginId: "google-meet",
        rootDir: bundledDir,
        origin: "bundled",
        packageName: "@openclaw/google-meet",
        packageVersion: "2026.5.3",
      }),
    ]);
  });

  it("removes stale managed npm packages from the package lock during repair", async () => {
    const stateDir = makeTempDir();
    const bundledDir = path.join(stateDir, "bundled", "google-meet");
    fs.mkdirSync(bundledDir, { recursive: true });
    createManagedNpmPlugin({
      stateDir,
      id: "google-meet",
      packageName: "@openclaw/google-meet",
      version: "2026.5.2",
      packageLock: true,
    });
    await writePersistedInstalledPluginIndex(createCurrentIndex(), { stateDir });

    await maybeRepairPluginRegistryState({
      stateDir,
      candidates: [
        createBundledCandidate({
          rootDir: bundledDir,
          id: "google-meet",
          packageName: "@openclaw/google-meet",
          version: "2026.5.3",
        }),
      ],
      env: hermeticEnv(),
      config: {
        plugins: {
          allow: ["google-meet"],
          entries: {
            "google-meet": {
              enabled: true,
              config: {},
            },
          },
        },
      },
      prompter: { shouldRepair: true },
    });

    const packageLock = JSON.parse(
      fs.readFileSync(path.join(stateDir, "npm", "package-lock.json"), "utf8"),
    );
    expect(packageLock.packages[""].dependencies).toEqual({ "other-plugin": "1.0.0" });
    expect(packageLock.packages).not.toHaveProperty("node_modules/@openclaw/google-meet");
    expect(packageLock.dependencies).not.toHaveProperty("@openclaw/google-meet");
    expect(packageLock.dependencies).toHaveProperty("other-plugin");
  });

  it("repairs managed npm openclaw peer links during registry repair", async () => {
    const stateDir = makeTempDir();
    const managed = createManagedNpmPlugin({
      stateDir,
      id: "codex",
      packageName: "codex-plugin",
      version: "2026.5.3",
      peerDependencies: {
        openclaw: ">=2026.5.3",
      },
    });
    await writePersistedInstalledPluginIndex(
      createCurrentIndexWithNpmRecord({
        pluginId: "codex",
        packageName: "codex-plugin",
        packageDir: managed.packageDir,
        version: "2026.5.3",
      }),
      { stateDir },
    );

    await maybeRepairPluginRegistryState({
      stateDir,
      env: hermeticEnv(),
      config: {},
      prompter: { shouldRepair: true },
    });

    const linkPath = path.join(managed.packageDir, "node_modules", "openclaw");
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(process.cwd()));
    expect(vi.mocked(note).mock.calls.join("\n")).toContain("Repaired OpenClaw host peer link");
  });

  it("warns about broken managed npm openclaw peer links without repairing them", async () => {
    const stateDir = makeTempDir();
    const managed = createManagedNpmPlugin({
      stateDir,
      id: "codex",
      packageName: "codex-plugin",
      version: "2026.5.3",
      peerDependencies: {
        openclaw: ">=2026.5.3",
      },
    });
    await writePersistedInstalledPluginIndex(
      createCurrentIndexWithNpmRecord({
        pluginId: "codex",
        packageName: "codex-plugin",
        packageDir: managed.packageDir,
        version: "2026.5.3",
      }),
      { stateDir },
    );

    await maybeRepairPluginRegistryState({
      stateDir,
      env: hermeticEnv(),
      config: {},
      prompter: { shouldRepair: false },
    });

    const linkPath = path.join(managed.packageDir, "node_modules", "openclaw");
    const notes = vi.mocked(note).mock.calls.join("\n");
    expect(notes).toContain("Managed npm OpenClaw host peer links need repair");
    expect(notes).toContain("codex-plugin");
    expect(notes).toContain("openclaw doctor --fix");
    expect(fs.existsSync(linkPath)).toBe(false);
  });
});
