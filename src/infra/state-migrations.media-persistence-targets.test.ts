import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";

const tempDirs: string[] = [];
const PREVIOUS_VERSION = OPENCLAW_AGENT_SCHEMA_VERSION - 1;

function createLegacyAgentDatabase(params: { env: NodeJS.ProcessEnv; path?: string }): string {
  const opened = openOpenClawAgentDatabase({
    agentId: "main",
    env: params.env,
    ...(params.path ? { path: params.path } : {}),
  });
  const databasePath = opened.path;
  closeOpenClawAgentDatabasesForTest();
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`PRAGMA user_version = ${PREVIOUS_VERSION};`);
    database
      .prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'")
      .run(PREVIOUS_VERSION);
  } finally {
    database.close();
  }
  return databasePath;
}

function readUserVersion(databasePath: string): number {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    database.close();
  }
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("media persistence migration targets", () => {
  it("migrates and registers an unregistered default-layout agent database", () => {
    const stateDir = fs.realpathSync.native(makeTempDir(tempDirs, "media-persistence-disk-scan-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = createLegacyAgentDatabase({ env });
    unregisterOpenClawAgentDatabase({ agentId: "main", env, path: databasePath });

    const result = migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toEqual([]);
    expect(readUserVersion(databasePath)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([
      expect.objectContaining({
        agentId: "main",
        path: databasePath,
        schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      }),
    ]);
  });

  it("unregisters foreign registry paths without touching their databases", () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-active-state-"),
    );
    const foreignStateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-foreign-state-"),
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(
      foreignStateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    createLegacyAgentDatabase({ env, path: databasePath });
    const beforeBytes = fs.readFileSync(databasePath);
    const beforeMtimeMs = fs.statSync(databasePath).mtimeMs;

    const result = migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toContain(
      `Skipped foreign agent database ${databasePath}; it is outside the active state directory and is not a configured session store.`,
    );
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([]);
    expect(fs.readFileSync(databasePath)).toEqual(beforeBytes);
    expect(fs.statSync(databasePath).mtimeMs).toBe(beforeMtimeMs);
  });

  it("migrates a configured out-of-tree session store", () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-custom-active-"),
    );
    const customRoot = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-custom-store-"),
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const storePath = resolveStorePath(path.join(customRoot, "{agentId}", "sessions.json"), {
      agentId: "main",
      env,
    });
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
      defaultAgentId: "main",
      env,
    }).path;
    createLegacyAgentDatabase({ env, path: databasePath });
    unregisterOpenClawAgentDatabase({ agentId: "main", env, path: databasePath });
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([]);

    const result = migrateLegacyMediaPersistence({
      configuredAgentDatabaseTargets: [{ agentId: "main", path: databasePath }],
      env,
    });

    expect(result.warnings).toEqual([]);
    expect(readUserVersion(databasePath)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([expect.objectContaining({ agentId: "main", path: databasePath })]);
  });

  it("prunes missing and archived registry entries before migration", () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-registry-hygiene-"),
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const missingPath = path.join(stateDir, "agents", "missing", "agent", "openclaw-agent.sqlite");
    const archivedPath = path.join(stateDir, "imports", "archived", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
    fs.writeFileSync(archivedPath, "archived fixture");
    const state = openOpenClawStateDatabase({ env });
    const insert = state.db.prepare(
      "INSERT INTO agent_databases(agent_id,path,schema_version,last_seen_at,size_bytes) VALUES(?,?,?,?,?)",
    );
    insert.run("missing", missingPath, OPENCLAW_AGENT_SCHEMA_VERSION, 1, null);
    insert.run("archived", archivedPath, 8, 1, null);

    const result = migrateLegacyMediaPersistence({ env });

    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Removed missing agent database registry entry"),
        expect.stringContaining("Removed archived or transient agent database registry entry"),
      ]),
    );
    expect(result.warnings).toContain(`Skipped missing registered agent database ${missingPath}.`);
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([]);
  });
});
