// Process regression for typed gateway startup-migration refusal and lease cleanup.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasActiveStartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { writePersistedInstalledPluginIndexSync } from "../plugins/installed-plugin-index-store.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";

const STARTUP_REFUSAL =
  "OpenClaw startup migrations did not complete cleanly; refusing to report the gateway ready.";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runIsolatedModuleScript(env: NodeJS.ProcessEnv, script: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
}

function seedPluginStateConflict(stateDir: string): void {
  const sharedPath = path.join(stateDir, "state", "openclaw.sqlite");
  const sidecarPath = path.join(stateDir, "plugin-state", "state.sqlite");
  fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });

  const shared = new DatabaseSync(sharedPath);
  try {
    shared.exec(`
      CREATE TABLE plugin_state_entries (
        plugin_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (plugin_id, namespace, entry_key)
      );
    `);
    shared
      .prepare(`
        INSERT INTO plugin_state_entries (
          plugin_id, namespace, entry_key, value_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run("discord", "components", "interaction:1", '{"ok":false}', 2_000, null);
  } finally {
    shared.close();
  }

  const sidecar = new DatabaseSync(sidecarPath);
  try {
    sidecar.exec(`
      CREATE TABLE plugin_state_entries (
        plugin_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (plugin_id, namespace, entry_key)
      );
    `);
    sidecar
      .prepare(`
        INSERT INTO plugin_state_entries (
          plugin_id, namespace, entry_key, value_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      // Older or equal sidecar rows can be archived; a newer divergent row must stay unresolved.
      .run("discord", "components", "interaction:1", '{"ok":true}', 3_000, null);
  } finally {
    sidecar.close();
  }
}

describe("gateway startup-migration refusal", () => {
  it("exits cleanly after reporting the refusal once and releasing its lease", async () => {
    const temporaryRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "openclaw-startup-migration-exit-"),
    );
    const root = await fs.promises.realpath(temporaryRoot);
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
      NO_COLOR: "1",
    };
    delete env.NODE_ENV;
    delete env.OPENCLAW_HOME;
    delete env.VITEST;

    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({ gateway: { mode: "local", auth: { mode: "none" } } }),
      );
      seedPluginStateConflict(stateDir);

      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", path.resolve("src/entry.ts"), "gateway", "run", "--allow-unconfigured"],
        {
          cwd: path.resolve("."),
          encoding: "utf8",
          env,
          timeout: 30_000,
        },
      );
      const output = `${result.stderr}\n${result.stdout}`;

      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(1);
      expect(result.signal, output).toBeNull();
      expect(result.stderr).toContain(STARTUP_REFUSAL);
      expect(result.stderr.split(STARTUP_REFUSAL)).toHaveLength(2);
      expect(result.stderr).not.toContain("[openclaw] Could not start the CLI.");
      expect(hasActiveStartupMigrationLease({ env })).toBe(false);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("persists a refreshed legacy plugin index for the next process", async () => {
    const root = await fs.promises.realpath(tempDirs.make("openclaw-plugin-index-checkpoint-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const config = {
      gateway: { mode: "local", auth: { mode: "none" } },
    } satisfies OpenClawConfig;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
      NO_COLOR: "1",
    };
    delete env.NODE_ENV;
    delete env.OPENCLAW_HOME;
    delete env.VITEST;
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;

    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config));
      const pluginId = "legacy-doctor-index";
      const pluginDir = writeManagedNpmPlugin({
        stateDir,
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
      const current = loadPluginMetadataSnapshot({ config, env, stateDir });
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
      writePersistedInstalledPluginIndexSync(legacyIndex, { env });
      clearPluginMetadataLifecycleCaches();
      closeOpenClawStateDatabaseForTest();

      const preflightUrl = new URL("./doctor-config-preflight.ts", import.meta.url).href;
      const first = runIsolatedModuleScript(
        env,
        `
          const { runDoctorConfigPreflight } = await import(${JSON.stringify(preflightUrl)});
          await runDoctorConfigPreflight({
            migrateLegacyConfig: false,
            invalidConfigNote: false,
            requireStateMigrationCheckpoint: true,
          });
        `,
      );
      expect(first.error, `${first.stderr}\n${first.stdout}`).toBeUndefined();
      expect(first.status, `${first.stderr}\n${first.stdout}`).toBe(0);
      expect(first.signal, `${first.stderr}\n${first.stdout}`).toBeNull();
      expect(hasActiveStartupMigrationLease({ env })).toBe(false);
      closeOpenClawStateDatabaseForTest();

      const configIoUrl = new URL("../config/io.ts", import.meta.url).href;
      const second = runIsolatedModuleScript(
        env,
        `
          const { readConfigFileSnapshotWithPluginMetadata } =
            await import(${JSON.stringify(configIoUrl)});
          const result = await readConfigFileSnapshotWithPluginMetadata({ observe: false });
          const metadata = result.pluginMetadataSnapshot;
          const plugin = metadata?.index.plugins.find(
            (candidate) => candidate.pluginId === ${JSON.stringify(pluginId)},
          );
          console.log("__RESULT__" + JSON.stringify({
            discovery: metadata?.discovery !== undefined,
            doctorContractFile: plugin?.doctorContractFile,
            doctorContractHash: plugin?.doctorContractHash,
            packageBuild: plugin?.packageBuild,
            registryDiagnostics: metadata?.registryDiagnostics,
            registrySource: metadata?.registrySource,
          }));
        `,
      );
      expect(second.error, `${second.stderr}\n${second.stdout}`).toBeUndefined();
      expect(second.status, `${second.stderr}\n${second.stdout}`).toBe(0);
      expect(second.signal, `${second.stderr}\n${second.stdout}`).toBeNull();
      const resultLine = second.stdout.split("\n").find((line) => line.startsWith("__RESULT__"));
      expect(resultLine, `${second.stderr}\n${second.stdout}`).toBeDefined();
      const result = JSON.parse(resultLine!.slice("__RESULT__".length)) as {
        discovery: boolean;
        doctorContractFile?: { ctimeMs?: number; mtimeMs: number; size: number };
        doctorContractHash?: string;
        packageBuild?: Record<string, unknown>;
        registryDiagnostics?: unknown[];
        registrySource?: string;
      };
      expect(result).toMatchObject({
        discovery: false,
        doctorContractFile: {
          ctimeMs: expect.any(Number),
          mtimeMs: expect.any(Number),
          size: expect.any(Number),
        },
        doctorContractHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        packageBuild: { bundledDist: false },
        registryDiagnostics: [],
        registrySource: "persisted",
      });
    } finally {
      clearPluginMetadataLifecycleCaches();
      closeOpenClawStateDatabaseForTest();
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
