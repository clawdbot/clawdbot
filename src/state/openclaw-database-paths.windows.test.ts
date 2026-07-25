// Windows database path tests exercise canonical state lifecycles beyond MAX_PATH.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { compactDoctorSessionSqliteTarget } from "../commands/doctor-session-sqlite-compact.js";
import { runDoctorStateSqliteCompact } from "../commands/doctor-state-sqlite-compact.js";
import { withOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import { withOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openExistingOpenClawStateDatabaseReadOnly,
  OPENCLAW_STATE_SCHEMA_VERSION,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const MAX_PATH = 260;
const AGENT_ID = "windows-long-path";
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function createDeepStateEnv(): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: tempDirs.make("openclaw-database-paths-windows-"),
  };
  while (
    resolveOpenClawStateSqlitePath(env).length <= MAX_PATH ||
    resolveOpenClawAgentSqlitePath({ agentId: AGENT_ID, env }).length <= MAX_PATH
  ) {
    env.OPENCLAW_STATE_DIR = path.join(env.OPENCLAW_STATE_DIR, `segment-${"x".repeat(24)}`);
  }
  fs.mkdirSync(env.OPENCLAW_STATE_DIR, { recursive: true });
  return env;
}

describe("OpenClaw database paths on Windows", () => {
  it.runIf(process.platform === "win32")(
    "opens, preflights, compacts, and reopens canonical databases beyond MAX_PATH",
    async () => {
      const env = createDeepStateEnv();
      const statePath = resolveOpenClawStateSqlitePath(env);
      const agentPath = resolveOpenClawAgentSqlitePath({ agentId: AGENT_ID, env });
      expect(statePath.startsWith("\\\\?\\")).toBe(false);
      expect(agentPath.startsWith("\\\\?\\")).toBe(false);
      expect(statePath.length).toBeGreaterThan(MAX_PATH);
      expect(agentPath.length).toBeGreaterThan(MAX_PATH);

      const state = openOpenClawStateDatabase({ env });
      const agent = openOpenClawAgentDatabase({ agentId: AGENT_ID, env });
      expect(state.path).toBe(statePath);
      expect(agent.path).toBe(agentPath);
      expect(
        state.db
          .prepare("SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ role: "global", schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
      expect(
        agent.db
          .prepare(
            "SELECT role, schema_version, agent_id FROM schema_meta WHERE meta_key = 'primary'",
          )
          .get(),
      ).toEqual({
        role: "agent",
        schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
        agent_id: AGENT_ID,
      });
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();

      expect(
        withOpenClawStateDatabaseReadOnly(
          ({ db, path: pathname }) => ({
            pathname,
            version: db.prepare("PRAGMA user_version;").get(),
          }),
          { env },
        ),
      ).toEqual({
        pathname: statePath,
        version: { user_version: OPENCLAW_STATE_SCHEMA_VERSION },
      });
      expect(
        withOpenClawAgentDatabaseReadOnly(
          ({ db, path: pathname }) => ({
            pathname,
            version: db.prepare("PRAGMA user_version;").get(),
          }),
          { agentId: AGENT_ID, env },
        ),
      ).toEqual({
        found: true,
        value: {
          pathname: agentPath,
          version: { user_version: OPENCLAW_AGENT_SCHEMA_VERSION },
        },
      });
      expect(
        preflightOpenClawDatabaseSchemas({
          env,
          supportedVersions: {
            state: OPENCLAW_STATE_SCHEMA_VERSION,
            agent: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
        }),
      ).toEqual({ incompatible: [], indeterminate: [] });
      const immutableState = openExistingOpenClawStateDatabaseReadOnly({ env });
      expect(immutableState?.path).toBe(statePath);
      expect(
        immutableState?.db
          .prepare("SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ role: "global", schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
      immutableState?.walMaintenance.close();

      await expect(runDoctorStateSqliteCompact({ env })).resolves.toMatchObject({
        integrityCheck: "ok",
        path: statePath,
        skipped: false,
      });
      expect(
        compactDoctorSessionSqliteTarget(
          {
            agentId: AGENT_ID,
            storePath: path.join(
              env.OPENCLAW_STATE_DIR ?? "",
              "agents",
              AGENT_ID,
              "sessions",
              "sessions.json",
            ),
          },
          { env },
        ),
      ).toMatchObject({
        freelistAfterPages: 0,
        skipped: false,
        walSizeAfterBytes: 0,
      });

      expect(openOpenClawStateDatabase({ env }).path).toBe(statePath);
      expect(openOpenClawAgentDatabase({ agentId: AGENT_ID, env }).path).toBe(agentPath);
    },
  );
});
