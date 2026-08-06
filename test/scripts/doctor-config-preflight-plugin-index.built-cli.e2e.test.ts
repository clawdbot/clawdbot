// Built-CLI proof for durable Doctor plugin-index refresh during gateway startup.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { hasActiveStartupMigrationLease } from "../../src/infra/startup-migration-checkpoint.js";
import {
  readPersistedInstalledPluginIndexSync,
  writePersistedInstalledPluginIndexSync,
} from "../../src/plugins/installed-plugin-index-store.js";
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
  it("starts after replacing and verifying a stale persisted Doctor index", async () => {
    const instance = await createOpenClawTestInstance({
      name: "doctor-plugin-index-persistence",
      env: {
        OPENCLAW_TEST_FAST: "1",
      },
      startTimeoutMs: 90_000,
    });
    instances.push(instance);

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

  it("recovers a missing installed plugin through the built CLI policy refresh", async () => {
    const instance = await createOpenClawTestInstance({
      name: "policy-plugin-index-recovery",
      env: {
        OPENCLAW_TEST_FAST: "1",
      },
      startTimeoutMs: 90_000,
    });
    instances.push(instance);

    const disablePluginId = "policy-refresh-recovery";
    const recoveredPluginId = "policy-refresh-recovered";
    writeManagedNpmPlugin({
      stateDir: instance.stateDir,
      packageName: "@openclaw/policy-refresh-recovery",
      pluginId: disablePluginId,
      version: "1.0.0",
    });
    writeManagedNpmPlugin({
      stateDir: instance.stateDir,
      packageName: "@openclaw/policy-refresh-recovered",
      pluginId: recoveredPluginId,
      version: "1.0.0",
    });
    const config = JSON.parse(fs.readFileSync(instance.configPath, "utf8")) as OpenClawConfig;
    const current = loadPluginMetadataSnapshot({
      config,
      env: instance.env,
      stateDir: instance.stateDir,
    });
    for (const pluginId of [disablePluginId, recoveredPluginId]) {
      expect(current.index.plugins.some((plugin) => plugin.pluginId === pluginId)).toBe(true);
      expect(current.index.installRecords[pluginId]).toBeDefined();
    }

    // The disable target stays in the persisted plugins list so the policy
    // refresh stays on the recovery fast path; the recovered plugin is missing
    // from plugins but keeps a distinct, materializable install record.
    writePersistedInstalledPluginIndexSync(
      {
        ...current.index,
        plugins: current.index.plugins.filter((plugin) => plugin.pluginId !== recoveredPluginId),
      },
      { env: instance.env },
    );
    clearPluginMetadataLifecycleCaches();
    closeOpenClawStateDatabaseForTest();

    const result = await instance.cli(["plugins", "disable", disablePluginId], {
      timeoutMs: 120_000,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Disabled plugin "${disablePluginId}"`);

    clearPluginMetadataLifecycleCaches();
    closeOpenClawStateDatabaseForTest();
    const persisted = readPersistedInstalledPluginIndexSync({ env: instance.env });
    expect(persisted?.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginId: disablePluginId, enabled: false }),
        expect.objectContaining({ pluginId: recoveredPluginId }),
      ]),
    );
  }, 120_000);
});
