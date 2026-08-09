import { afterEach, describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import {
  assertOpenClawDatabasesReadyForRestart,
  preflightOpenClawDatabaseSchemas,
} from "./openclaw-database-preflight.js";
import {
  closeOpenClawStateDatabaseForTest,
  OPENCLAW_STATE_SCHEMA_VERSION,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("OpenClaw database schema preflight", () => {
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
import fs from "node:fs";
