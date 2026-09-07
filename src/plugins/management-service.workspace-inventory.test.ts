import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveConfigWidePluginMetadataSnapshot } from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { setGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { getGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { resolvePluginInstallDir } from "./install-paths.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "./test-helpers/fs-fixtures.js";

const configIo = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshotForWrite: () => configIo.read(),
  replaceConfigFile: (params: unknown) => configIo.write(params),
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: async () => ({
    source: "hosted",
    entries: [],
  }),
}));

const { listManagedPlugins, refreshManagedPluginMetadata } =
  await import("./management-service.js");
const { setManagedPluginEnabled, uninstallManagedPlugin } =
  await import("./management-mutations.js");
const roots: string[] = [];

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(roots);
  vi.unstubAllEnvs();
});

it("refreshes an externally changed install ledger before publishing management inventory", async () => {
  const root = makeTrackedTempDir("managed-external-ledger", roots);
  const pluginRoot = path.join(root, "external-install");
  const loadPath = path.join(root, "configured-plugins");
  mkdirSafeDir(pluginRoot);
  mkdirSafeDir(loadPath);
  const fixture = createColdPluginFixture({ rootDir: pluginRoot, pluginId: "external-candidate" });
  vi.stubEnv("OPENCLAW_HOME", path.join(root, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  const config: OpenClawConfig = { plugins: { load: { paths: [loadPath] } } };
  await writePersistedInstalledPluginIndex(
    loadInstalledPluginIndex({ config, env: process.env, candidates: [], installRecords: {} }),
  );
  const boot = resolveConfigWidePluginMetadataSnapshot({
    config,
    env: process.env,
    allowCurrent: false,
  });
  setGatewayPluginMetadataSnapshot(boot, { config, env: process.env });
  expect(
    (await listManagedPlugins({ config })).plugins.some((plugin) => plugin.id === fixture.pluginId),
  ).toBe(false);

  // Simulate a separate CLI process committing without this process's cache notifications.
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare(
      "UPDATE config_machine_state SET value_json = json_set(value_json, '$.index.installRecords', json(?)) WHERE state_key = 'plugins.installedIndex'",
    ).run(
      JSON.stringify({
        [fixture.pluginId]: { source: "path", installPath: pluginRoot, sourcePath: pluginRoot },
      }),
    );
  });

  refreshManagedPluginMetadata({ config });

  expect((await listManagedPlugins({ config })).plugins).toContainEqual(
    expect.objectContaining({ id: fixture.pluginId, installed: true }),
  );
  expect(getGatewayPluginMetadataSnapshot()).toBe(boot);
  expect(boot.byPluginId.has(fixture.pluginId)).toBe(false);
});

it("removes an npm-pack plugin from management inventory without replacing Gateway metadata", async () => {
  const root = makeTrackedTempDir("managed-npm-pack-uninstall", roots);
  const stateDir = path.join(root, "state");
  const packageName = "@example/tgz-visible";
  const pluginRoot = resolvePluginInstallDir("tgz-visible", path.join(stateDir, "extensions"));
  mkdirSafeDir(pluginRoot);
  const fixture = createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId: "tgz-visible",
    packageName,
  });
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  let config: OpenClawConfig = {
    plugins: { entries: { [fixture.pluginId]: { enabled: true } } },
  };
  const installRecord = {
    source: "npm",
    spec: `${packageName}@1.0.0`,
    sourcePath: path.join(root, `${fixture.pluginId}.tgz`),
    installPath: pluginRoot,
    artifactKind: "npm-pack",
    artifactFormat: "tgz",
  } as const;
  configIo.read.mockImplementation(async () => ({
    snapshot: {
      valid: true,
      parsed: config,
      path: path.join(stateDir, "openclaw.json"),
      sourceConfig: config,
      hash: "base-hash",
    },
    writeOptions: { expectedConfigPath: path.join(stateDir, "openclaw.json") },
  }));
  configIo.write.mockImplementation(async ({ nextConfig }: { nextConfig: OpenClawConfig }) => {
    config = nextConfig;
  });
  await writePersistedInstalledPluginIndex(
    loadInstalledPluginIndex({
      config,
      env: process.env,
      installRecords: { [fixture.pluginId]: installRecord },
    }),
  );
  const boot = loadPluginMetadataSnapshot({
    config,
    env: process.env,
    preferPersisted: false,
  });
  setGatewayPluginMetadataSnapshot(boot, { config, env: process.env });
  expect((await listManagedPlugins({ config })).plugins).toContainEqual(
    expect.objectContaining({ id: fixture.pluginId, installed: true }),
  );

  await uninstallManagedPlugin({ pluginId: fixture.pluginId });

  expect(fs.existsSync(pluginRoot)).toBe(false);
  expect(
    (await readPersistedInstalledPluginIndex())?.plugins.some(
      (plugin) => plugin.pluginId === fixture.pluginId,
    ),
  ).toBe(false);
  expect((await listManagedPlugins({ config })).plugins).not.toContainEqual(
    expect.objectContaining({ id: fixture.pluginId }),
  );
  expect(getGatewayPluginMetadataSnapshot()).toBe(boot);
  expect(boot.byPluginId.has(fixture.pluginId)).toBe(true);
});

it.each([undefined, "main"])(
  "toggles a listed secondary-workspace plugin with system owner %s",
  async (systemAgentId) => {
    const root = makeTrackedTempDir("managed-workspace-inventory", roots);
    const mainWorkspace = path.join(root, "main");
    const secondaryWorkspace = path.join(root, "secondary");
    const pluginRoot = path.join(secondaryWorkspace, ".openclaw", "extensions", "workspace-memory");
    mkdirSafeDir(pluginRoot);
    const fixture = createColdPluginFixture({
      rootDir: pluginRoot,
      pluginId: "workspace-memory",
      manifest: {
        kind: "memory",
        providers: [],
        channels: [],
        channelConfigs: {},
        providerAuthChoices: [],
      },
    });
    vi.stubEnv("OPENCLAW_HOME", path.join(root, "home"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    let config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        ...(systemAgentId ? { defaults: { systemAgent: { agentId: systemAgentId } } } : {}),
        entries: {
          main: { workspace: mainWorkspace },
          secondary: { workspace: secondaryWorkspace },
        },
      },
      plugins: { entries: { [fixture.pluginId]: { enabled: false } } },
    };
    configIo.read.mockImplementation(async () => ({
      snapshot: {
        valid: true,
        parsed: config,
        sourceConfig: config,
        path: path.join(root, "openclaw.json"),
        hash: "base-hash",
      },
      writeOptions: { expectedConfigPath: path.join(root, "openclaw.json") },
    }));
    configIo.write.mockImplementation(async ({ nextConfig }: { nextConfig: OpenClawConfig }) => {
      config = nextConfig;
    });
    const boot = resolveConfigWidePluginMetadataSnapshot({
      config,
      env: process.env,
      allowCurrent: false,
    });
    setGatewayPluginMetadataSnapshot(boot, { config, env: process.env });
    expect((await listManagedPlugins({ config })).plugins).toContainEqual(
      expect.objectContaining({ id: fixture.pluginId, installed: true, enabled: false }),
    );

    for (const enabled of [true, false]) {
      const result = await setManagedPluginEnabled({ pluginId: fixture.pluginId, enabled });
      expect(result.plugin).toMatchObject({ id: fixture.pluginId, installed: true, enabled });
      expect(config.plugins?.entries?.[fixture.pluginId]?.enabled).toBe(enabled);
      if (enabled) {
        expect(config.plugins?.slots?.memory).toBe(fixture.pluginId);
      }
      expect(getGatewayPluginMetadataSnapshot()).toBe(boot);
      expect(
        boot.index.plugins.find((plugin) => plugin.pluginId === fixture.pluginId)?.enabled,
      ).toBe(false);
    }
  },
);
