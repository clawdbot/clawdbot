import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryAcquireExclusiveSqliteCoordinator } from "../infra/node-sqlite.js";
import { acquireGatewayLifecycleCoordinator } from "../infra/state-database-coordinator.js";
import { autoMigrateLegacyState } from "../infra/state-migrations.doctor.js";
import { resetAutoMigrateLegacyStateDirForTest } from "../infra/state-migrations.state-dir.js";
import { writePersistedInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-records.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.unstubAllEnvs();
  clearPluginMetadataLifecycleCaches();
  resetAutoMigrateLegacyStateDirForTest();
  closeOpenClawStateDatabaseForTest();
});

it("admits plugin-only repair before executing setup or doctor modules", async () => {
  const root = tempDirs.make("openclaw-doctor-plugin-maintenance-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  const bundledDir = path.join(root, "bundled-disabled");
  fs.mkdirSync(bundledDir);
  for (const [key, value] of Object.entries({
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  })) {
    vi.stubEnv(key, value);
  }
  vi.stubEnv("OPENCLAW_HOME", undefined);
  const pluginId = "fixture-maintenance-owner";
  const packageName = `@fixture/${pluginId}`;
  const pluginDir = writeManagedNpmPlugin({
    stateDir,
    packageName,
    pluginId,
    version: "1.0.0",
  });
  const marker = (name: string) => path.join(root, `${name}.marker`);
  const writeMarker = (name: string) =>
    `require("node:fs").writeFileSync(${JSON.stringify(marker(name))}, "executed");`;
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: packageName,
      version: "1.0.0",
      openclaw: {
        extensions: ["./dist/index.js"],
        setupEntry: "./dist/setup-entry.cjs",
        setupFeatures: { legacySessionSurfaces: true },
        channel: { id: "fixture-chat" },
      },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      channels: ["fixture-chat"],
      doctorContract: { stateMigrations: true, resolveSessionStoreAgentIds: true },
      configSchema: { type: "object" },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "dist", "setup-entry.cjs"),
    `${writeMarker("setup")}
module.exports = {
  kind: "bundled-channel-setup-entry",
  loadLegacySessionSurface() {
    return { canonicalizeLegacySessionKey() { return null; } };
  },
};`,
  );
  fs.writeFileSync(
    path.join(pluginDir, "doctor-contract-api.cjs"),
    `${writeMarker("doctor")}
module.exports = {
  resolveSessionStoreAgentIds() { ${writeMarker("session-agent")} return []; },
  stateMigrations: [{
    id: "fixture-state", label: "Fixture state", doctorOnly: true,
    detectLegacyState() {
      return require("node:fs").existsSync(${JSON.stringify(marker("migrated"))})
        ? null : { preview: ["Repair plugin-owned state"] };
    },
    migrateLegacyState() {
      ${writeMarker("migrated")}
      return { changes: ["Repaired plugin-owned state"], warnings: [] };
    },
  }],
};`,
  );
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { main: { workspace: path.join(root, "workspace") } },
    },
    plugins: { allow: [pluginId], entries: { [pluginId]: { enabled: true } } },
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  writePersistedInstalledPluginIndexInstallRecordsSync(
    { [pluginId]: { source: "npm", spec: `${packageName}@1.0.0`, installPath: pluginDir } },
    { stateDir, env: process.env, config },
  );
  clearPluginMetadataLifecycleCaches();
  const markers = () =>
    ["setup", "doctor", "session-agent", "migrated"].map((name) => fs.existsSync(marker(name)));
  expect(markers()).toEqual([false, false, false, false]);

  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const databaseBefore = fs.readFileSync(databasePath);
  const coordinator = acquireGatewayLifecycleCoordinator({ databasePath });
  coordinator.release();
  // A separate SQLite connection owns the lock outside the reentrant process map,
  // reproducing another Gateway's ownership without a subprocess timing dependency.
  const otherOwner = tryAcquireExclusiveSqliteCoordinator(coordinator.path, { busyTimeoutMs: 0 });
  expect(otherOwner).not.toBeNull();
  const begin = () =>
    beginDoctorMaintenance({
      options: { repair: true, nonInteractive: true },
      root: null,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
  try {
    await expect(begin()).rejects.toThrow("another OpenClaw process owns gateway-lifecycle");
    expect(markers()).toEqual([false, false, false, false]);
    expect(fs.readFileSync(databasePath)).toEqual(databaseBefore);
  } finally {
    otherOwner?.release();
  }

  const maintenance = await begin();
  expect(maintenance).toBeDefined();
  try {
    expect(markers()).toEqual([false, false, false, false]);
    const result = await autoMigrateLegacyState({
      cfg: config,
      env: process.env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain("Repaired plugin-owned state");
    expect(markers()).toEqual([true, true, true, true]);
    await maintenance?.finish(config);
  } finally {
    await maintenance?.release();
  }
});
