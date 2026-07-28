import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  OPENCLAW_STATE_SCHEMA_VERSION,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { listSkillProposals } from "./service.js";

let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workshop-store-",
  });
});

afterEach(async () => {
  await testState.cleanup();
});

describe("Skill Workshop SQLite store", () => {
  it("lazily ensures additive tables without changing the schema version", async () => {
    const databasePath = openOpenClawStateDatabase().path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const existing = new DatabaseSync(databasePath);
    existing.exec(`
      DROP TABLE skill_workshop_proposal_origin_runs;
      DROP TABLE skill_workshop_proposal_rollbacks;
      DROP TABLE skill_workshop_proposals;
    `);
    existing.close();

    const reopened = openOpenClawStateDatabase();
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("skill_workshop_proposals"),
    ).toBeUndefined();
    await expect(listSkillProposals()).resolves.toMatchObject({ proposals: [] });
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("skill_workshop_proposals"),
    ).toEqual({ name: "skill_workshop_proposals" });
    expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
  });
});
