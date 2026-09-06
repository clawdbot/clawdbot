// Built-CLI proof for durable Doctor plugin-index refresh during gateway startup.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDefaultAgentWorkspaceDir } from "../../src/agents/workspace-default.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { hasActiveStartupMigrationLease } from "../../src/infra/startup-migration-checkpoint.js";
import { writePersistedInstalledPluginIndexSync } from "../../src/plugins/installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndexSync } from "../../src/plugins/installed-plugin-index-store.js";
import { clearPluginMetadataLifecycleCaches } from "../../src/plugins/plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../../src/plugins/plugin-metadata-snapshot.js";
import { writeManagedNpmPlugin } from "../../src/plugins/test-helpers/managed-npm-plugin.js";
import { closeOpenClawStateDatabaseForTest } from "../../src/state/openclaw-state-db.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../helpers/openclaw-test-instance.js";

const instances: OpenClawTestInstance[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.cleanup()));
  clearPluginMetadataLifecycleCaches();
  closeOpenClawStateDatabaseForTest();
});

describe("Doctor plugin index persistence built CLI proof", () => {
  it("starts after linking an empty legacy state dir to the canonical root", async () => {
    const instance = await createOpenClawTestInstance({
      name: "doctor-empty-legacy-state-dir",
      env: {
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_TEST_FAST: "1",
      },
      startTimeoutMs: 90_000,
    });
    instances.push(instance);
    const legacyDir = path.join(instance.homeDir, ".clawdbot");
    fs.mkdirSync(legacyDir, { recursive: true });

    await instance.startGateway();

    expect(fs.realpathSync(legacyDir), instance.logs()).toBe(fs.realpathSync(instance.stateDir));

    await instance.stopGateway();
    await instance.startGateway();
    expect(fs.realpathSync(legacyDir), instance.logs()).toBe(fs.realpathSync(instance.stateDir));
  }, 120_000);

  it("starts after replacing and verifying a stale persisted Doctor index", async () => {
    const instance = await createOpenClawTestInstance({
      name: "doctor-plugin-index-persistence",
      env: {
        OPENCLAW_TEST_FAST: "1",
      },
      startTimeoutMs: 90_000,
    });
    instances.push(instance);
    const workspaceDir = resolveDefaultAgentWorkspaceDir(instance.env);

    const config = JSON.parse(fs.readFileSync(instance.configPath, "utf8")) as OpenClawConfig;
    const pluginId = "legacy-doctor-index";
    const pluginDir = writeManagedNpmPlugin({
      stateDir: instance.stateDir,
      packageName: "@openclaw/legacy-doctor-index",
      pluginId,
      version: "1.0.0",
    });
    const packageJsonPath = path.join(pluginDir, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      openclaw: Record<string, unknown>;
    };
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({
        ...packageJson,
        openclaw: {
          ...packageJson.openclaw,
          build: {
            bundledDist: false,
            openclawVersion: "2026.7.2",
            pluginSdkVersion: "2026.7.2",
          },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "doctor-contract-api.cjs"),
      "module.exports = { stateMigrations: [] };\n",
      "utf8",
    );

    const current = loadPluginMetadataSnapshot({
      config,
      env: instance.env,
      stateDir: instance.stateDir,
      workspaceDir,
    });
    const legacyIndex = {
      ...current.index,
      plugins: current.index.plugins.map((plugin) => {
        const {
          doctorContractFile: _doctorContractFile,
          doctorContractHash: _doctorContractHash,
          ...legacyPlugin
        } = plugin;
        return legacyPlugin;
      }),
    };
    writePersistedInstalledPluginIndexSync(legacyIndex, { env: instance.env });
    clearPluginMetadataLifecycleCaches();
    closeOpenClawStateDatabaseForTest();

    expect(await instance.entrypoint()).toEqual([
      expect.stringMatching(/^dist\/index\.(?:js|mjs)$/u),
    ]);
    await instance.startGateway();
    expect(hasActiveStartupMigrationLease({ env: instance.env }), instance.logs()).toBe(false);

    clearPluginMetadataLifecycleCaches();
    closeOpenClawStateDatabaseForTest();
    const reread = loadPluginMetadataSnapshot({
      config,
      env: instance.env,
      stateDir: instance.stateDir,
      workspaceDir,
      allowCurrent: false,
    });
    expect(reread.registrySource, instance.logs()).toBe("persisted");
    expect(reread.registryDiagnostics, instance.logs()).toStrictEqual([]);

    const persisted = readPersistedInstalledPluginIndexSync({ env: instance.env });
    const persistedPlugin = persisted?.plugins.find((plugin) => plugin.pluginId === pluginId);
    expect(persistedPlugin, instance.logs()).toMatchObject({
      doctorContractFile: {
        ctimeMs: expect.any(Number),
        mtimeMs: expect.any(Number),
        size: expect.any(Number),
      },
      doctorContractHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      packageBuild: { bundledDist: false },
    });
  }, 120_000);
});
