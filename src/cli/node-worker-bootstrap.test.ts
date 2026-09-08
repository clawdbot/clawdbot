import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  seedMacNodeWorkerProofState,
  readMacNodeWorkerProofRows,
} from "../../scripts/lib/mac-node-worker-proof-state.mjs";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  getRuntimeConfig,
  readConfigFileSnapshot,
  resetConfigRuntimeState,
} from "../config/config.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import {
  resetNodeHostPluginRegistry,
  getNodeHostPluginRegistry,
} from "../node-host/plugin-node-host.test-support.js";
import { prepareNodeHostRuntime } from "../node-host/runtime.js";
import { runStartupMigrations } from "../node-host/startup-state-migrations.js";
import { createPluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  initializeNativeOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { ensureCliExecutionBootstrap } from "./command-execution-startup.js";
import { resolveCliStartupPolicy } from "./command-startup-policy.js";
import { testApi as configGuardTestApi } from "./program/config-guard.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterAll(cleanupPluginLoaderFixturesForTest);
beforeEach(() => {
  resetConfigRuntimeState();
  configGuardTestApi.resetConfigGuardStateForTests();
});
afterEach(() => {
  resetConfigRuntimeState();
  resetNodeHostPluginRegistry();
  resetPluginLoaderTestStateForTest();
  clearPluginMetadataLifecycleCaches();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture() {
  const root = fs.realpathSync(tempDirs.make("openclaw-worker-bootstrap-"));
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  for (const [key, value] of Object.entries({
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  })) {
    vi.stubEnv(key, value);
  }
  const nodePlugin = writePlugin({
    id: "fixture-node",
    configSchema: {
      type: "object",
      additionalProperties: false,
      required: ["enabled"],
      properties: { enabled: { type: "boolean" } },
    },
    body: `module.exports = {
      id: "fixture-node",
      nodeHostCommands: [{ command: "fixture.inspect", cap: "fixture", handle: async () => "ok" }],
      register() {},
    };`,
  });
  const channelPlugin = writePlugin({
    id: "fixture-channel",
    body: "module.exports = { id: 'fixture-channel', register() {} };",
  });
  const manifestPath = path.join(channelPlugin.dir, "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      ...manifest,
      channels: ["fixture-channel"],
      channelConfigs: {
        "fixture-channel": {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { enabled: { type: "boolean" } },
          },
        },
      },
    }),
  );
  const nodeHost = {
    skills: { enabled: false },
    mcp: { servers: { fixture: { enabled: false, command: "fixture-mcp" } } },
  };
  const config = {
    channels: { "fixture-channel": { enabled: true, futureOption: true } },
    plugins: {
      allow: [nodePlugin.id, channelPlugin.id],
      load: { paths: [nodePlugin.file, channelPlugin.file] },
      entries: { [nodePlugin.id]: { enabled: true, config: { enabled: true } } },
    },
    nodeHost,
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { root, stateDir, configPath, config };
}

async function bootstrap() {
  const commandPath = ["node", "worker"];
  const error = vi.fn();
  await ensureCliExecutionBootstrap({
    commandPath,
    startupPolicy: resolveCliStartupPolicy({ commandPath, jsonOutputMode: false }),
    runtime: {
      log: vi.fn(),
      error,
      exit: (code) => {
        throw new Error(`exit ${code}: ${error.mock.calls.flat().join("\n")}`);
      },
    },
  });
}

function readGatewayState() {
  return withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => {
    const query = getNodeSqliteKysely<DB>(db);
    return {
      version: readSqliteUserVersion(db),
      // Includes the installed plugin index and Doctor's state/startup checkpoints.
      machine: executeSqliteQuerySync(
        db,
        query.selectFrom("config_machine_state").selectAll().orderBy("state_key"),
      ),
      health: executeSqliteQuerySync(
        db,
        query.selectFrom("config_health_entries").selectAll().orderBy("config_path"),
      ),
      schema: executeSqliteQuerySync(
        db,
        query.selectFrom("schema_meta").selectAll().orderBy("meta_key"),
      ),
    };
  });
}

describe("private node worker bootstrap", () => {
  it.each(["unknown", "metadata", "lease", "future", "corrupt"])(
    "does not adopt %s state as native bootstrap",
    async (shape) => {
      const { stateDir } = fixture();
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      seedMacNodeWorkerProofState(databasePath);
      const db = new DatabaseSync(databasePath);
      if (shape === "unknown") {
        db.exec("CREATE TABLE unrelated (value TEXT)");
      }
      if (shape === "metadata") {
        db.exec(
          "CREATE TABLE schema_meta (meta_key TEXT); INSERT INTO schema_meta VALUES ('occupied')",
        );
      }
      if (shape === "lease") {
        db.exec(
          "CREATE TABLE state_leases (owner TEXT); INSERT INTO state_leases VALUES ('occupied')",
        );
      }
      if (shape === "future") {
        db.exec("PRAGMA user_version = 999");
      }
      db.close();
      if (shape === "corrupt") {
        fs.writeFileSync(databasePath, "not a SQLite database");
      }
      const before = fs.readFileSync(databasePath);
      const startup = runStartupMigrations({ log: { info: vi.fn(), warn: vi.fn() } });
      if (shape === "future" || shape === "corrupt") {
        await expect(startup).rejects.toThrow();
      } else {
        await expect(startup).resolves.toBeUndefined();
      }
      expect(fs.readFileSync(databasePath)).toEqual(before);
    },
  );

  it("initializes native bootstrap before plugin state reads without losing native rows", async () => {
    const { stateDir } = fixture();
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    const rows = seedMacNodeWorkerProofState(databasePath);
    await bootstrap();
    await runStartupMigrations({ log: { info: vi.fn(), warn: vi.fn() } });
    const store = createPluginStateSyncKeyedStore("fixture-node", {
      namespace: "bootstrap-proof",
      maxEntries: 10,
    });
    expect(store.entries()).toEqual([]);
    closeOpenClawStateDatabaseForTest();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(readMacNodeWorkerProofRows(database)).toEqual(rows);
    } finally {
      database.close();
    }
  });

  it.each([false, true])(
    "pins core config and preserves Gateway state (seeded=%s)",
    async (seeded) => {
      const { root, stateDir, configPath, config } = fixture();
      const includePath = path.join(root, "channels.json");
      fs.writeFileSync(includePath, JSON.stringify(config.channels));
      fs.writeFileSync(
        configPath,
        JSON.stringify({ ...config, channels: { $include: "channels.json" } }),
      );
      if (seeded) {
        loadOrCreateDeviceIdentity();
        closeOpenClawStateDatabaseForTest();
      }
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      const before = fs.existsSync(databasePath) ? fs.readFileSync(databasePath) : null;
      const gatewayBefore = readGatewayState();
      const configBefore = fs.readFileSync(configPath);
      const includeBefore = fs.readFileSync(includePath);

      // Prove the fixture really exceeds the older channel owner's schema.
      const full = await readConfigFileSnapshot({ observe: false });
      expect(full.valid).toBe(false);
      expect(full.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "channels.fixture-channel",
            message: expect.stringContaining("futureOption"),
          }),
        ]),
      );
      await bootstrap();
      const pinned = getRuntimeConfig();
      expect(pinned.nodeHost).toEqual(config.nodeHost);
      expect(pinned.channels?.["fixture-channel"]).toEqual(config.channels["fixture-channel"]);
      // A cold worker must admit mature state even when snapshot storage is full.
      closeOpenClawStateDatabaseForTest();
      const allocateSnapshot = vi.spyOn(fs, "mkdtempSync").mockImplementation(() => {
        throw Object.assign(new Error("snapshot storage is full"), { code: "ENOSPC" });
      });
      try {
        initializeNativeOpenClawStateDatabase();
        expect(allocateSnapshot).not.toHaveBeenCalled();
      } finally {
        allocateSnapshot.mockRestore();
      }
      await runStartupMigrations({ log: { info: vi.fn(), warn: vi.fn() } });
      const prepared = await prepareNodeHostRuntime();
      expect(getRuntimeConfig()).toBe(pinned);
      expect(prepared.manifest.commands).toEqual(
        expect.arrayContaining([
          "fixture.inspect",
          "mcp.tools.call.v1",
          "system.run",
          "system.run.prepare",
        ]),
      );
      const runtime = prepared.start({
        client: {
          request: async () => {
            throw new Error("unexpected Gateway request");
          },
        },
      });
      await runtime.close();
      expect(fs.readFileSync(configPath)).toEqual(configBefore);
      expect(fs.readFileSync(includePath)).toEqual(includeBefore);
      expect(fs.existsSync(databasePath) ? fs.readFileSync(databasePath) : null).toEqual(before);
      expect(readGatewayState()).toEqual(gatewayBefore);
    },
  );

  it("accepts a fresh missing config without creating Gateway state", async () => {
    const { configPath } = fixture();
    fs.unlinkSync(configPath);
    await bootstrap();
    expect(getRuntimeConfig().agents?.entries).toEqual({ main: {} });
    expect(fs.existsSync(configPath)).toBe(false);
    expect(readGatewayState()).toBeUndefined();
  });

  it.each([
    {
      label: "browser",
      nodeHost: { browserProxy: { enabled: "invalid" } },
      issue: "nodeHost.browserProxy.enabled",
    },
    {
      label: "MCP",
      nodeHost: { mcp: { servers: { fixture: { transport: "stdio" } } } },
      issue: "nodeHost.mcp.servers.fixture",
    },
  ])("rejects invalid node-owned $label settings", async ({ nodeHost, issue }) => {
    const { configPath, config } = fixture();
    fs.writeFileSync(configPath, JSON.stringify({ ...config, nodeHost }));
    await expect(bootstrap()).rejects.toThrow(issue);
  });

  it("reports an invalid node plugin without advertising its commands", async () => {
    const { configPath, config } = fixture();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ...config,
        plugins: {
          ...config.plugins,
          entries: { "fixture-node": { enabled: true, config: { enabled: "invalid" } } },
        },
      }),
    );
    await bootstrap();
    const prepared = await prepareNodeHostRuntime();
    expect(prepared.manifest.commands).not.toContain("fixture.inspect");
    expect(prepared.manifest.commands).toContain("system.run");
    expect(
      getNodeHostPluginRegistry()?.plugins.find((plugin) => plugin.id === "fixture-node"),
    ).toMatchObject({ status: "error", error: expect.stringContaining("invalid config") });
  });
});
