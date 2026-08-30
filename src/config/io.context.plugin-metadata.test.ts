import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import { resolvePluginCandidateInstallOwner } from "../plugins/candidate-install-owner.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { getCurrentPluginMetadataSnapshotState } from "../plugins/current-plugin-metadata-state.js";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "../plugins/installed-plugin-index-record-cache.js";
import { refreshPersistedInstalledPluginIndexSync } from "../plugins/installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndexSync } from "../plugins/installed-plugin-index-store.js";
import {
  createPluginCache,
  getPluginCache,
  getPluginMetadataSnapshotCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import {
  createPluginMetadataOwner,
  getPluginMetadataWorkspaceSnapshot,
  withPluginMetadataCollectionScope,
} from "../plugins/plugin-metadata-collection.js";
import {
  clearPluginMetadataLifecycleCaches,
  retainGatewayPluginMetadata,
} from "../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "../plugins/test-helpers/fs-fixtures.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL } from "../state/openclaw-state-schema-v13-widerow.test-support.js";
import { createConfigIoContext } from "./io.context.js";
import { createConfigIO } from "./io.factory.js";
import { resolveConfigWidePluginManifestRegistry } from "./io.plugin-metadata.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type PluginFixture = ReturnType<typeof createColdPluginFixture>;

describe("config IO plugin metadata snapshots", () => {
  const tempDirs: string[] = [];
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    root = fs.realpathSync(makeTrackedTempDir("openclaw-config-metadata", tempDirs));
    const bundledPluginsDir = path.join(root, "bundled");
    mkdirSafeDir(bundledPluginsDir);
    env = {
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearPluginMetadataLifecycleCaches();
    closeOpenClawStateDatabaseForTest();
    cleanupTrackedTempDirs(tempDirs);
  });

  function writePlugin(rootDir: string, pluginId: string): PluginFixture {
    mkdirSafeDir(rootDir);
    return createColdPluginFixture({
      rootDir,
      pluginId,
      packageName: `@example/${pluginId}`,
      channelId: `${pluginId}-chat`,
      providerId: `${pluginId}-provider`,
    });
  }

  function createWorkspaceFixture(sharedWorkspace = false) {
    const shared = writePlugin(path.join(root, "shared"), "shared-plugin");
    const workspaceDirs = Array.from({ length: 4 }, (_, index) =>
      path.join(root, `workspace-${sharedWorkspace ? 0 : index}`),
    );
    const workspacePlugins = [...new Set(workspaceDirs)].map((workspaceDir, index) =>
      writePlugin(
        path.join(workspaceDir, ".openclaw", "extensions", `workspace-${index}-plugin`),
        `workspace-${index}-plugin`,
      ),
    );
    const plugins = [shared, ...workspacePlugins];
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: Object.fromEntries(
          workspaceDirs.map((workspace, index) => [`agent-${index}`, { workspace }]),
        ),
      },
      channels: Object.fromEntries(plugins.map((plugin) => [plugin.channelId, { enabled: true }])),
      plugins: {
        load: { paths: [shared.rootDir] },
        allow: plugins.map((plugin) => plugin.pluginId),
        entries: Object.fromEntries(plugins.map((plugin) => [plugin.pluginId, { enabled: true }])),
      },
    };
    return { config, plugins, workspaceDirs };
  }

  it.each(["first read", "read-only owner", "read-only seed after external open"])(
    "prepares complete metadata after state initialization: %s",
    async (preparation) => {
      const pluginDir = path.join(root, "custom-memory");
      mkdirSafeDir(pluginDir);
      const plugin = createColdPluginFixture({
        rootDir: pluginDir,
        pluginId: "custom-memory",
        manifest: {
          kind: "memory",
          configSchema: {
            type: "object",
            properties: { mode: { enum: ["valid"] } },
            required: ["mode"],
            additionalProperties: false,
          },
        },
      });
      const workspaceDir = path.join(root, "workspace");
      const config: OpenClawConfig = {
        gateway: { mode: "local" },
        agents: { ownership: "explicit", entries: { worker: { workspace: workspaceDir } } },
        plugins: {
          slots: { memory: plugin.pluginId },
          entries: { [plugin.pluginId]: { enabled: true, config: { mode: "valid" } } },
        },
      };
      const index = refreshPersistedInstalledPluginIndexSync({
        config,
        env,
        workspaceDir,
        reason: "manual",
        installRecords: {
          [plugin.pluginId]: {
            source: "path",
            sourcePath: pluginDir,
            installPath: pluginDir,
            version: "1.0.0",
          },
        },
      });
      const databasePath = openOpenClawStateDatabase({ env }).path;
      closeOpenClawStateDatabaseForTest();
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL);
      legacy.close();
      clearPluginMetadataLifecycleCaches();
      clearLoadInstalledPluginIndexInstallRecordsCache();
      fs.writeFileSync(env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));

      const owner = createPluginMetadataOwner();
      const readonlyIO = createConfigIO({ env, observe: false, pluginMetadataOwner: owner });
      let seed: ReturnType<typeof owner.prepare> | undefined;
      if (preparation !== "first read") {
        await readonlyIO.readConfigFileSnapshot();
        seed = owner.prepare({ config, env });
        const unchanged = new DatabaseSync(databasePath, { readOnly: true });
        expect(unchanged.prepare("PRAGMA user_version").get()?.user_version).toBe(12);
        unchanged.close();
        if (preparation === "read-only seed after external open") {
          openOpenClawStateDatabase({ env });
        }
      }

      const observingIO = createConfigIO({ env, pluginMetadataOwner: owner });
      const read = () => observingIO.readConfigFileSnapshotWithPluginMetadata();
      const result = seed
        ? await withPluginMetadataCollectionScope(seed, read, { config, env })
        : await read();
      expect(result.snapshot.valid, JSON.stringify(result.snapshot.issues)).toBe(true);
      expect(result.pluginMetadata?.byPluginId.has(plugin.pluginId)).toBe(true);
      expect(result.pluginMetadata?.selectedSnapshot.index.installRecords).toEqual(
        index.installRecords,
      );
      const union = result.pluginMetadata?.unionSnapshot;
      expect(union?.index.installRecords).toEqual(index.installRecords);
      expect(union?.discovery?.candidates.map(resolvePluginCandidateInstallOwner)).toContain(
        plugin.pluginId,
      );
      expect(Object.isFrozen(union?.index.plugins)).toBe(true);
      expect(readPersistedInstalledPluginIndexSync({ env })?.installRecords).toEqual(
        index.installRecords,
      );
      expect(
        openOpenClawStateDatabase({ env }).db.prepare("PRAGMA user_version").get()?.user_version,
      ).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
      expect(
        owner.prepare({ config, env, seed: result.pluginMetadata }).byPluginId.has(plugin.pluginId),
      ).toBe(true);

      fs.writeFileSync(
        env.OPENCLAW_CONFIG_PATH!,
        JSON.stringify({
          ...config,
          plugins: {
            ...config.plugins,
            entries: { [plugin.pluginId]: { enabled: true, config: { mode: "invalid" } } },
          },
        }),
      );
      const rejected = await observingIO.readConfigFileSnapshot();
      expect(rejected.valid).toBe(false);
      expect(
        rejected.issues.some((issue) =>
          issue.path.startsWith(`plugins.entries.${plugin.pluginId}`),
        ),
      ).toBe(true);
      expect(fs.existsSync(plugin.runtimeMarker)).toBe(false);
      owner.dispose();
    },
  );

  it("does not initialize state while validating an unaccepted recovery backup", () => {
    const plugin = writePlugin(path.join(root, "backup-plugin"), "backup-plugin");
    const config = { plugins: { load: { paths: [plugin.rootDir] } } };
    const context = createConfigIoContext({ env });
    const result = context.prepareRecoveryBackupCandidate({
      parsed: config,
      raw: JSON.stringify(config),
    });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR!, "state", "openclaw.sqlite"))).toBe(
      false,
    );
    expect(fs.existsSync(plugin.runtimeMarker)).toBe(false);
  });

  it("keeps config inspection available when state initialization fails", async () => {
    const stateDatabase = await import("../state/openclaw-state-db.js");
    const openState = vi
      .spyOn(stateDatabase, "openOpenClawStateDatabase")
      .mockImplementation(() => {
        throw new Error("test state database unavailable");
      });
    mkdirSafeDir(path.dirname(env.OPENCLAW_CONFIG_PATH!));
    fs.writeFileSync(
      env.OPENCLAW_CONFIG_PATH!,
      JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } }),
    );

    const snapshot = await createConfigIO({
      env,
      logger: { error: vi.fn(), warn: vi.fn() },
    }).readConfigFileSnapshot();

    expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
    expect(openState).toHaveBeenCalled();
  });

  it.each([
    { sharedWorkspace: false, defaultStatePaths: false, operation: false },
    { sharedWorkspace: true, defaultStatePaths: false, operation: false },
    { sharedWorkspace: false, defaultStatePaths: true, operation: false },
    { sharedWorkspace: true, defaultStatePaths: true, operation: false },
    { sharedWorkspace: false, defaultStatePaths: false, operation: true },
  ])(
    "reuses all workspace metadata across validation contexts (shared workspace: $sharedWorkspace, default state paths: $defaultStatePaths, explicit operation: $operation)",
    ({ sharedWorkspace, defaultStatePaths, operation }) => {
      if (defaultStatePaths) {
        delete env.OPENCLAW_STATE_DIR;
        delete env.OPENCLAW_CONFIG_PATH;
      }
      const { config, plugins, workspaceDirs } = createWorkspaceFixture(sharedWorkspace);
      const metadataRoots = [
        ...plugins.map((plugin) => plugin.rootDir),
        ...workspaceDirs.map((workspaceDir) => path.join(workspaceDir, ".openclaw", "extensions")),
        path.join(root, "bundled"),
        path.join(root, defaultStatePaths ? ".openclaw" : "state"),
      ];
      const readContexts = (operationCache?: ReturnType<typeof createPluginCache>) => {
        const context = createConfigIoContext({ env, observe: false });
        const otherContexts = Array.from({ length: 3 }, () =>
          createConfigIoContext({ env, observe: false }),
        );
        const readMetadata = (reader = context) => {
          const loader = reader.createValidationPluginMetadataSnapshotLoader({
            env,
          });
          loader.load(config);
          return loader.getMetadata();
        };
        // Observe the real filesystem, not a mocked discovery result. This loader
        // must not revisit plugin or state metadata after preparation.
        const reads = [
          vi.spyOn(fs, "existsSync"),
          vi.spyOn(fs, "lstatSync"),
          vi.spyOn(fs, "openSync"),
          vi.spyOn(fs, "readdirSync"),
          vi.spyOn(fs, "readFileSync"),
          vi.spyOn(fs, "statSync"),
          vi.spyOn(fs.realpathSync, "native"),
        ];
        const pluginReads = () =>
          reads.flatMap((read) =>
            read.mock.calls.flatMap(([target]) =>
              typeof target === "string" &&
              metadataRoots.some(
                (metadataRoot) =>
                  target === metadataRoot || target.startsWith(`${metadataRoot}${path.sep}`),
              )
                ? [target]
                : [],
            ),
          );
        const prepared = readMetadata();
        const expectedPluginIds = plugins.map((plugin) => plugin.pluginId);
        expect(prepared?.plugins.map((plugin) => plugin.id)).toEqual(expectedPluginIds);
        expect(pluginReads().length).toBeGreaterThan(0);
        if (operationCache) {
          if (!prepared) {
            throw new Error("Config validation did not prepare plugin metadata");
          }
          expect(getPluginMetadataSnapshotCache(prepared)).toBe(operationCache);
          expect(getPluginMetadataSnapshotCache(prepared.unionSnapshot)).toBe(operationCache);
        }
        expect(prepared?.unionSnapshot.index.plugins.map((plugin) => plugin.pluginId)).toEqual(
          expectedPluginIds,
        );
        expect(prepared?.selectedSnapshot.index.plugins.map((plugin) => plugin.pluginId)).toEqual([
          "shared-plugin",
        ]);
        for (const [workspaceDir, snapshot] of prepared?.workspaces ?? []) {
          const workspaceCandidates = snapshot.discovery?.candidates.filter(
            (candidate) => candidate.origin === "workspace",
          );
          expect(
            workspaceCandidates?.every((candidate) => candidate.workspaceDir === workspaceDir),
          ).toBe(true);
        }
        for (const plugin of plugins) {
          expect(prepared?.byPluginId.get(plugin.pluginId)?.source).toBe(plugin.runtimeSource);
          expect(prepared?.owners.channels.get(plugin.channelId)).toEqual([plugin.pluginId]);
        }
        expect(
          resolveReadOnlyChannelPluginsForConfig(config, {
            env,
            metadataSnapshot: prepared,
          })
            .plugins.map((plugin) => plugin.id)
            .toSorted(),
        ).toEqual(plugins.map((plugin) => plugin.channelId).toSorted());

        for (const read of reads) {
          read.mockClear();
        }
        for (const reader of [context, ...otherContexts]) {
          const metadata = readMetadata(reader);
          expect(metadata?.plugins.map((plugin) => plugin.id)).toEqual(expectedPluginIds);
          if (operationCache) {
            expect(metadata).toBe(prepared);
          }
        }
        for (const pluginId of [
          plugins.at(-1)!.pluginId,
          "shared-plugin",
          plugins.at(-1)!.pluginId,
        ]) {
          expect(
            resolveConfigWidePluginManifestRegistry({
              config,
              env,
              pluginIds: [pluginId],
            }).plugins.map((plugin) => plugin.id),
          ).toEqual([pluginId]);
        }
        expect(pluginReads()).toHaveLength(0);
        for (const plugin of plugins) {
          expect(fs.existsSync(plugin.runtimeMarker)).toBe(false);
        }
      };
      if (!operation) {
        readContexts();
        return;
      }

      const gatewayPlugin = writePlugin(path.join(root, "gateway-only"), "gateway-only");
      const gatewayConfig: OpenClawConfig = {
        plugins: { load: { paths: [gatewayPlugin.rootDir] } },
      };
      const releaseGateway = retainGatewayPluginMetadata();
      try {
        const gatewayOwner = createPluginMetadataOwner();
        const gatewayMetadata = gatewayOwner.prepare({ config: gatewayConfig, env });
        const gatewayCache = getPluginMetadataSnapshotCache(gatewayMetadata);
        gatewayOwner.publish(gatewayMetadata, { config: gatewayConfig, env });
        expect(gatewayMetadata.plugins.map((plugin) => plugin.id)).toEqual([
          gatewayPlugin.pluginId,
        ]);

        const operationCache = createPluginCache();
        withPluginCache(operationCache, () => readContexts(operationCache));

        expect(getPluginCache()).toBe(gatewayCache);
        expect(gatewayOwner.getActive()).toBe(gatewayMetadata);
        expect(getCurrentPluginMetadataSnapshotState().snapshot).toBe(
          gatewayMetadata.unionSnapshot,
        );
        expect(gatewayMetadata.plugins.map((plugin) => plugin.id)).toEqual([
          gatewayPlugin.pluginId,
        ]);
        expect(fs.existsSync(gatewayPlugin.runtimeMarker)).toBe(false);
      } finally {
        releaseGateway();
      }
    },
  );

  it("retains disabled plugins in the complete validation inventory", () => {
    const { config, plugins } = createWorkspaceFixture();
    const disabled = plugins[1]!;
    config.plugins!.entries![disabled.pluginId]!.enabled = false;
    const context = createConfigIoContext({ env, observe: false });
    const loader = context.createValidationPluginMetadataSnapshotLoader({ env });

    const registry = loader.load(config).manifestRegistry;
    const metadata = loader.getMetadata();

    expect(registry.plugins.map((plugin) => plugin.id)).toEqual(
      plugins.map((plugin) => plugin.pluginId),
    );
    expect(
      metadata?.unionSnapshot.index.plugins.find((plugin) => plugin.pluginId === disabled.pluginId)
        ?.enabled,
    ).toBe(false);
    expect(metadata?.byPluginId.get(disabled.pluginId)?.source).toBe(disabled.runtimeSource);
    expect(Object.isFrozen(metadata?.unionSnapshot.index.plugins)).toBe(true);
    expect(structuredClone(registry)).toEqual(registry);
    expect(loader.getMetadata()).toBe(metadata);
  });

  it("keeps exact plugin scope and discovery precedence across workspace unions", () => {
    const { config } = createWorkspaceFixture();
    const cases = [
      {
        pluginIds: undefined,
        expected: [
          "shared-plugin",
          "workspace-0-plugin",
          "workspace-1-plugin",
          "workspace-2-plugin",
          "workspace-3-plugin",
        ],
      },
      {
        pluginIds: ["workspace-3-plugin", "shared-plugin"],
        expected: ["shared-plugin", "workspace-3-plugin"],
      },
      {
        pluginIds: ["shared-plugin", "workspace-3-plugin"],
        expected: ["shared-plugin", "workspace-3-plugin"],
      },
      { pluginIds: [], expected: [] },
      { pluginIds: ["missing-plugin"], expected: [] },
    ];
    for (const { pluginIds, expected } of cases) {
      const registry = resolveConfigWidePluginManifestRegistry({ config, env, pluginIds });
      expect(registry.plugins.map((plugin) => plugin.id)).toEqual(expected);
      expect(structuredClone(registry)).toEqual(registry);
    }
  });

  it("deduplicates the same source but excludes plugin ids from different workspace sources", () => {
    const { config, plugins, workspaceDirs } = createWorkspaceFixture();
    const conflicts = workspaceDirs
      .slice(0, 2)
      .map((workspaceDir) =>
        writePlugin(path.join(workspaceDir, ".openclaw", "extensions", "collision"), "collision"),
      );
    const owner = createPluginMetadataOwner();
    const metadata = owner.prepare({ config, env });
    const registry = resolveConfigWidePluginManifestRegistry({ config, env, metadata });
    const expectedPluginIds = plugins.map((plugin) => plugin.pluginId);

    expect(registry.plugins.map((plugin) => plugin.id)).toEqual(expectedPluginIds);
    expect(metadata.unionSnapshot.index.plugins.map((plugin) => plugin.pluginId)).toEqual(
      expectedPluginIds,
    );
    expect(
      metadata.unionSnapshot.discovery?.candidates.map((candidate) => candidate.idHint),
    ).toEqual(expectedPluginIds);
    expect(structuredClone(registry)).toEqual(registry);
    expect(registry.diagnostics).toContainEqual({
      level: "error",
      pluginId: "collision",
      message: `plugin id "collision" is present in multiple agent workspaces: ${conflicts
        .map((plugin) => plugin.runtimeSource)
        .toSorted()
        .join(", ")}`,
    });
    owner.dispose();
  });

  it("does not borrow an ordinary operation scope after its discovery environment changes", () => {
    const { config } = createWorkspaceFixture();
    const first = writePlugin(path.join(root, "bundled", "first"), "first-bundle");
    const nextBundledRoot = path.join(root, "next-bundled");
    const second = writePlugin(path.join(nextBundledRoot, "second"), "second-bundle");
    const nextEnv = { ...env, OPENCLAW_BUNDLED_PLUGINS_DIR: nextBundledRoot };
    const owner = createPluginMetadataOwner();
    const metadata = owner.prepare({ config, env });

    withPluginMetadataCollectionScope(
      metadata,
      () => {
        const registry = resolveConfigWidePluginManifestRegistry({ config, env: nextEnv });
        expect(registry.plugins.some((plugin) => plugin.id === second.pluginId)).toBe(true);
        expect(registry.plugins.some((plugin) => plugin.id === first.pluginId)).toBe(false);
        expect(() =>
          resolveConfigWidePluginManifestRegistry({ config, env: nextEnv, metadata }),
        ).toThrow("prepared for a different environment");
      },
      { config, env },
    );
    owner.dispose();
  });

  it("lets a prepared config operation override a retained generation using the same snapshot", () => {
    const { config, plugins } = createWorkspaceFixture();
    const owner = createPluginMetadataOwner();
    const metadata = owner.prepare({ config, env });
    const readIds = () =>
      resolveConfigWidePluginManifestRegistry({ config, env }).plugins.map((plugin) => plugin.id);

    withPluginMetadataSnapshotScope(
      metadata.selectedSnapshot,
      () => {
        expect(readIds()).toEqual(["shared-plugin"]);
        withPluginMetadataCollectionScope(
          metadata,
          () => {
            expect(readIds()).toEqual(plugins.map((plugin) => plugin.pluginId));
          },
          { config, env },
        );
        expect(readIds()).toEqual(["shared-plugin"]);
      },
      { config, env, trustConfigIdentity: true },
    );
    owner.dispose();
  });

  it.each(["additional", "selected"] as const)(
    "retains %s auxiliary execution workspaces without including them in config-wide validation",
    (selection) => {
      const { config, plugins, workspaceDirs } = createWorkspaceFixture();
      const oldWorkspace = workspaceDirs[0]!;
      const nextWorkspace = workspaceDirs[1]!;
      const oldCollision = writePlugin(
        path.join(oldWorkspace, ".openclaw", "extensions", "collision"),
        "collision",
      );
      const nextCollision = writePlugin(
        path.join(nextWorkspace, ".openclaw", "extensions", "collision"),
        "collision",
      );
      const owner = createPluginMetadataOwner();
      owner.prepare({ config, env });
      const nextConfig: OpenClawConfig = {
        ...config,
        agents: { ownership: "explicit", entries: { next: { workspace: nextWorkspace } } },
      };

      const metadata = owner.prepare({
        config: nextConfig,
        env,
        ...(selection === "selected"
          ? { workspaceDir: oldWorkspace }
          : { additionalWorkspaceDirs: [oldWorkspace] }),
      });
      const oldExecution = getPluginMetadataWorkspaceSnapshot(metadata, {
        workspaceDir: oldWorkspace,
      });
      expect(oldExecution.byPluginId.get("collision")?.source).toBe(oldCollision.runtimeSource);
      expect(oldExecution.byPluginId.has("workspace-0-plugin")).toBe(true);
      expect(metadata.plugins.map((plugin) => plugin.id).toSorted()).toEqual([
        "collision",
        "shared-plugin",
        "workspace-1-plugin",
      ]);
      expect(metadata.byPluginId.get("collision")?.source).toBe(nextCollision.runtimeSource);
      expect(metadata.owners.providers.has("workspace-0-plugin-provider")).toBe(false);
      expect(metadata.diagnostics.some((diagnostic) => diagnostic.pluginId === "collision")).toBe(
        false,
      );
      for (const plugin of [...plugins, oldCollision, nextCollision]) {
        expect(fs.existsSync(plugin.runtimeMarker)).toBe(false);
      }
      owner.dispose();
    },
  );
});
