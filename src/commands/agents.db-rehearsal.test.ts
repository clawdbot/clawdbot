// Agent DB rehearsal tests cover isolated inventory, migration, and compatibility probes.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { listOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { runAgentDatabaseRehearsal } from "./agents.db-rehearsal.js";

type RehearsalSuccess = Awaited<ReturnType<typeof runAgentDatabaseRehearsal>>;

describe("agents database rehearsal", () => {
  const tempRoots = createSuiteTempRootTracker({ prefix: "openclaw-agent-db-rehearsal-" });

  beforeAll(async () => {
    await tempRoots.setup();
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  afterAll(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await tempRoots.cleanup();
  });

  async function makeRoot(): Promise<string> {
    return await tempRoots.make();
  }

  function createAgentDatabase(params: {
    root: string;
    agentId: string;
    relativePath: string;
  }): string {
    const env = { OPENCLAW_STATE_DIR: params.root };
    const pathname = path.join(params.root, params.relativePath);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    const database = openOpenClawAgentDatabase({
      agentId: params.agentId,
      env,
      path: pathname,
    });
    database.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    closeOpenClawAgentDatabaseByPath(pathname);
    return pathname;
  }

  function setAgentSchemaVersion(pathname: string, version: number): void {
    const database = new DatabaseSync(pathname);
    try {
      database.exec(`PRAGMA user_version = ${version};`);
      database
        .prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'")
        .run(version);
    } finally {
      database.close();
    }
  }

  function readAgentSchemaVersion(pathname: string): number {
    const database = new DatabaseSync(pathname, { readOnly: true });
    try {
      return (database.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version;
    } finally {
      database.close();
    }
  }

  it("inventories effective roster, agent-dir, and fixed session-store claims without a database open", async () => {
    const stateRoot = await makeRoot();
    const configuredAgentDir = path.join(stateRoot, "custom-auth", "main");
    const fixedStore = path.join(stateRoot, "fixed-sessions", "sessions.json");
    const configPath = path.join(stateRoot, "openclaw.json");
    await fsp.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          entries: {
            main: { default: true, agentDir: configuredAgentDir },
            ops: {},
          },
        },
        session: { store: fixedStore },
      }),
    );

    const result = (await runAgentDatabaseRehearsal({
      schemaVersion: 1,
      mode: "inventory",
      stateRoot,
      configPath,
    })) as Extract<RehearsalSuccess, { mode: "inventory" }>;

    expect(result.references).toEqual(
      expect.arrayContaining([
        {
          agentId: "main",
          path: path.join(configuredAgentDir, "openclaw-agent.sqlite"),
          claimKind: "agent-dir-database",
          ownerClaim: "configured-agent-dir",
        },
        {
          agentId: "ops",
          path: path.join(stateRoot, "agents", "ops", "agent", "openclaw-agent.sqlite"),
          claimKind: "agent-dir-database",
          ownerClaim: "default-agent-dir",
        },
        {
          agentId: "main",
          path: path.join(stateRoot, "fixed-sessions", "openclaw-agent.sqlite"),
          claimKind: "session-store-fixed-family",
          ownerClaim: "configured-session-store",
        },
        {
          agentId: "ops",
          path: path.join(stateRoot, "fixed-sessions", "openclaw-agent.sqlite"),
          claimKind: "session-store-fixed-family",
          ownerClaim: "configured-session-store",
        },
      ]),
    );
    expect(result.pluginPersistence).toEqual([
      expect.objectContaining({ pluginId: "*", kind: "indeterminate", copiedPath: null }),
    ]);
    expect(result.complete).toBe(false);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateRoot }))).toBe(
      false,
    );
  });

  it("reports plugin inventory complete only when plugin loading is explicitly disabled", async () => {
    const stateRoot = await makeRoot();
    const configPath = path.join(stateRoot, "openclaw.json");
    await fsp.writeFile(configPath, JSON.stringify({ plugins: { enabled: false } }));

    const result = (await runAgentDatabaseRehearsal({
      schemaVersion: 1,
      mode: "inventory",
      stateRoot,
      configPath,
    })) as Extract<RehearsalSuccess, { mode: "inventory" }>;

    expect(result.pluginPersistence).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it("accepts exactly 2048 logical inventory references", async () => {
    const stateRoot = await makeRoot();
    const configPath = path.join(stateRoot, "openclaw.json");
    const entries = Object.fromEntries(
      Array.from({ length: 1024 }, (_, index) => [
        `agent-${index}`,
        index === 0 ? { default: true } : {},
      ]),
    );
    await fsp.writeFile(
      configPath,
      JSON.stringify({ agents: { entries }, plugins: { enabled: false } }),
    );

    const result = (await runAgentDatabaseRehearsal({
      schemaVersion: 1,
      mode: "inventory",
      stateRoot,
      configPath,
    })) as Extract<RehearsalSuccess, { mode: "inventory" }>;

    expect(result.references).toHaveLength(2048);
  });

  it("rejects the 2049th logical inventory reference", async () => {
    const stateRoot = await makeRoot();
    const configPath = path.join(stateRoot, "openclaw.json");
    const entries = Object.fromEntries(
      Array.from({ length: 1025 }, (_, index) => [
        `agent-${index}`,
        index === 0 ? { default: true } : {},
      ]),
    );
    await fsp.writeFile(
      configPath,
      JSON.stringify({ agents: { entries }, plugins: { enabled: false } }),
    );

    await expect(
      runAgentDatabaseRehearsal({
        schemaVersion: 1,
        mode: "inventory",
        stateRoot,
        configPath,
      }),
    ).rejects.toMatchObject({ code: "inventory-limit-exceeded" });
  });

  it("rejects unsupported plugin persistence before validating or opening any database", async () => {
    const root = await makeRoot();
    await expect(
      runAgentDatabaseRehearsal({
        schemaVersion: 1,
        mode: "migrate",
        privateStateRoot: root,
        agents: [
          { agentId: "main", copiedPath: path.join(root, "missing.sqlite"), creation: "existing" },
        ],
        pluginPersistence: [
          { pluginId: "custom-store", kind: "sqlite", copiedPath: "/outside/plugin.sqlite" },
        ],
      }),
    ).rejects.toMatchObject({ code: "unsupported-plugin-persistence" });
    expect(fs.existsSync(resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: root }))).toBe(false);
  });

  it("creates the private shared database when its canonical state directory is missing", async () => {
    const root = await makeRoot();
    const databasePath = path.join(root, "copy", "openclaw-agent.sqlite");
    await fsp.mkdir(path.dirname(databasePath), { recursive: true });
    new DatabaseSync(databasePath).close();

    const result = (await runAgentDatabaseRehearsal({
      schemaVersion: 1,
      mode: "migrate",
      privateStateRoot: root,
      agents: [{ agentId: "main", copiedPath: databasePath, creation: "fresh" }],
      pluginPersistence: [],
    })) as Extract<RehearsalSuccess, { mode: "migrate" }>;

    expect(result.sharedState).toMatchObject({
      path: path.join(root, "state", "openclaw.sqlite"),
      schemaVersionBefore: 0,
      schemaVersionAfter: OPENCLAW_STATE_SCHEMA_VERSION,
      role: "global",
    });
    expect(result.privateStateRoot).toBe(root);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: root }))).toBe(true);

    const readback = (await runAgentDatabaseRehearsal({
      schemaVersion: 1,
      mode: "read-only",
      privateStateRoot: root,
      agents: [{ agentId: "main", copiedPath: databasePath, creation: "fresh" }],
      pluginPersistence: [],
    })) as Extract<RehearsalSuccess, { mode: "read-only" }>;
    expect(readback.agents[0]).toMatchObject({
      creation: "fresh",
      migrated: false,
      before: { role: "agent", ownerAgentId: "main" },
      after: { role: "agent", ownerAgentId: "main" },
    });
  });

  it("rejects fresh provenance for an already-owned database", async () => {
    const sourceRoot = await makeRoot();
    const source = createAgentDatabase({
      root: sourceRoot,
      agentId: "main",
      relativePath: "source/openclaw-agent.sqlite",
    });
    closeOpenClawStateDatabaseForTest();
    const root = await makeRoot();
    const copiedPath = path.join(root, "copy", "openclaw-agent.sqlite");
    await fsp.mkdir(path.dirname(copiedPath), { recursive: true });
    await fsp.copyFile(source, copiedPath);

    await expect(
      runAgentDatabaseRehearsal({
        schemaVersion: 1,
        mode: "migrate",
        privateStateRoot: root,
        agents: [{ agentId: "main", copiedPath, creation: "fresh" }],
        pluginPersistence: [],
      }),
    ).rejects.toMatchObject({ code: "fresh-database-not-empty" });
    expect(fs.existsSync(resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: root }))).toBe(false);
  });

  it("rejects existing provenance for an unowned database", async () => {
    const root = await makeRoot();
    const copiedPath = path.join(root, "copy", "openclaw-agent.sqlite");
    await fsp.mkdir(path.dirname(copiedPath), { recursive: true });
    new DatabaseSync(copiedPath).close();

    await expect(
      runAgentDatabaseRehearsal({
        schemaVersion: 1,
        mode: "migrate",
        privateStateRoot: root,
        agents: [{ agentId: "main", copiedPath, creation: "existing" }],
        pluginPersistence: [],
      }),
    ).rejects.toMatchObject({ code: "agent-owner-mismatch" });
    expect(fs.existsSync(resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: root }))).toBe(false);
  });

  it("migrates every explicit composite row and replaces stale private registry rows", async () => {
    const root = await makeRoot();
    const first = createAgentDatabase({
      root,
      agentId: "main",
      relativePath: "copies/first/openclaw-agent.sqlite",
    });
    const second = createAgentDatabase({
      root,
      agentId: "main",
      relativePath: "copies/second/openclaw-agent.sqlite",
    });
    createAgentDatabase({
      root,
      agentId: "stale",
      relativePath: "copies/stale/openclaw-agent.sqlite",
    });
    closeOpenClawStateDatabaseForTest();
    setAgentSchemaVersion(first, OPENCLAW_AGENT_SCHEMA_VERSION - 1);
    setAgentSchemaVersion(second, OPENCLAW_AGENT_SCHEMA_VERSION - 1);

    const result = (await runAgentDatabaseRehearsal({
      schemaVersion: 1,
      mode: "migrate",
      privateStateRoot: root,
      agents: [
        { agentId: "main", copiedPath: first, creation: "existing" },
        { agentId: "main", copiedPath: second, creation: "existing" },
      ],
      pluginPersistence: [],
    })) as Extract<RehearsalSuccess, { mode: "migrate" }>;

    expect(result.sharedState).toMatchObject({
      schemaVersionAfter: OPENCLAW_STATE_SCHEMA_VERSION,
      role: "global",
      readOnly: false,
    });
    expect(result.agents).toHaveLength(2);
    expect(result.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "main",
          realPath: fs.realpathSync.native(first),
          before: expect.objectContaining({ userVersion: OPENCLAW_AGENT_SCHEMA_VERSION - 1 }),
          after: expect.objectContaining({ userVersion: OPENCLAW_AGENT_SCHEMA_VERSION }),
          migrated: true,
        }),
        expect.objectContaining({
          agentId: "main",
          realPath: fs.realpathSync.native(second),
          migrated: true,
        }),
      ]),
    );
    const registry = listOpenClawRegisteredAgentDatabases({
      env: { OPENCLAW_STATE_DIR: root },
      includeIncompatibleSchemaVersions: true,
    });
    expect(registry.map(({ agentId, path: pathname }) => ({ agentId, path: pathname }))).toEqual([
      { agentId: "main", path: fs.realpathSync.native(first) },
      { agentId: "main", path: fs.realpathSync.native(second) },
    ]);
  });

  it("read-only compatibility verifies exact registry without migrating files", async () => {
    const root = await makeRoot();
    const databasePath = createAgentDatabase({
      root,
      agentId: "main",
      relativePath: "copies/current/openclaw-agent.sqlite",
    });
    closeOpenClawStateDatabaseForTest();
    const beforeVersion = readAgentSchemaVersion(databasePath);
    const beforeMtime = fs.statSync(databasePath).mtimeMs;

    const result = (await runAgentDatabaseRehearsal({
      schemaVersion: 1,
      mode: "read-only",
      privateStateRoot: root,
      agents: [{ agentId: "main", copiedPath: databasePath, creation: "existing" }],
      pluginPersistence: [],
    })) as Extract<RehearsalSuccess, { mode: "read-only" }>;

    expect(result.sharedState.readOnly).toBe(true);
    expect(result.sharedState.schemaVersionBefore).toBe(result.sharedState.schemaVersionAfter);
    expect(result.agents[0]).toMatchObject({
      migrated: false,
      before: { userVersion: beforeVersion },
      after: { userVersion: beforeVersion },
    });
    expect(readAgentSchemaVersion(databasePath)).toBe(beforeVersion);
    expect(fs.statSync(databasePath).mtimeMs).toBe(beforeMtime);
  });

  it("rejects a hardlinked clone before writable shared state opens", async () => {
    const outside = await makeRoot();
    const root = await makeRoot();
    const source = createAgentDatabase({
      root: outside,
      agentId: "main",
      relativePath: "source/openclaw-agent.sqlite",
    });
    closeOpenClawStateDatabaseForTest();
    const alias = path.join(root, "copy", "openclaw-agent.sqlite");
    await fsp.mkdir(path.dirname(alias), { recursive: true });
    await fsp.link(source, alias);

    await expect(
      runAgentDatabaseRehearsal({
        schemaVersion: 1,
        mode: "migrate",
        privateStateRoot: root,
        agents: [{ agentId: "main", copiedPath: alias, creation: "existing" }],
        pluginPersistence: [],
      }),
    ).rejects.toMatchObject({ code: "path-not-private" });
    expect(fs.existsSync(resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: root }))).toBe(false);
  });

  it("rejects copied paths that escape the private root", async () => {
    const outside = await makeRoot();
    const root = await makeRoot();
    const databasePath = createAgentDatabase({
      root: outside,
      agentId: "main",
      relativePath: "outside/openclaw-agent.sqlite",
    });
    closeOpenClawStateDatabaseForTest();

    await expect(
      runAgentDatabaseRehearsal({
        schemaVersion: 1,
        mode: "read-only",
        privateStateRoot: root,
        agents: [{ agentId: "main", copiedPath: databasePath, creation: "existing" }],
        pluginPersistence: [],
      }),
    ).rejects.toMatchObject({ code: "path-escape" });
  });
});
