import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { handlePluginsCommand } from "../auto-reply/reply/commands-plugins.js";
import { buildPluginsCommandParams } from "../auto-reply/reply/commands.test-harness.js";
import { runPluginsDoctorCommand } from "../cli/plugins-cli.runtime.js";
import { runPluginsInspectCommand } from "../cli/plugins-inspect-command.js";
import { readConfigFileSnapshotForWrite, writeConfigFile } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnv, withEnvAsync } from "../test-utils/env.js";
import { setGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { getGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { selectInstallMutationWriteOptions } from "./install-config-mutation.js";
import { persistPluginInstall } from "./install-persistence.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { loadAndActivateRootPluginRegistry } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { mutateManagedPluginEnabled } from "./management-mutations.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import {
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
} from "./registry-lifecycle.js";
import { getActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { applySlotSelectionForPlugin } from "./slot-selection.js";
import * as statusSnapshot from "./status-snapshot.js";
import {
  withPluginDiagnosticsReportForInspection,
  buildPluginDiagnosticsReport,
} from "./status.js";

describe("plugin runtime inspection", () => {
  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    resetPluginLoaderTestStateForTest();
    closeOpenClawStateDatabaseForTest();
  });

  afterAll(() => {
    cleanupPluginLoaderFixturesForTest();
  });

  it.each([
    "inspect",
    "inspect native-chat-inspection",
    "inspect all",
    "inspect missing",
    "doctor",
    "doctor-json",
  ])(
    "releases inspection while the active native registration stays usable: %s",
    async (selection) => {
      const stateDir = makePluginLoaderTempDir();
      const doctor = selection.startsWith("doctor");
      const previousExitCode = process.exitCode;
      const output: string[] = [];
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation((value) => {
        output.push(String(value));
      });
      const writeStdout = vi.spyOn(defaultRuntime, "writeStdout").mockImplementation((value) => {
        output.push(value);
      });
      const key = `__openclaw_chat_inspection_${selection}`;
      const started = createDeferredCore();
      const finish = createDeferredCore();
      const connections: Array<{
        database: DatabaseSync;
        mode: string;
        disposals: number;
        cleanups: number;
      }> = [];
      Object.defineProperty(globalThis, key, {
        value: { connections, started, finish },
        configurable: true,
      });
      const plugin = writePlugin({
        id: "native-chat-inspection",
        body: `
const { DatabaseSync } = require("node:sqlite");
module.exports = { id: "native-chat-inspection", register(api) {
  const state = globalThis[${JSON.stringify(key)}];
  const database = new DatabaseSync(${JSON.stringify(path.join(stateDir, "connection-"))} + state.connections.length + ".sqlite");
  database.exec("CREATE TABLE owned (value INTEGER); INSERT INTO owned VALUES (42)");
  const connection = { database, mode: api.registrationMode, disposals: 0, cleanups: 0 };
  state.connections.push(connection);
  class NativeLifecycle {
    id = "native-chat-resource";
    #database = database;
    async dispose() {
      connection.disposals++;
      state.started.resolve();
      await state.finish.promise;
      this.#database.close();
    }
    cleanup = () => { connection.cleanups++; };
  }
  api.registerRuntimeLifecycle(new NativeLifecycle());
} };`,
      });
      let command: ReturnType<typeof handlePluginsCommand> | undefined;
      try {
        await withEnvAsync(
          {
            OPENCLAW_HOME: stateDir,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
          },
          async () => {
            useNoBundledPlugins();
            const config = {
              commands: { text: true, plugins: true },
              ...(doctor
                ? {
                    agents: {
                      defaults: { systemAgent: { agentId: "main" } },
                      entries: { main: { workspace: stateDir } },
                    },
                  }
                : {}),
              plugins: {
                allow: [plugin.id],
                load: { paths: [plugin.file] },
                slots: { memory: "none" },
              },
            };
            if (doctor) {
              // Existing configs preserve omitted catalog preferences; fresh installs initialize stock catalogs.
              fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}");
            }
            await writeConfigFile(config);
            const active = loadAndActivateRootPluginRegistry({
              config,
              workspaceDir: stateDir,
              cache: false,
            });
            const epoch = capturePluginRegistryLifecycleEpoch(active);
            const signal = capturePluginRegistryLifecycleSignal(active, epoch);
            expect(epoch).toBeDefined();
            expect(signal?.aborted).toBe(false);
            const activeConnection = connections[0];
            expect(activeConnection?.mode).toBe("full");
            const readActive = () =>
              activeConnection?.database.prepare("SELECT value FROM owned").get();
            expect(readActive()).toEqual({ value: 42 });
            let replied = false;
            if (doctor) {
              process.exitCode = 7;
            }
            command = withPluginRuntimeRegistryScope(active, () =>
              doctor
                ? runPluginsDoctorCommand({ json: selection === "doctor-json" }).then(() => null)
                : handlePluginsCommand(
                    buildPluginsCommandParams({
                      commandBodyNormalized: `/plugins ${selection}`,
                      cfg: config,
                      workspaceDir: stateDir,
                    }),
                    true,
                  ),
            ).then((result) => {
              replied = true;
              return result;
            });
            await Promise.race([started.promise, command]);
            expect(connections).toHaveLength(2);
            const inspection = connections[1];
            expect(inspection?.mode).toBe("discovery");
            expect(inspection?.disposals).toBe(1);
            expect(inspection?.database.isOpen).toBe(true);
            expect(replied).toBe(false);
            if (doctor) {
              expect(output).toEqual([]);
              expect(process.exitCode).toBe(7);
            }
            expect(readActive()).toEqual({ value: 42 });
            expect(getActivePluginRegistry()).toBe(active);
            expect(capturePluginRegistryLifecycleEpoch(active)).toBe(epoch);
            expect(signal?.aborted).toBe(false);
            finish.resolve();
            const result = await command;
            if (doctor) {
              expect(output).toHaveLength(1);
              expect(process.exitCode, output.join("\n")).toBe(0);
              if (selection === "doctor-json") {
                expect(JSON.parse(output[0] ?? "")).toMatchObject({
                  ok: true,
                  pluginErrors: [],
                  diagnostics: [],
                  configurationWarnings: [],
                });
              } else {
                expect(output[0]).toContain(
                  "Plugin discovery, module loading, compatibility, and configuration checks passed.",
                );
              }
            } else {
              expect(result?.shouldContinue).toBe(false);
              expect(result?.reply?.text).toContain(
                selection === "inspect missing"
                  ? 'No plugin named "missing" found.'
                  : selection === "inspect"
                    ? "Plugins ("
                    : "```json",
              );
            }
            expect(inspection?.database.isOpen).toBe(false);
            expect(inspection?.disposals).toBe(1);
            expect(activeConnection?.disposals).toBe(0);
            expect(connections.map((connection) => connection.cleanups)).toEqual([0, 0]);
            expect(readActive()).toEqual({ value: 42 });
            expect(getActivePluginRegistry()).toBe(active);
            expect(capturePluginRegistryLifecycleEpoch(active)).toBe(epoch);
            expect(signal?.aborted).toBe(false);
          },
        );
      } finally {
        finish.resolve();
        try {
          await command;
        } finally {
          for (const { database } of connections) {
            if (database.isOpen) {
              database.close();
            }
          }
          Reflect.deleteProperty(globalThis, key);
          log.mockRestore();
          writeStdout.mockRestore();
          process.exitCode = previousExitCode;
        }
      }
    },
  );

  it.each([
    "single",
    "all",
    "projection-error",
    "projection-and-disposal-error",
    "serialization-error",
    "serialization-and-disposal-error",
    "raw",
  ] as const)("keeps native inspection custody through %s", async (mode) => {
    const all = mode === "all";
    const stateDir = makePluginLoaderTempDir();
    const databasePath = path.join(stateDir, "inspection.sqlite");
    const key = `__openclaw_inspect_${mode}`;
    const state: {
      database?: DatabaseSync;
      disposals: number;
      cleanups: number;
      factories: number;
    } = {
      disposals: 0,
      cleanups: 0,
      factories: 0,
    };
    Object.defineProperty(globalThis, key, { value: state, configurable: true });
    const plugin = writePlugin({
      id: "native-cli-inspection",
      body: `const { DatabaseSync } = require("node:sqlite");
module.exports = {
  id: "native-cli-inspection",
  register(api) {
    const state = globalThis[${JSON.stringify(key)}];
    const database = new DatabaseSync(${JSON.stringify(databasePath)});
    database.exec("CREATE TABLE inspection (value INTEGER); INSERT INTO inspection VALUES (42)");
    state.database = database;
    class NativeLifecycle {
      id = "native-resource";
      #database = database;
      async dispose() {
        state.disposals++;
        this.#database.close();
        if (${mode.endsWith("and-disposal-error")}) throw new Error("fixture disposal failed");
      }
      cleanup() { state.cleanups++; }
    }
    api.registerRuntimeLifecycle(new NativeLifecycle());
    api.registerContextEngine("native-cli-inspection", () => {
      state.factories++;
      throw new Error("inspection must not invoke factories");
    });
    api.registerHttpRoute({ path: "/inspection", auth: "plugin", handler() { return true; } });
  },
};`,
    });
    const output: string[] = [];
    const writeStdout = vi.spyOn(defaultRuntime, "writeStdout").mockImplementation((value) => {
      expect(state.database?.isOpen).toBe(false);
      output.push(value);
    });
    const projectionError = new Error("fixture report projection failed");
    const projection = vi.spyOn(statusSnapshot, "collectPluginCapabilityConsentDiagnostics");
    try {
      await withEnvAsync(
        {
          OPENCLAW_HOME: stateDir,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        },
        async () => {
          useNoBundledPlugins();
          const config = { plugins: { allow: [plugin.id], load: { paths: [plugin.file] } } };
          await writeConfigFile(config);
          const active = getActivePluginRegistry();
          if (mode === "raw") {
            const report = buildPluginDiagnosticsReport({ config, runtimeInspection: true });
            expect(report.plugins[0]?.id).toBe(plugin.id);
            expect(state.database?.isOpen).toBe(true);
            expect(state.disposals).toBe(0);
            expect(getActivePluginRegistry()).toBe(active);
            return;
          }
          if (mode.includes("error")) {
            if (mode.startsWith("projection")) {
              projection.mockImplementation(() => {
                throw projectionError;
              });
            }
            const inspection = withPluginDiagnosticsReportForInspection(
              { config, runtimeInspection: true },
              (report) => {
                expect(report.plugins[0]?.id).toBe(plugin.id);
                expect(state.database?.prepare("SELECT value FROM inspection").get()).toEqual({
                  value: 42,
                });
                return JSON.stringify({
                  toJSON() {
                    throw projectionError;
                  },
                });
              },
            );
            if (!mode.includes("and-disposal")) {
              await expect(inspection).rejects.toBe(projectionError);
            } else {
              await expect(inspection).rejects.toMatchObject({
                errors: [projectionError, expect.any(AggregateError)],
              });
            }
          } else {
            await runPluginsInspectCommand(all ? undefined : plugin.id, {
              all,
              runtime: true,
              json: true,
            });
            expect(getActivePluginRegistry()).toBe(active);
            expect(output).toHaveLength(1);
            const parsed = JSON.parse(output[0] ?? "");
            expect(all ? parsed[0] : parsed).toMatchObject({
              plugin: { id: plugin.id },
              httpRouteCount: 1,
            });
          }
          expect(getActivePluginRegistry()).toBe(active);
          expect(state.disposals).toBe(1);
          expect(state.database?.isOpen).toBe(false);
          expect(state.cleanups).toBe(0);
          expect(state.factories).toBe(0);
          const reopened = new DatabaseSync(databasePath, { readOnly: true });
          try {
            expect(reopened.prepare("SELECT value FROM inspection").get()).toEqual({ value: 42 });
          } finally {
            reopened.close();
          }
        },
      );
    } finally {
      projection.mockRestore();
      writeStdout.mockRestore();
      if (state.database?.isOpen) {
        state.database.close();
      }
      Reflect.deleteProperty(globalThis, key);
    }
  });

  it.each([
    { source: "bundled", kind: undefined, runtimeKind: undefined },
    { source: "bundled", kind: "memory", runtimeKind: undefined },
    { source: "config", kind: undefined, runtimeKind: "memory" },
  ] as const)(
    "enables a $source plugin with manifest kind $kind and runtime kind $runtimeKind",
    async ({ source, kind, runtimeKind }) => {
      const stateDir = makePluginLoaderTempDir();
      const bundledDir = makePluginLoaderTempDir();
      const pluginId = "policy-candidate";
      const imported = path.join(stateDir, "runtime-imported");
      const plugin = writePlugin({
        id: pluginId,
        dir: path.join(bundledDir, pluginId),
        filename: "index.cjs",
        body: `require("node:fs").writeFileSync(${JSON.stringify(imported)}, "imported"); module.exports = { id: ${JSON.stringify(pluginId)}, kind: ${JSON.stringify(runtimeKind)}, register() {} };`,
      });
      const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, ...(kind ? { kind } : {}) }));
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: source === "bundled" ? undefined : "1",
        },
        async () => {
          await writeConfigFile({
            plugins: {
              ...(source === "config" ? { load: { paths: [plugin.file] }, allow: [pluginId] } : {}),
              entries: { [pluginId]: { enabled: false } },
            },
          });
          const result = await mutateManagedPluginEnabled({
            pluginId,
            enabled: true,
            caller: "cli",
          });
          expect(result.status).toBe("committed");
          const { snapshot } = await readConfigFileSnapshotForWrite();
          expect(snapshot.sourceConfig.plugins?.entries?.[pluginId]?.enabled).toBe(true);
          expect(snapshot.sourceConfig.plugins?.slots?.memory).toBe(
            kind || runtimeKind ? pluginId : undefined,
          );
          expect(fs.existsSync(imported)).toBe(source !== "bundled");
        },
      );
    },
  );

  it("selects a newly installed legacy runtime kind without changing the running inventory", async () => {
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

    await withEnvAsync({ OPENCLAW_STATE_DIR: makePluginLoaderTempDir() }, async () => {
      useNoBundledPlugins();
      const bootConfig = { plugins: { enabled: false } };
      const boot = loadPluginMetadataSnapshot({ config: bootConfig, env: process.env });
      setGatewayPluginMetadataSnapshot(boot, { config: bootConfig, env: process.env });
      const activeRegistry = getActivePluginRegistry();

      const result = await applySlotSelectionForPlugin(config, plugin.id);

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

  it.each(["during-import", "between-entries"] as const)(
    "rechecks install authority when it closes %s",
    async (closedAt) => {
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
                  if (
                    !authorityActive ||
                    (closedAt === "between-entries" &&
                      fs.existsSync(path.join(stateDir, "first.txt")))
                  ) {
                    throw new Error("install authority closed");
                  }
                  if (closedAt === "during-import") {
                    queueMicrotask(() => {
                      authorityActive = false;
                    });
                  }
                },
              }),
            ).rejects.toThrow("install authority closed");

            expect(fs.existsSync(path.join(stateDir, "first.txt"))).toBe(
              closedAt === "between-entries",
            );
            expect(fs.existsSync(path.join(stateDir, "second.txt"))).toBe(false);
            expect(fs.readFileSync(configPath, "utf8")).toBe(previousConfig);
            expect(
              (await readPersistedInstalledPluginIndexInstallRecords())?.[pluginId],
            ).toBeUndefined();
          });
        },
      );
    },
  );

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
