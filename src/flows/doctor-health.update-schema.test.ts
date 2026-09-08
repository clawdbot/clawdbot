// Install fixture mocks before importing the real maintenance owners.
import "./doctor-health.test-support.js";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUpdateRun, finishUpdateRun } from "../infra/update-run-ledger.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks } = await import("./doctor-health.test-support.js");

function setSchemaVersion(databasePath: string, version: number): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`PRAGMA user_version = ${version};`);
    db.prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'").run(version);
  } finally {
    db.close();
  }
}

function readDatabase(databasePath: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      version: db.prepare("PRAGMA user_version").get()?.user_version,
      contentVersion: tableExists(db, "config_machine_state")
        ? db
            .prepare(
              "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
            )
            .get()?.value_json
        : undefined,
      ledger: tableExists(db, "update_runs")
        ? db.prepare("SELECT * FROM update_runs ORDER BY run_id").all()
        : [],
    };
  } finally {
    db.close();
  }
}

describe("Doctor schema bumps under an updating parent", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    mocks.config.mockReturnValue({});
    mocks.packageRoot.mockReturnValue(undefined);
    mocks.runContributions.mockReset();
    mocks.outro.mockClear();
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
  });

  it.each([
    { kind: "state", updaterVersion: "2026.9.2", missingMetadata: true },
    { kind: "agent", updaterVersion: "2026.9.2", missingMetadata: false },
    { kind: "agent", updaterVersion: "2026.9.2-rebuild.1", missingMetadata: false },
  ])(
    "refuses a $kind bump driven by $updaterVersion before changing database bytes, ledger, or config",
    async ({ kind, updaterVersion, missingMetadata }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const shared = openOpenClawStateDatabase({ env: state.env }).path;
        const agent = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
        createUpdateRun({ trigger: "cli", before: { version: updaterVersion } });
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        const target = kind === "state" ? shared : agent;
        const supported =
          kind === "state" ? OPENCLAW_STATE_SCHEMA_VERSION : OPENCLAW_AGENT_SCHEMA_VERSION;
        setSchemaVersion(target, supported - 1);
        if (missingMetadata) {
          const db = new DatabaseSync(shared);
          db.exec("DROP TABLE config_machine_state");
          db.close();
        }
        const before = readDatabase(shared);
        const quarantine = state.statePath("state", "openclaw-quarantine.sqlite");
        fs.writeFileSync(quarantine, "unreadable quarantine fixture");
        const files = [shared, agent, state.configPath, quarantine];
        const bytes = files.map((file) => fs.readFileSync(file));
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

        const failure = await runDoctorHealthFlow(runtime, {
          repair: true,
          nonInteractive: true,
        }).catch((error: unknown) => error);
        expect(failure).toMatchObject({
          code: "update-schema-bump-unfenced",
          updaterVersion,
          databases: [
            { kind, path: target, foundVersion: supported - 1, supportedVersion: supported },
          ],
          commands: [
            "openclaw gateway stop",
            `npm install -g openclaw@${VERSION} --allow-scripts=openclaw`,
            "openclaw doctor --fix",
            "openclaw gateway start",
          ],
        });
        expect(files.map((file) => fs.readFileSync(file))).toEqual(bytes);
        expect(readDatabase(shared)).toEqual(before);
        expect(mocks.runContributions).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    { ledger: "running", update: "1", driver: "2026.9.2", bump: true, deferred: true },
    { ledger: "running", update: "1", driver: "2026.9.2-rebuild.1", bump: true, deferred: true },
    { ledger: "missing", update: "1", driver: "2026.9.1", bump: true },
    { ledger: "finished", update: "1", driver: "2026.9.2", bump: true, deferred: true },
    { ledger: "running", update: "1", driver: "2026.9.3", bump: true },
    { ledger: "running", update: "1", driver: "2026.9.3-beta.1", bump: true },
    { ledger: "running", update: "1", driver: "2026.10.0", bump: true },
    { ledger: "running", update: "1", driver: "2026.9.1", bump: true },
    { ledger: "running", update: "1", driver: "unknown", bump: true },
    { ledger: "running", update: "1", driver: "2026.9.2", bump: false },
    { ledger: "running", update: undefined, driver: "2026.9.2", bump: true, deferred: true },
  ])(
    "completes real migration when permitted: %j",
    async ({ ledger, update, driver, bump, deferred }) => {
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", update);
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const shared = openOpenClawStateDatabase({ env: state.env }).path;
        const run = createUpdateRun({ trigger: "cli", before: { version: driver } });
        if (ledger === "finished") {
          finishUpdateRun(run.runId, { status: "succeeded" });
        }
        closeOpenClawStateDatabaseForTest();
        if (ledger === "missing") {
          const db = new DatabaseSync(shared);
          try {
            db.exec("DROP TABLE update_runs");
          } finally {
            db.close();
          }
        }
        if (bump) {
          setSchemaVersion(shared, OPENCLAW_STATE_SCHEMA_VERSION - 1);
        }
        mocks.runContributions.mockImplementation(async () => {
          const result = repairOpenClawStateDatabaseSchema({ env: state.env });
          expect(result.warnings).toEqual([]);
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await runDoctorHealthFlow(runtime, {
          repair: true,
          nonInteractive: true,
        });
        expect(readDatabase(shared).version).toBe(
          OPENCLAW_STATE_SCHEMA_VERSION - (deferred ? 1 : 0),
        );
        if (deferred) {
          expect(readDatabase(shared).contentVersion).toBe(String(OPENCLAW_STATE_SCHEMA_VERSION));
          expect(runtime.log).toHaveBeenCalledWith(
            expect.stringContaining(
              `Schema content applied; version publication deferred until update run ${run.runId} finishes`,
            ),
          );
        }
        expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
      });
    },
  );

  it("emits a structured refusal with a failure exit for the affected ledger writer", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const shared = openOpenClawStateDatabase({ env: state.env }).path;
      createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
      closeOpenClawStateDatabaseForTest();
      setSchemaVersion(shared, OPENCLAW_STATE_SCHEMA_VERSION - 1);
      const database = new DatabaseSync(shared);
      database.exec("DROP TABLE config_machine_state");
      database.close();
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
        writeStdout: vi.fn(),
        writeJson: vi.fn(),
      };
      await expect(
        runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true, json: true }),
      ).rejects.toMatchObject({ code: 1 });
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.writeJson).toHaveBeenCalledWith(
        {
          ok: false,
          error: expect.objectContaining({
            code: "update-schema-bump-unfenced",
            targetVersion: VERSION,
            updaterVersion: "2026.9.2",
            databases: [
              expect.objectContaining({
                kind: "state",
                foundVersion: OPENCLAW_STATE_SCHEMA_VERSION - 1,
              }),
            ],
          }),
        },
        2,
      );
    });
  });
});
