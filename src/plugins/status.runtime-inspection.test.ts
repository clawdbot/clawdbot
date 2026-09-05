import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { readConfigFileSnapshotForWrite, writeConfigFile } from "../config/config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnv, withEnvAsync } from "../test-utils/env.js";
import { setGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { getGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { persistPluginInstall, selectInstallMutationWriteOptions } from "./install-persistence.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { getActivePluginRegistry } from "./runtime.js";
import { applySlotSelectionForPlugin } from "./slot-selection.js";
import { buildPluginDiagnosticsReport } from "./status.js";

describe("plugin runtime inspection", () => {
  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    resetPluginLoaderTestStateForTest();
    closeOpenClawStateDatabaseForTest();
  });

  afterAll(() => {
    cleanupPluginLoaderFixturesForTest();
  });

  it("selects a newly installed legacy runtime kind without changing the running inventory", () => {
    const plugin = writePlugin({
      id: "legacy-memory-candidate",
      body: 'module.exports = { id: "legacy-memory-candidate", kind: "memory", register() {} };\n',
    });
    const config = {
      plugins: {
        load: { paths: [plugin.file] },
        allow: [plugin.id],
        entries: { [plugin.id]: { enabled: true } },
      },
    };

    withEnv({ OPENCLAW_STATE_DIR: makePluginLoaderTempDir() }, () => {
      useNoBundledPlugins();
      const bootConfig = { plugins: { enabled: false } };
      const boot = loadPluginMetadataSnapshot({ config: bootConfig, env: process.env });
      setGatewayPluginMetadataSnapshot(boot, { config: bootConfig, env: process.env });
      const activeRegistry = getActivePluginRegistry();

      const result = applySlotSelectionForPlugin(config, plugin.id);

      expect(result.config.plugins?.slots?.memory).toBe(plugin.id);
      expect(getGatewayPluginMetadataSnapshot()).toBe(boot);
      expect(getActivePluginRegistry()).toBe(activeRegistry);
    });
  });

  it.each([
    { source: "npm", kind: "memory", mode: "ready", slots: ["memory"] },
    { source: "marketplace", kind: "memory", mode: "ready", slots: ["memory"] },
    { source: "npm", kind: "context-engine", mode: "ready", slots: ["contextEngine"] },
    {
      source: "npm",
      kind: ["memory", "context-engine"],
      mode: "ready",
      slots: ["memory", "contextEngine"],
    },
    { source: "npm", kind: undefined, mode: "ready", slots: ["memory"] },
    { source: "npm", kind: "memory", mode: "disabled", slots: [] },
    { source: "npm", kind: "memory", mode: "requires-config", slots: [] },
  ] as const)("persists first-install slots for $source ($kind, $mode)", async (testCase) => {
    const stateDir = makePluginLoaderTempDir();
    const configPath = path.join(stateDir, "openclaw.json");
    await withEnvAsync(
      {
        OPENCLAW_HOME: stateDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      },
      async () => {
        useNoBundledPlugins();
        await writeConfigFile({});
        await withPluginLifecycleLease({}, async () => {
          const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
          // Warm the same empty operation inventory that precedes installer publication.
          loadPluginMetadataSnapshot({ allowCurrent: false, config: snapshot.config });
          const pluginId = "first-slot-candidate";
          const pluginDir =
            testCase.source === "npm"
              ? path.join(stateDir, "npm", "projects", pluginId, "node_modules", pluginId)
              : path.join(stateDir, "extensions", pluginId);
          fs.mkdirSync(pluginDir, { recursive: true });
          fs.writeFileSync(
            path.join(pluginDir, "package.json"),
            JSON.stringify({
              name: pluginId,
              version: "1.0.0",
              openclaw: { extensions: ["./index.cjs"] },
            }),
          );
          fs.writeFileSync(
            path.join(pluginDir, "openclaw.plugin.json"),
            JSON.stringify({
              id: pluginId,
              kind: testCase.kind,
              configSchema:
                testCase.mode === "requires-config"
                  ? {
                      type: "object",
                      properties: { apiKey: { type: "string" } },
                      required: ["apiKey"],
                    }
                  : { type: "object", additionalProperties: false, properties: {} },
            }),
          );
          fs.writeFileSync(
            path.join(pluginDir, "index.cjs"),
            `module.exports = { id: ${JSON.stringify(pluginId)}, kind: ${JSON.stringify(testCase.kind ?? "memory")}, register() {} };\n`,
          );

          const next = await persistPluginInstall({
            snapshot: {
              config: snapshot.config,
              baseHash: snapshot.hash ?? undefined,
              writeOptions,
            },
            pluginId,
            install: { source: testCase.source, installPath: pluginDir, version: "1.0.0" },
            enable: testCase.mode !== "disabled",
          });

          const expectedSlots = testCase.slots.length
            ? Object.fromEntries(testCase.slots.map((slot) => [slot, pluginId]))
            : undefined;
          expect(next.plugins?.slots).toEqual(expectedSlots);
          const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
          expect(persisted.plugins?.slots).toEqual(expectedSlots);
          expect(persisted.plugins?.load?.paths).toBeUndefined();
          expect(
            (await readPersistedInstalledPluginIndexInstallRecords())?.[pluginId],
          ).toMatchObject({
            source: testCase.source,
            installPath: pluginDir,
          });
        });
      },
    );
  });

  it.each([false, true])(
    "uses replaced package metadata while preserving its old snapshot (requires config: %s)",
    async (requiresConfig) => {
      const stateDir = makePluginLoaderTempDir();
      const configPath = path.join(stateDir, "openclaw.json");
      const pluginId = "same-path-candidate";
      const pluginDir = path.join(stateDir, "extensions", pluginId);
      const writeVersion = (version: "1.0.0" | "2.0.0") => {
        fs.mkdirSync(pluginDir, { recursive: true });
        fs.writeFileSync(
          path.join(pluginDir, "package.json"),
          JSON.stringify({ name: pluginId, version, openclaw: { extensions: ["./index.cjs"] } }),
        );
        fs.writeFileSync(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
            id: pluginId,
            version,
            kind: version === "1.0.0" ? "context-engine" : ["context-engine", "memory"],
            configSchema:
              version === "2.0.0" && requiresConfig
                ? { type: "object", properties: { token: { type: "string" } }, required: ["token"] }
                : { type: "object" },
          }),
        );
        fs.writeFileSync(
          path.join(pluginDir, "index.cjs"),
          "module.exports = { register() {} };\n",
        );
      };
      const persistVersion = (
        version: string,
        { snapshot, writeOptions }: Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>>,
      ) =>
        persistPluginInstall({
          snapshot: {
            config: snapshot.sourceConfig,
            baseHash: snapshot.hash ?? undefined,
            writeOptions: selectInstallMutationWriteOptions(writeOptions),
          },
          pluginId,
          install: { source: "path", installPath: pluginDir, version },
        });

      await withEnvAsync(
        { OPENCLAW_HOME: stateDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
        async () => {
          useNoBundledPlugins();
          await writeConfigFile({});
          writeVersion("1.0.0");
          await withPluginLifecycleLease({}, async () => {
            await persistVersion("1.0.0", await readConfigFileSnapshotForWrite());
          });
          const before = await withPluginLifecycleLease({}, async () => {
            const prepared = await readConfigFileSnapshotForWrite();
            const retainedSnapshot = loadPluginMetadataSnapshot({
              allowCurrent: false,
              config: prepared.snapshot.sourceConfig,
            });
            expect(prepared.snapshot.sourceConfig.plugins?.slots?.contextEngine).toBe(pluginId);

            // The installer replaces this path after the operation has inspected v1.
            writeVersion("2.0.0");
            await persistVersion("2.0.0", prepared);
            return retainedSnapshot;
          });
          const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
          expect(persisted.plugins.entries[pluginId].enabled).toBe(!requiresConfig);
          if (requiresConfig) {
            expect(persisted.plugins.slots?.memory).toBeUndefined();
          } else {
            expect(persisted.plugins.slots).toEqual({ contextEngine: pluginId, memory: pluginId });
          }
          const index = await readPersistedInstalledPluginIndex();
          expect(index?.installRecords[pluginId]).toMatchObject({
            installPath: pluginDir,
            version: "2.0.0",
          });
          expect(index?.plugins.find((plugin) => plugin.pluginId === pluginId)).toMatchObject({
            packageVersion: "2.0.0",
            enabled: !requiresConfig,
            startup: { memory: true },
          });
          expect(before.byPluginId.get(pluginId)).toMatchObject({
            version: "1.0.0",
            kind: "context-engine",
          });
          expect(before.byPluginId.get(pluginId)?.configSchema).toEqual({ type: "object" });
        },
      );
    },
  );

  it("rechecks install authority before inspecting each legacy package entry", async () => {
    const stateDir = makePluginLoaderTempDir();
    const configPath = path.join(stateDir, "openclaw.json");
    await withEnvAsync(
      {
        OPENCLAW_HOME: stateDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      },
      async () => {
        useNoBundledPlugins();
        await writeConfigFile({});
        await withPluginLifecycleLease({}, async () => {
          const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
          const previousConfig = fs.readFileSync(configPath, "utf8");
          loadPluginMetadataSnapshot({ allowCurrent: false, config: snapshot.config });
          const pluginId = "slot-authority-candidate";
          const pluginDir = path.join(
            stateDir,
            "npm",
            "projects",
            pluginId,
            "node_modules",
            pluginId,
          );
          fs.mkdirSync(pluginDir, { recursive: true });
          fs.writeFileSync(
            path.join(pluginDir, "package.json"),
            JSON.stringify({
              name: pluginId,
              version: "1.0.0",
              openclaw: { extensions: ["./first.cjs", "./second.cjs"] },
            }),
          );
          fs.writeFileSync(
            path.join(pluginDir, "openclaw.plugin.json"),
            JSON.stringify({ id: pluginId, configSchema: { type: "object" } }),
          );
          for (const [entry, kind] of [
            ["first", "memory"],
            ["second", "context-engine"],
          ]) {
            fs.writeFileSync(
              path.join(pluginDir, `${entry}.cjs`),
              `require("node:fs").writeFileSync(${JSON.stringify(path.join(stateDir, `${entry}.txt`))}, "imported");
module.exports = { id: ${JSON.stringify(`${pluginId}/${entry}`)}, kind: ${JSON.stringify(kind)}, register() {} };
`,
            );
          }
          let authorityActive = true;

          await expect(
            persistPluginInstall({
              snapshot: {
                config: snapshot.config,
                baseHash: snapshot.hash ?? undefined,
                writeOptions,
              },
              pluginId,
              install: { source: "npm", installPath: pluginDir, version: "1.0.0" },
              beforePersistentApply() {
                if (!authorityActive) {
                  throw new Error("install authority closed");
                }
                queueMicrotask(() => {
                  authorityActive = false;
                });
              },
            }),
          ).rejects.toThrow("install authority closed");

          expect(fs.existsSync(path.join(stateDir, "first.txt"))).toBe(true);
          expect(fs.existsSync(path.join(stateDir, "second.txt"))).toBe(false);
          expect(fs.readFileSync(configPath, "utf8")).toBe(previousConfig);
          expect(
            (await readPersistedInstalledPluginIndexInstallRecords())?.[pluginId],
          ).toBeUndefined();
        });
      },
    );
  });

  it("captures full registrations through the non-activating inspection mode", () => {
    const pluginDir = makePluginLoaderTempDir();
    const registrationModePath = path.join(pluginDir, "registration-mode.txt");
    const plugin = writePlugin({
      id: "runtime-inspection-route",
      dir: pluginDir,
      body: `module.exports = {
  id: "runtime-inspection-route",
  register(api) {
    require("node:fs").writeFileSync(
      ${JSON.stringify(registrationModePath)},
      api.registrationMode,
      "utf8",
    );
    if (api.registrationMode === "tool-discovery") {
      api.registerHttpRoute({
        path: "/runtime-inspection",
        auth: "plugin",
        handler() { return true; },
      });
    }
  },
};\n`,
    });
    const stateDir = makePluginLoaderTempDir();
    const config = {
      plugins: {
        load: { paths: [plugin.file] },
        allow: [plugin.id],
      },
    };

    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      useNoBundledPlugins();
      const params = { config, workspaceDir: plugin.dir, env: process.env };

      const diagnostics = buildPluginDiagnosticsReport(params);
      expect(diagnostics.plugins.find((entry) => entry.id === plugin.id)?.httpRoutes).toBe(0);
      expect(fs.readFileSync(registrationModePath, "utf8")).toBe("discovery");

      const runtimeInspectionParams = { ...params, runtimeInspection: true };
      const runtimeInspection = buildPluginDiagnosticsReport(runtimeInspectionParams);
      expect(runtimeInspection.plugins.find((entry) => entry.id === plugin.id)?.httpRoutes).toBe(1);
      expect(fs.readFileSync(registrationModePath, "utf8")).toBe("tool-discovery");
    });
  });
});
