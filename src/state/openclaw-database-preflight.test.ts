import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { collectSqliteSchemaIssues } from "../infra/sqlite-schema-contract.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import {
  assertOpenClawDatabasesReadyForRestart,
  preflightOpenClawStateDatabasePath,
  preflightOpenClawDatabaseSchemas,
} from "./openclaw-database-preflight.js";
import {
  closeOpenClawStateDatabaseForTest,
  OPENCLAW_STATE_SCHEMA_VERSION,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("OpenClaw database schema preflight", () => {
  function snapshotSourceFamily(databasePath: string) {
    const paths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].filter(
      fs.existsSync,
    );
    return {
      entries: fs.readdirSync(path.dirname(databasePath)).toSorted(),
      files: paths.map((pathname) => {
        const stat = fs.statSync(pathname, { bigint: true });
        return {
          pathname,
          bytes: fs.readFileSync(pathname),
          birthtimeNs: stat.birthtimeNs,
          ctimeNs: stat.ctimeNs,
          dev: stat.dev,
          ino: stat.ino,
          mtimeNs: stat.mtimeNs,
          size: stat.size,
        };
      }),
    };
  }

  function createExplicitStateDatabase(schemaSql = OPENCLAW_STATE_SCHEMA_SQL): string {
    const stateDir = tempDirs.make("openclaw-explicit-state-preflight-");
    const databasePath = path.join(stateDir, "candidate.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`${schemaSql}; PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
      database
        .prepare(
          `INSERT INTO schema_meta (
             meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
           ) VALUES ('primary', 'global', ?, NULL, NULL, 1, 1)`,
        )
        .run(OPENCLAW_STATE_SCHEMA_VERSION);
    } finally {
      database.close();
    }
    return databasePath;
  }

  it("reports an exact current schema for one explicit copied database", async () => {
    const stateDir = tempDirs.make("openclaw-runtime-state-preflight-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawStateDatabase({ env });
    const databasePath = opened.path;
    expect(
      opened.db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'execution_identity_contexts'",
        )
        .get(),
    ).toBeUndefined();
    closeOpenClawStateDatabaseForTest();

    await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toEqual({
      schema: "openclaw.state-schema-preflight.v1",
      databasePath,
      targetVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      ownership: null,
      issues: [],
      status: "exact",
      requiresWrite: false,
    });
  });

  it("treats a supported persistent column definition as exact", async () => {
    const databasePath = createExplicitStateDatabase(
      OPENCLAW_STATE_SCHEMA_SQL.replace(
        "  kind TEXT NOT NULL,\n  sensitivity TEXT NOT NULL,",
        "  kind TEXT NOT NULL DEFAULT 'followup',\n  sensitivity TEXT NOT NULL,",
      ),
    );

    await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toEqual({
      schema: "openclaw.state-schema-preflight.v1",
      databasePath,
      targetVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      ownership: null,
      status: "exact",
      requiresWrite: false,
      issues: [],
    });
  });

  it("accepts a copied current schema with a future bare nullable column without touching it", async () => {
    const sourcePath = createExplicitStateDatabase();
    const databasePath = path.join(
      tempDirs.make("openclaw-copied-state-preflight-"),
      "candidate.sqlite",
    );
    fs.copyFileSync(sourcePath, databasePath);
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("ALTER TABLE worktrees ADD COLUMN future_note TEXT;");
    } finally {
      database.close();
    }
    const before = snapshotSourceFamily(databasePath);

    await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toEqual({
      schema: "openclaw.state-schema-preflight.v1",
      databasePath,
      targetVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      ownership: null,
      status: "exact",
      requiresWrite: false,
      issues: [],
    });
    expect(snapshotSourceFamily(databasePath)).toEqual(before);
  });

  it("classifies a drifted canonical named index as startup-repairable", async () => {
    const databasePath = createExplicitStateDatabase();
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        DROP INDEX idx_task_runs_status;
        CREATE INDEX idx_task_runs_status ON task_runs(task_id);
      `);
    } finally {
      database.close();
    }

    await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toEqual({
      schema: "openclaw.state-schema-preflight.v1",
      databasePath,
      targetVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      ownership: null,
      status: "startup-repairable",
      requiresWrite: true,
      issues: [
        {
          code: "missing-or-drifted-index",
          message: "missing or drifted index idx_task_runs_status",
          objectName: "idx_task_runs_status",
        },
      ],
    });
  });

  it("classifies the same-version run-end cleanup column as startup-repairable without touching the source", async () => {
    const sourcePath = createExplicitStateDatabase(
      OPENCLAW_STATE_SCHEMA_SQL.replace(
        "  removed_at INTEGER,\n  run_end_cleanup_json TEXT\n",
        "  removed_at INTEGER\n",
      ),
    );
    const snapshotPath = path.join(
      tempDirs.make("openclaw-consolidated-state-preflight-"),
      "candidate.sqlite",
    );
    const sqlite = requireNodeSqlite();
    const writer = new sqlite.DatabaseSync(sourcePath);
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      writer
        .prepare(
          "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES ('preflight.probe', '{}', 1)",
        )
        .run();
      await sqlite.backup(writer, snapshotPath);
      writer
        .prepare(
          "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES ('preflight.after-backup', '{}', 2)",
        )
        .run();
      expect(fs.existsSync(`${sourcePath}-wal`)).toBe(true);
      expect(fs.existsSync(`${sourcePath}-shm`)).toBe(true);
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        expect(fs.existsSync(`${snapshotPath}${suffix}`)).toBe(false);
      }
      const before = snapshotSourceFamily(sourcePath);

      const result = await preflightOpenClawStateDatabasePath(snapshotPath);

      expect(result).toMatchObject({
        foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
        status: "startup-repairable",
        requiresWrite: true,
        issues: [
          {
            code: "missing-column",
            objectName: "worktrees.run_end_cleanup_json",
          },
        ],
      });
      expect(snapshotSourceFamily(sourcePath)).toEqual(before);
    } finally {
      writer.close();
    }
  });

  it("accepts first-use session group columns without requiring a startup write", async () => {
    const databasePath = createExplicitStateDatabase(
      OPENCLAW_STATE_SCHEMA_SQL.replace(
        "  created_at INTEGER NOT NULL,\n  cwd TEXT,\n  worktree INTEGER\n",
        "  created_at INTEGER NOT NULL\n",
      ),
    );

    await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toMatchObject({
      status: "exact",
      requiresWrite: false,
      issues: [],
    });
  });

  it("rejects an explicit preflight path with sidecars without touching it", async () => {
    const databasePath = createExplicitStateDatabase();
    const sqlite = requireNodeSqlite();
    const writer = new sqlite.DatabaseSync(databasePath);
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      writer
        .prepare(
          "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES ('preflight.live', '{}', 1)",
        )
        .run();
      const before = snapshotSourceFamily(databasePath);

      await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toMatchObject({
        foundVersion: null,
        status: "indeterminate",
        requiresWrite: false,
        reason: expect.stringMatching(/consolidated snapshot.*sidecars.*online backup/iu),
      });
      expect(snapshotSourceFamily(databasePath)).toEqual(before);
    } finally {
      writer.close();
    }
  });

  it("reports an explicit unreadable path as indeterminate", async () => {
    const stateDir = tempDirs.make("openclaw-explicit-unreadable-preflight-");
    const databasePath = path.join(stateDir, "not-sqlite.db");
    fs.writeFileSync(databasePath, "not a sqlite database");

    await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toMatchObject({
      databasePath,
      foundVersion: null,
      status: "indeterminate",
      requiresWrite: false,
      reason: expect.stringMatching(/database|file/iu),
    });
  });

  it("reports invalid negative schema metadata as indeterminate", async () => {
    const databasePath = createExplicitStateDatabase();
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA user_version = -1;");
    } finally {
      database.close();
    }

    await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toMatchObject({
      foundVersion: -1,
      status: "indeterminate",
      reason: expect.stringContaining("invalid schema version metadata"),
    });
  });

  it("treats a current-v6 additive column as incompatible with the older v6 shape", () => {
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(OPENCLAW_STATE_SCHEMA_SQL);
      const olderV6Schema = OPENCLAW_STATE_SCHEMA_SQL.replace(
        "  removed_at INTEGER,\n  run_end_cleanup_json TEXT\n",
        "  removed_at INTEGER\n",
      );

      expect(collectSqliteSchemaIssues(database, olderV6Schema)).toContainEqual(
        expect.objectContaining({
          code: "unexpected-column",
          objectName: "worktrees.run_end_cleanup_json",
        }),
      );
    } finally {
      database.close();
    }
  });

  it("keeps package schema support metadata aligned", () => {
    expect(packageJson.openclaw.schemaVersions).toEqual({
      state: OPENCLAW_STATE_SCHEMA_VERSION,
      agent: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
  });

  it("accepts a supported state schema", () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-supported-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    openOpenClawStateDatabase({ env });
    closeOpenClawStateDatabaseForTest();

    expect(
      preflightOpenClawDatabaseSchemas({
        env,
        verifyCurrentSchemaShape: true,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      }),
    ).toEqual({ incompatible: [], indeterminate: [] });
    expect(() => assertOpenClawDatabasesReadyForRestart({ env })).not.toThrow();
  });

  it("accepts an older v6 state database without the lazy setup id during restart preflight", () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-older-v6-setup-id-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const statePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const state = new DatabaseSync(statePath);
    try {
      state.exec("ALTER TABLE device_bootstrap_tokens DROP COLUMN setup_id;");
    } finally {
      state.close();
    }
    expect(() => assertOpenClawDatabasesReadyForRestart({ env })).not.toThrow();
  });

  it("reports a current but noncanonical state schema as indeterminate", () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-noncanonical-state-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const statePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const state = new DatabaseSync(statePath);
    try {
      state.exec(
        "ALTER TABLE worktrees DROP COLUMN run_end_cleanup_json; " +
          "ALTER TABLE worktrees ADD COLUMN run_end_cleanup_json INTEGER;",
      );
    } finally {
      state.close();
    }

    expect(
      preflightOpenClawDatabaseSchemas({
        env,
        verifyCurrentSchemaShape: true,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      }),
    ).toEqual({
      incompatible: [],
      indeterminate: [
        {
          kind: "state",
          path: statePath,
          reason: expect.stringContaining("column definitions differ for worktrees"),
        },
      ],
    });
    expect(() => assertOpenClawDatabasesReadyForRestart({ env })).toThrow(
      /Gateway refused restart.*column definitions differ for worktrees/u,
    );
  });

  it("collects newer state and registered agent schemas with writer builds", () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const statePath = openOpenClawStateDatabase({ env }).path;
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const state = new DatabaseSync(statePath);
    try {
      state.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
      state
        .prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
        .run("state-writer-build");
    } finally {
      state.close();
    }
    const agent = new DatabaseSync(agentPath);
    try {
      agent.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
      agent
        .prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
        .run("agent-writer-build");
    } finally {
      agent.close();
    }

    expect(
      preflightOpenClawDatabaseSchemas({
        env,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      }),
    ).toEqual({
      incompatible: [
        {
          kind: "state",
          path: statePath,
          foundVersion: OPENCLAW_STATE_SCHEMA_VERSION + 1,
          supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
          writerAppVersion: "state-writer-build",
        },
        {
          kind: "agent",
          path: agentPath,
          agentId: "worker-1",
          foundVersion: OPENCLAW_AGENT_SCHEMA_VERSION + 1,
          supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
          writerAppVersion: "agent-writer-build",
        },
      ],
      indeterminate: [],
    });
  });

  it("reports a current but noncanonical registered agent schema as indeterminate", () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-noncanonical-agent-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const agent = new DatabaseSync(agentPath);
    try {
      agent.exec(
        "ALTER TABLE schema_meta ADD COLUMN unexpected TEXT CHECK (length(unexpected) > 0);",
      );
    } finally {
      agent.close();
    }

    expect(
      preflightOpenClawDatabaseSchemas({
        env,
        verifyCurrentSchemaShape: true,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      }),
    ).toEqual({
      incompatible: [],
      indeterminate: [
        {
          kind: "agent",
          path: agentPath,
          reason: expect.stringContaining("column definitions differ for schema_meta"),
        },
      ],
    });
  });

  it("reports an existing unreadable state database as indeterminate", () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-unreadable-state-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const statePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    fs.writeFileSync(statePath, "not a sqlite database");

    expect(
      preflightOpenClawDatabaseSchemas({
        env,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      }),
    ).toEqual({
      incompatible: [],
      indeterminate: [
        { kind: "state", path: statePath, reason: expect.stringMatching(/database|file/iu) },
      ],
    });
  });

  it("reports a failed agent registry query as indeterminate", () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-registry-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const statePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const state = new DatabaseSync(statePath);
    try {
      state.exec("DROP TABLE agent_databases; CREATE TABLE agent_databases (bad TEXT) STRICT;");
    } finally {
      state.close();
    }

    expect(
      preflightOpenClawDatabaseSchemas({
        env,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      }),
    ).toEqual({
      incompatible: [],
      indeterminate: [
        {
          kind: "state",
          path: statePath,
          reason: expect.stringContaining("agent database registry query failed"),
        },
      ],
    });
  });

  it("reports an existing unreadable registered agent database as indeterminate", () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-unreadable-agent-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.writeFileSync(agentPath, "not a sqlite database");

    expect(
      preflightOpenClawDatabaseSchemas({
        env,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      }),
    ).toEqual({
      incompatible: [],
      indeterminate: [
        { kind: "agent", path: agentPath, reason: expect.stringMatching(/database|file/iu) },
      ],
    });
  });
});
