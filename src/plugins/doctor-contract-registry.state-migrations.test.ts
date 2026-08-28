// Covers plugin doctor state-migration registry behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import {
  getRegistryJitiMocks,
  resetRegistryJitiMocks,
} from "./test-helpers/registry-jiti-mocks.js";

const tempDirs: string[] = [];
const mocks = getRegistryJitiMocks();
const doctorContractWarnMock = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: doctorContractWarnMock,
    }),
  };
});

let clearPluginDoctorContractRegistryCache: typeof import("./doctor-contract-registry.test-fixtures.js").clearPluginDoctorContractRegistryCache;
let listPluginDoctorLegacyConfigRules: typeof import("./doctor-contract-registry.js").listPluginDoctorLegacyConfigRules;
let listPluginDoctorStateMigrationEntries: typeof import("./doctor-contract-registry.js").listPluginDoctorStateMigrationEntries;
let setPluginDoctorContractRegistryModuleLoaderFactoryForTest:
  | typeof import("./doctor-contract-registry.test-fixtures.js").setPluginDoctorContractRegistryModuleLoaderFactoryForTest
  | undefined;

function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-doctor-contract-state-migrations", tempDirs);
}

afterEach(() => {
  setPluginDoctorContractRegistryModuleLoaderFactoryForTest?.(undefined);
  cleanupTrackedTempDirs(tempDirs);
});

describe("doctor-contract-registry state migrations", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ listPluginDoctorLegacyConfigRules, listPluginDoctorStateMigrationEntries } =
      await import("./doctor-contract-registry.js"));
    ({
      clearPluginDoctorContractRegistryCache,
      setPluginDoctorContractRegistryModuleLoaderFactoryForTest,
    } = await import("./doctor-contract-registry.test-fixtures.js"));
  });

  beforeEach(() => {
    resetRegistryJitiMocks();
    doctorContractWarnMock.mockReset();
    // Loaded once in beforeAll; afterEach guards the same binding optionally because it
    // can fire when that import never completed. Fail loudly here instead of silently
    // running a case against the real module loader.
    if (!setPluginDoctorContractRegistryModuleLoaderFactoryForTest) {
      throw new Error("doctor contract registry test fixtures were not loaded");
    }
    setPluginDoctorContractRegistryModuleLoaderFactoryForTest(mocks.createJiti);
    clearPluginDoctorContractRegistryCache();
  });

  it("loads a direct legacy detector without package or entry feature hints", async () => {
    const pluginRoot = makeTempDir();
    const setupSource = path.join(pluginRoot, "setup-entry.ts");
    fs.writeFileSync(setupSource, "export {};\n", "utf-8");
    const detector = vi.fn(() => [
      {
        kind: "move" as const,
        label: "Legacy credentials",
        sourcePath: "/oauth/legacy.json",
        targetPath: "/oauth/demo/legacy.json",
      },
    ]);
    const loadSetupPlugin = vi.fn(() => {
      throw new Error("direct legacy discovery activated the setup plugin");
    });
    mocks.createJiti.mockImplementation(() => () => ({
      default: {
        kind: "bundled-channel-setup-entry",
        loadSetupPlugin,
        loadLegacyStateMigrationDetector: () => detector,
      },
    }));
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "legacy-channel",
          origin: "global",
          rootDir: pluginRoot,
          setupSource,
          channels: ["legacy-channel"],
          providers: [],
        },
      ],
      diagnostics: [],
    });

    expect(
      listPluginDoctorStateMigrationEntries({
        config: { channels: { "legacy-channel": { enabled: false } } },
        env: {},
        pluginIds: ["legacy-channel"],
      }),
    ).toEqual([]);
    expect(mocks.createJiti).not.toHaveBeenCalled();

    const entries = listPluginDoctorStateMigrationEntries({
      config: {},
      env: {},
      pluginIds: ["legacy-channel"],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.pluginId).toBe("legacy-channel");
    await expect(
      entries[0]?.migration.detectLegacyState({
        config: {},
        env: {},
        stateDir: "/state",
        oauthDir: "/oauth",
        context: { openPluginStateKeyedStore: vi.fn() } as never,
      }),
    ).resolves.toEqual({
      preview: ["- Legacy credentials: /oauth/legacy.json → /oauth/demo/legacy.json"],
    });
    expect(detector).toHaveBeenCalledTimes(1);
    expect(loadSetupPlugin).not.toHaveBeenCalled();
    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "entry feature present", entryFeature: true, expectedCount: 1 },
    { name: "entry feature absent", entryFeature: false, expectedCount: 0 },
  ])(
    "gates the legacy setup-plugin lifecycle fallback when the $name",
    ({ entryFeature, expectedCount }) => {
      const pluginRoot = makeTempDir();
      const setupSource = path.join(pluginRoot, "setup-entry.ts");
      fs.writeFileSync(setupSource, "export {};\n", "utf-8");
      const detector = vi.fn(() => []);
      const loadSetupPlugin = vi.fn(() => ({
        lifecycle: { detectLegacyStateMigrations: detector },
      }));
      mocks.createJiti.mockImplementation(() => () => ({
        default: {
          kind: "bundled-channel-setup-entry",
          loadSetupPlugin,
          ...(entryFeature ? { features: { legacyStateMigrations: true } } : {}),
        },
      }));
      mocks.loadPluginManifestRegistry.mockReturnValue({
        plugins: [
          {
            id: "legacy-channel",
            origin: "global",
            rootDir: pluginRoot,
            setupSource,
            channels: ["legacy-channel"],
            providers: [],
          },
        ],
        diagnostics: [],
      });

      expect(
        listPluginDoctorStateMigrationEntries({
          config: {},
          env: {},
          pluginIds: ["legacy-channel"],
        }),
      ).toHaveLength(expectedCount);
      expect(loadSetupPlugin).toHaveBeenCalledTimes(expectedCount);
      expect(mocks.createJiti).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { name: "wrong kind", kind: "bundled-channel-entry", includeSetupLoader: true },
    {
      name: "missing required setup loader",
      kind: "bundled-channel-setup-entry",
      includeSetupLoader: false,
    },
  ])("rejects a legacy setup entry with $name", ({ kind, includeSetupLoader }) => {
    const pluginRoot = makeTempDir();
    const setupSource = path.join(pluginRoot, "setup-entry.ts");
    fs.writeFileSync(setupSource, "export {};\n", "utf-8");
    const loadLegacyStateMigrationDetector = vi.fn(() => () => []);
    mocks.createJiti.mockImplementation(() => () => ({
      default: {
        kind,
        features: { legacyStateMigrations: true },
        ...(includeSetupLoader ? { loadSetupPlugin: () => ({}) } : {}),
        loadLegacyStateMigrationDetector,
      },
    }));
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "legacy-channel",
          origin: "global",
          rootDir: pluginRoot,
          setupSource,
          channels: ["legacy-channel"],
          providers: [],
          packageManifest: { setupFeatures: { legacyStateMigrations: true } },
        },
      ],
      diagnostics: [],
    });

    expect(listPluginDoctorStateMigrationEntries({ config: {}, env: {} })).toEqual([]);
    expect(loadLegacyStateMigrationDetector).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "explicitly disabled channel",
      config: { channels: { alpha: { enabled: false } } },
    },
    {
      name: "explicitly disabled plugin",
      config: { plugins: { entries: { alpha: { enabled: false } } } },
    },
    {
      name: "denylisted plugin",
      config: { plugins: { deny: ["alpha"] } },
    },
    {
      name: "globally disabled plugins",
      config: { plugins: { enabled: false } },
    },
    {
      name: "every configured channel alias disabled",
      config: { channels: { alpha: { enabled: false }, "alpha-alias": { enabled: false } } },
    },
  ])("never loads state migrations for an $name, but still repairs its config", ({ config }) => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.ts"), "export {};\n", "utf8");
    mocks.createJiti.mockImplementation(() => () => ({
      legacyConfigRules: [
        { path: ["channels", "alpha", "legacy"], message: "repair disabled alpha" },
      ],
      stateMigrations: [
        {
          id: "alpha-state",
          label: "Alpha state",
          detectLegacyState: () => ({ preview: ["alpha state"] }),
          migrateLegacyState: () => ({ changes: ["migrated alpha state"], warnings: [] }),
        },
      ],
    }));
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "alpha",
          origin: "global",
          rootDir: pluginRoot,
          channels: ["alpha", "alpha-alias"],
          providers: [],
          doctorContract: { configRepair: true, stateMigrations: true },
        },
      ],
      diagnostics: [],
    });

    expect(listPluginDoctorStateMigrationEntries({ config, env: {} })).toEqual([]);
    expect(mocks.createJiti).not.toHaveBeenCalled();
    expect(listPluginDoctorLegacyConfigRules({ config, env: {} })).toEqual([
      { path: ["channels", "alpha", "legacy"], message: "repair disabled alpha" },
    ]);
    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "untrusted workspace even when explicitly scoped",
      origin: "workspace",
      config: {},
      allowed: false,
    },
    {
      name: "non-bundled owner omitted from a restrictive allowlist",
      origin: "global",
      config: { plugins: { allow: ["other-plugin"] } },
      allowed: false,
    },
    {
      name: "explicitly allowlisted workspace",
      origin: "workspace",
      config: { plugins: { allow: ["alpha"] } },
      allowed: true,
    },
    {
      name: "explicitly enabled workspace",
      origin: "workspace",
      config: { plugins: { entries: { alpha: { enabled: true } } } },
      allowed: true,
    },
  ])("honors effective activation before loading an $name", ({ origin, config, allowed }) => {
    const pluginRoot = makeTempDir();
    const setupSource = path.join(pluginRoot, "setup-entry.ts");
    fs.writeFileSync(setupSource, "export {};\n", "utf8");
    const loadSetupPlugin = vi.fn(() => {
      throw new Error("direct setup detector should not activate the plugin");
    });
    mocks.createJiti.mockImplementation(() => () => ({
      default: {
        kind: "bundled-channel-setup-entry",
        features: { legacyStateMigrations: true },
        loadSetupPlugin,
        loadLegacyStateMigrationDetector: () => () => [],
      },
    }));
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "alpha",
          origin,
          rootDir: pluginRoot,
          setupSource,
          channels: ["alpha"],
          providers: [],
          packageManifest: { setupFeatures: { legacyStateMigrations: true } },
        },
      ],
      diagnostics: [],
    });

    expect(
      listPluginDoctorStateMigrationEntries({ config, env: {}, pluginIds: ["alpha"] }).map(
        (entry) => entry.migration.id,
      ),
    ).toEqual(allowed ? ["alpha-legacy-channel-state"] : []);
    expect(mocks.createJiti).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(loadSetupPlugin).not.toHaveBeenCalled();
  });

  it.each([
    { name: "inactive workspace owner", config: {}, allowed: false },
    {
      name: "allowlisted workspace owner",
      config: { plugins: { allow: ["alpha"] } },
      allowed: true,
    },
    {
      name: "explicitly enabled workspace owner",
      config: { plugins: { entries: { alpha: { enabled: true } } } },
      allowed: true,
    },
  ])("gates a modern non-channel $name before loading", ({ config, allowed }) => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.ts"), "export {};\n", "utf8");
    mocks.createJiti.mockImplementation(() => () => ({
      stateMigrations: [
        {
          id: "alpha-state",
          label: "Alpha state",
          detectLegacyState: () => ({ preview: ["alpha state"] }),
          migrateLegacyState: () => ({ changes: [], warnings: [] }),
        },
      ],
    }));
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "alpha",
          origin: "workspace",
          rootDir: pluginRoot,
          channels: [],
          providers: [],
          doctorContract: { stateMigrations: true },
        },
      ],
      diagnostics: [],
    });

    expect(
      listPluginDoctorStateMigrationEntries({ config, env: {} }).map((entry) => entry.migration.id),
    ).toEqual(allowed ? ["alpha-state"] : []);
    expect(mocks.createJiti).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it("preserves an enabled channel alias and the existing restrictive-allowlist bypass", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      `module.exports = { stateMigrations: [{
  id: 'alpha-state',
  label: 'Alpha state',
  detectLegacyState: () => ({ preview: ['alpha state'] }),
  migrateLegacyState: () => ({ changes: [], warnings: [] }),
}] };\n`,
      "utf8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "alpha",
          origin: "bundled",
          rootDir: pluginRoot,
          channels: ["alpha", "alpha-alias"],
          providers: [],
          doctorContract: { stateMigrations: true },
        },
      ],
      diagnostics: [],
    });

    expect(
      listPluginDoctorStateMigrationEntries({
        config: {
          channels: { alpha: { enabled: false }, "alpha-alias": { enabled: true } },
          plugins: { allow: ["unrelated"] },
        },
        env: {},
      }).map((entry) => entry.migration.id),
    ).toEqual(["alpha-state"]);
  });

  it("prefers modern migrations without loading the same owner's legacy setup entry", () => {
    const pluginRoot = makeTempDir();
    const setupSource = path.join(pluginRoot, "setup-entry.cjs");
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      `module.exports = { stateMigrations: [{
  id: 'alpha-modern',
  label: 'Modern alpha state',
  detectLegacyState: () => ({ preview: ['modern'] }),
  migrateLegacyState: () => ({ changes: [], warnings: [] }),
}] };\n`,
      "utf8",
    );
    fs.writeFileSync(setupSource, "throw new Error('obsolete setup entry loaded');\n", "utf8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "alpha",
          origin: "global",
          rootDir: pluginRoot,
          setupSource,
          channels: ["alpha"],
          providers: [],
          doctorContract: { stateMigrations: true },
          packageManifest: { setupFeatures: { legacyStateMigrations: true } },
        },
      ],
      diagnostics: [],
    });

    expect(
      listPluginDoctorStateMigrationEntries({ config: {}, env: {} }).map(
        (entry) => entry.migration.id,
      ),
    ).toEqual(["alpha-modern"]);
  });

  it("does not fall back to legacy when an explicit modern declaration yields no migrations", () => {
    const pluginRoot = makeTempDir();
    const setupSource = path.join(pluginRoot, "setup-entry.cjs");
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      "module.exports = { stateMigrations: [] };\n",
      "utf8",
    );
    fs.writeFileSync(
      setupSource,
      `module.exports = {
  kind: 'bundled-channel-setup-entry',
  features: { legacyStateMigrations: true },
  loadSetupPlugin() { return {}; },
  loadLegacyStateMigrationDetector() { return () => []; },
};\n`,
      "utf8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "alpha",
          origin: "global",
          rootDir: pluginRoot,
          setupSource,
          channels: ["alpha"],
          providers: [],
          doctorContract: { stateMigrations: true },
          packageManifest: { setupFeatures: { legacyStateMigrations: true } },
        },
      ],
      diagnostics: [],
    });

    expect(listPluginDoctorStateMigrationEntries({ config: {}, env: {} })).toEqual([]);
    expect(doctorContractWarnMock).not.toHaveBeenCalled();
  });

  it("keeps bundled non-channel state migrations available when plugins are globally disabled", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      `module.exports = { stateMigrations: [{
  id: 'memory-state',
  label: 'Memory state',
  detectLegacyState: () => ({ preview: ['memory state'] }),
  migrateLegacyState: () => ({ changes: [], warnings: [] }),
}] };\n`,
      "utf8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "memory-state",
          origin: "bundled",
          rootDir: pluginRoot,
          channels: [],
          providers: [],
          doctorContract: { stateMigrations: true },
        },
      ],
      diagnostics: [],
    });

    expect(
      listPluginDoctorStateMigrationEntries({
        config: { plugins: { enabled: false } },
        env: {},
      }).map((entry) => entry.migration.id),
    ).toEqual(["memory-state"]);
  });
});
