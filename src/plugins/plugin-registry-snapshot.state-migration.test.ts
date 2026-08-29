import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  persistRefreshedPluginIndex,
  type DoctorConfigPreflightPluginSnapshotRead,
} from "../commands/doctor-config-preflight-plugin-index.js";
import { resolveConfigWidePluginMetadataSnapshot } from "../config/io.plugin-metadata.js";
import { createConfigFileSnapshot } from "../config/io.snapshot-shared.js";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  acquireStartupMigrationLease,
  needsStateMigrationCheckpoint,
  recordSuccessfulStateMigrations,
  type MigrationCheckpointIdentity,
} from "../infra/startup-migration-checkpoint.js";
import {
  autoMigrateLegacyPluginDoctorState,
  resetAutoMigrateLegacyStateForTest,
} from "../infra/state-migrations.doctor.js";
import { resetAutoMigrateLegacyStateDirForTest } from "../infra/state-migrations.state-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { clearPluginDoctorContractRegistryCache } from "./doctor-contract-registry.test-fixtures.js";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "./test-helpers/fs-fixtures.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs: string[] = [];

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
});

afterEach(() => {
  clearPluginDoctorContractRegistryCache();
  clearPluginMetadataLifecycleCaches();
  resetAutoMigrateLegacyStateForTest();
  resetAutoMigrateLegacyStateDirForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-plugin-registry-migration", tempDirs);
}

function checkpointIdentity(snapshot: PluginMetadataSnapshot): MigrationCheckpointIdentity {
  if (!snapshot.configFingerprint) {
    throw new Error("expected plugin migration fingerprint");
  }
  const configFingerprint = hashRuntimeConfigValue({});
  return {
    effectiveConfigFingerprint: configFingerprint,
    pluginDoctorConfigFingerprint: configFingerprint,
    pluginMigrationFingerprint: snapshot.configFingerprint,
  };
}

function requirePlugin(snapshot: PluginMetadataSnapshot, pluginId: string) {
  const plugin = snapshot.index.plugins.find((candidate) => candidate.pluginId === pluginId);
  if (!plugin) {
    throw new Error(`expected plugin ${pluginId}`);
  }
  return plugin;
}

describe("persisted plugin registry Doctor contract freshness", () => {
  it("persists a workspace registry without losing config-wide plugins or diagnostics", async () => {
    const rootDir = fs.realpathSync(makeTempDir());
    const stateDir = path.join(rootDir, "state");
    const primaryWorkspace = path.join(rootDir, "primary");
    const secondaryWorkspace = path.join(rootDir, "secondary");
    const configuredPluginDir = path.join(rootDir, "configured-plugin");
    for (const [pluginId, pluginRoot] of [
      ["shared-plugin", path.join(stateDir, "extensions", "shared-plugin")],
      ["shared-plugin", configuredPluginDir],
      [
        "secondary-plugin",
        path.join(secondaryWorkspace, ".openclaw", "extensions", "secondary-plugin"),
      ],
    ] as const) {
      mkdirSafeDir(pluginRoot);
      createColdPluginFixture({
        rootDir: pluginRoot,
        pluginId,
        manifest: { channels: [], channelConfigs: {}, providers: [], providerAuthChoices: [] },
      });
    }
    const env = {
      HOME: rootDir,
      OPENCLAW_HOME: rootDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.7.1",
      VITEST: "true",
    };
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          primary: { workspace: primaryWorkspace },
          secondary: { workspace: secondaryWorkspace },
        },
      },
      plugins: {
        // A configured load path forces comparison with fresh workspace discovery.
        load: { paths: [configuredPluginDir] },
        entries: { "shared-plugin": { enabled: true }, "secondary-plugin": { enabled: true } },
      },
    };
    const snapshot = createConfigFileSnapshot({
      path: path.join(stateDir, "openclaw.json"),
      exists: true,
      raw: JSON.stringify(config),
      parsed: config,
      sourceConfig: config,
      runtimeConfig: config,
      valid: true,
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    const readSnapshot = async (): Promise<DoctorConfigPreflightPluginSnapshotRead> => {
      clearPluginMetadataLifecycleCaches();
      const pluginMetadataSnapshot = resolveConfigWidePluginMetadataSnapshot({
        config,
        env,
        stateDir,
        allowCurrent: false,
      });
      return {
        snapshot,
        pluginMetadataSnapshot,
        pluginMigrationFingerprint: pluginMetadataSnapshot.configFingerprint ?? null,
      };
    };
    const derived = await readSnapshot();
    expect(derived.pluginMetadataSnapshot?.registrySource).toBe("derived");
    expect(derived.pluginMetadataSnapshot?.index.plugins.map((plugin) => plugin.pluginId)).toEqual([
      "shared-plugin",
      "secondary-plugin",
    ]);
    expect(derived.pluginMetadataSnapshot?.diagnostics).toHaveLength(2);

    const lease = acquireStartupMigrationLease({ env });
    try {
      const persisted = await persistRefreshedPluginIndex({
        env,
        lease,
        measure: async (_name, run) => await run(),
        snapshotRead: derived,
        readPersistedSnapshot: readSnapshot,
      });
      expect(persisted.pluginMetadataSnapshot?.registrySource).toBe("persisted");
      expect(persisted.pluginMetadataSnapshot?.index.plugins).toEqual(
        derived.pluginMetadataSnapshot?.index.plugins,
      );
      expect(persisted.pluginMetadataSnapshot?.diagnostics).toEqual(
        derived.pluginMetadataSnapshot?.diagnostics,
      );
      const durable = readPersistedInstalledPluginIndexSync({ env });
      expect(durable?.workspaceDir).toBe(primaryWorkspace);
      expect(durable?.plugins.map((plugin) => plugin.pluginId)).toEqual(["shared-plugin"]);
      expect(durable?.diagnostics).toHaveLength(1);
      expect((await readSnapshot()).pluginMetadataSnapshot?.registrySource).toBe("persisted");
    } finally {
      lease.release();
    }
  });

  it("replays state migrations after a Doctor-only contract change", async () => {
    const rootDir = makeTempDir();
    const stateDir = path.join(rootDir, "state");
    const env = {
      HOME: rootDir,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(rootDir, "bundled"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.7.1",
      VITEST: "true",
    };
    const pluginId = "doctor-replay";
    const pluginDir = writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/doctor-replay",
      pluginId,
      version: "1.0.0",
    });
    const contractPath = path.join(pluginDir, "doctor-contract-api.cjs");
    const markerPath = path.join(stateDir, "doctor-contract-replay.marker");
    fs.writeFileSync(contractPath, "module.exports = { stateMigrations: [] };\n", "utf8");
    fs.writeFileSync(markerPath, "pending\n", "utf8");

    const derived = loadPluginMetadataSnapshot({ config: {}, env, stateDir });
    expect(derived.registrySource).toBe("derived");
    writePersistedInstalledPluginIndexSync(derived.index, { stateDir });

    const persisted = loadPluginMetadataSnapshot({ config: {}, env, stateDir });
    const persistedPlugin = requirePlugin(persisted, pluginId);
    expect(persisted.registrySource).toBe("persisted");
    expect(persistedPlugin.doctorContractHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(persistedPlugin.doctorContractFile).toMatchObject({
      size: expect.any(Number),
      mtimeMs: expect.any(Number),
      ctimeMs: expect.any(Number),
    });
    const checkpoint = {
      env,
      version: "2026.7.1",
      buildIdentity: "2026-08-04T00:00:00.000Z",
      identity: checkpointIdentity(persisted),
    };
    recordSuccessfulStateMigrations({ ...checkpoint, nowMs: 1_234 });

    const reused = loadPluginMetadataSnapshot({ config: {}, env, stateDir });
    expect(reused.registrySource).toBe("persisted");
    expect(checkpointIdentity(reused)).toEqual(checkpoint.identity);
    expect(needsStateMigrationCheckpoint(checkpoint)).toBe(false);

    fs.writeFileSync(
      contractPath,
      `const fs = require("node:fs");
const path = require("node:path");
const markerName = "doctor-contract-replay.marker";
module.exports = {
  stateMigrations: [{
    id: "doctor-contract-replay",
    label: "Doctor contract replay",
    detectLegacyState({ stateDir }) {
      return fs.existsSync(path.join(stateDir, markerName))
        ? { preview: ["Doctor contract replay pending"] }
        : null;
    },
    migrateLegacyState({ stateDir }) {
      fs.rmSync(path.join(stateDir, markerName));
      return { changes: ["Replayed Doctor contract state migration"], warnings: [] };
    },
  }],
};
`,
      "utf8",
    );
    clearPluginMetadataLifecycleCaches();

    const refreshed = loadPluginMetadataSnapshot({ config: {}, env, stateDir });
    const refreshedPlugin = requirePlugin(refreshed, pluginId);
    const refreshedIdentity = checkpointIdentity(refreshed);
    expect(refreshed.registrySource).toBe("derived");
    expect(refreshed.registryDiagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "persisted-registry-stale-source",
    );
    expect(refreshedPlugin.manifestHash).toBe(persistedPlugin.manifestHash);
    expect(refreshedPlugin.packageJson?.hash).toBe(persistedPlugin.packageJson?.hash);
    expect(refreshedPlugin.doctorContractHash).not.toBe(persistedPlugin.doctorContractHash);
    expect(refreshedPlugin.doctorContractFile).not.toEqual(persistedPlugin.doctorContractFile);
    expect(refreshedIdentity.pluginMigrationFingerprint).not.toBe(
      checkpoint.identity.pluginMigrationFingerprint,
    );
    expect(needsStateMigrationCheckpoint({ ...checkpoint, identity: refreshedIdentity })).toBe(
      true,
    );

    const migration = await autoMigrateLegacyPluginDoctorState({ config: {}, env });

    expect(migration.warnings).toEqual([]);
    expect(migration.changes).toContain("Replayed Doctor contract state migration");
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});
