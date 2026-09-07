import "../flows/doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runDoctorHealthFlow } from "../flows/doctor-health.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const { mocks } = await import("../flows/doctor-health.test-support.js");
beforeEach(() => {
  mocks.config.mockReturnValue({});
  mocks.packageRoot.mockReturnValue(undefined);
  mocks.outro.mockClear();
  mocks.runContributions.mockReset();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function createLegacyRegistryFixture() {
  const root = tempDirs.make("openclaw-doctor-legacy-registry-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  for (const [key, value] of Object.entries({
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
  })) {
    vi.stubEnv(key, value);
  }
  vi.stubEnv("OPENCLAW_HOME", undefined);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA user_version = 8;
    CREATE TABLE agent_databases (
      agent_id TEXT NOT NULL, path TEXT NOT NULL, schema_version INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL, size_bytes INTEGER,
      PRIMARY KEY (agent_id, path)
    );
  `);
  database.close();
  const config: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { main: {} } },
  };
  const begin = () =>
    beginDoctorMaintenance({
      options: { repair: true, nonInteractive: true },
      root: null,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
  return { root, stateDir, configPath, databasePath, config, begin };
}

it("admits a supported legacy registry without weakening runtime target validation", async () => {
  const fixture = createLegacyRegistryFixture();
  fs.writeFileSync(fixture.configPath, JSON.stringify(fixture.config));
  const before = fs.readFileSync(fixture.databasePath);
  const resolveRuntimeTargets = () =>
    resolveConfiguredAgentDatabaseTargets(fixture.config, { env: process.env });
  expect(resolveRuntimeTargets).toThrow("legacy agent database registry schema");
  const maintenance = await fixture.begin();
  try {
    expect(maintenance).toBeDefined();
    expect(fs.readFileSync(fixture.databasePath)).toEqual(before);
    expect(resolveRuntimeTargets).toThrow("legacy agent database registry schema");
  } finally {
    await maintenance?.release();
  }
});

it.each(["canonical", "custom-json", "shared-sqlite", "registered-shared-sqlite"] as const)(
  "refuses a newer %s database before repairing an old registry",
  async (layout) => {
    const fixture = createLegacyRegistryFixture();
    const customDir = path.join(fixture.root, "custom");
    const agentPath =
      layout === "canonical"
        ? path.join(fixture.stateDir, "agents", "main", "agent", "openclaw-agent.sqlite")
        : path.join(
            customDir,
            layout === "custom-json" ? "openclaw-agent.sqlite" : "sessions.sqlite",
          );
    if (layout !== "canonical") {
      fixture.config.session = {
        store: layout === "custom-json" ? path.join(customDir, "sessions.json") : agentPath,
      };
    }
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    if (layout === "registered-shared-sqlite") {
      fixture.config.agents!.entries!.ops = {};
      const registry = new DatabaseSync(fixture.databasePath);
      registry
        .prepare("INSERT INTO agent_databases VALUES (?, ?, ?, ?, ?)")
        .run("ops", agentPath, OPENCLAW_AGENT_SCHEMA_VERSION, 1, null);
      registry.close();
    }
    const agent = new DatabaseSync(agentPath);
    agent.exec(`
      PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};
      CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, agent_id TEXT);
      INSERT INTO schema_meta VALUES ('primary', 'main');
    `);
    agent.close();
    fs.writeFileSync(fixture.configPath, JSON.stringify(fixture.config));
    const paths = [fixture.configPath, fixture.databasePath, agentPath];
    const before = paths.map((pathname) => fs.readFileSync(pathname));

    await expect(
      runDoctorHealthFlow(
        { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        { repair: true, nonInteractive: true },
      ),
    ).rejects.toThrow(
      layout === "registered-shared-sqlite" ? "for agent ops" : "newer than this build",
    );
    expect(paths.map((pathname) => fs.readFileSync(pathname))).toEqual(before);
  },
);

it.each(["missing-index", "wrong-index", "missing-table"] as const)(
  "lets the schema repair owner decide current shared-state %s",
  async (damage) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const initial = openOpenClawStateDatabase({ env: state.env });
      initial.db.exec(
        damage === "missing-table" ? "DROP TABLE task_runs" : "DROP INDEX idx_task_runs_status",
      );
      if (damage === "wrong-index") {
        initial.db.exec("CREATE INDEX idx_task_runs_status ON task_runs(task_id)");
      }
      closeOpenClawStateDatabaseForTest();
      mocks.runContributions.mockImplementation(async (ctx) => {
        const result = repairOpenClawStateDatabaseSchema({ env: state.env });
        ctx.runtime.log([...result.changes, ...result.warnings].join("\n"));
      });
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      await runCommandWithRuntime(runtime, () =>
        runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
      );

      const output = [...runtime.log.mock.calls, ...runtime.error.mock.calls].flat().join("\n");
      expect(mocks.runContributions, output).toHaveBeenCalledOnce();
      const { DatabaseSync } = requireNodeSqlite();
      const repaired = new DatabaseSync(initial.path, { readOnly: true });
      try {
        if (damage === "missing-table") {
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
          expect(output).toMatch(/persisted database readiness.*task_runs/);
          expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
          expect(
            repaired.prepare("SELECT name FROM sqlite_schema WHERE name = 'task_runs'").get(),
          ).toBeUndefined();
        } else {
          expect(runtime.exit, output).not.toHaveBeenCalled();
          expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
          expect(
            repaired.prepare("SELECT name FROM pragma_index_info('idx_task_runs_status')").all(),
          ).toEqual([{ name: "status" }]);
        }
      } finally {
        repaired.close();
      }
    });
  },
);
