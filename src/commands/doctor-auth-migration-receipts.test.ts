import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  archiveAuthProfileMigrationSource,
  createAuthProfileMigrationSourceReceipt,
  digestAuthProfileMigrationValue,
  resumePendingAuthProfileMigrationArchives,
} from "./doctor-auth-migration-receipts.js";

type MigrationReceiptTestApi = {
  recordAuthProfileMigrationImported: (
    receipt: ReturnType<typeof createAuthProfileMigrationSourceReceipt>,
  ) => void;
  recordAuthProfileMigrationCompleted: (
    receipt: ReturnType<typeof createAuthProfileMigrationSourceReceipt>,
  ) => void;
};

const { recordAuthProfileMigrationImported, recordAuthProfileMigrationCompleted } = (
  globalThis as Record<PropertyKey, unknown>
)[Symbol.for("openclaw.authProfileMigrationReceiptsTestApi")] as MigrationReceiptTestApi;

describe("auth profile migration receipts", () => {
  const states: OpenClawTestState[] = [];

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    for (const state of states.splice(0)) {
      await state.cleanup();
    }
  });

  async function makeReceipt() {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-auth-receipt-",
    });
    states.push(state);
    const sourcePath = await state.writeText(
      "credentials/oauth.json",
      `${JSON.stringify({ openai: { access: "fake", refresh: "fake", expires: 42 } })}\n`,
    );
    const receipt = createAuthProfileMigrationSourceReceipt({
      sourcePath,
      sourceBytes: fs.readFileSync(sourcePath),
      sourceRecordCount: 1,
      targetDatabasePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      targetTable: "auth_profile_store",
      now: new Date("2026-07-25T12:00:00.000Z"),
      env: state.env,
    });
    return { state, sourcePath, receipt };
  }

  it("resumes after target commit and receipt but before archive", async () => {
    const { state, sourcePath, receipt } = await makeReceipt();
    recordAuthProfileMigrationImported(receipt);

    expect(resumePendingAuthProfileMigrationArchives(state.env)).toHaveLength(1);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(receipt.archivePath)).toBe(true);
    const row = openOpenClawStateDatabase({ env: state.env })
      .db.prepare("SELECT status, removed_source FROM migration_sources WHERE source_key = ?")
      .get(receipt.sourceKey);
    expect(row).toEqual({ status: "completed", removed_source: 1 });
  });

  it("resumes after archive rename but before receipt finalization", async () => {
    const { state, receipt } = await makeReceipt();
    recordAuthProfileMigrationImported(receipt);
    archiveAuthProfileMigrationSource(receipt);

    expect(resumePendingAuthProfileMigrationArchives(state.env)).toHaveLength(1);
    expect(fs.existsSync(receipt.archivePath)).toBe(true);
  });

  it("does not archive bytes that changed after verification", async () => {
    const { state, sourcePath, receipt } = await makeReceipt();
    recordAuthProfileMigrationImported(receipt);
    fs.writeFileSync(sourcePath, '{"changed":true}\n', "utf8");

    expect(() => resumePendingAuthProfileMigrationArchives(state.env)).toThrow(
      "legacy auth source changed after verification",
    );
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(receipt.archivePath)).toBe(false);
  });

  it("revalidates target credentials before resuming an archive", async () => {
    const { state, sourcePath, receipt } = await makeReceipt();
    fs.mkdirSync(path.dirname(receipt.targetDatabasePath), { recursive: true });
    const target = new DatabaseSync(receipt.targetDatabasePath);
    target.exec(
      "CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    const credential = { type: "oauth", provider: "openai", refresh: "fake" };
    target
      .prepare("INSERT INTO auth_profile_store VALUES ('primary', ?, 1)")
      .run(JSON.stringify({ version: 1, profiles: { "openai:default": credential } }));
    receipt.expectedProfileSha256 = {
      "openai:default": digestAuthProfileMigrationValue(credential),
    };
    recordAuthProfileMigrationImported(receipt);
    target.prepare("DELETE FROM auth_profile_store").run();
    target.close();

    expect(() => resumePendingAuthProfileMigrationArchives(state.env)).toThrow(
      "auth profile migration target verification failed",
    );
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("revalidates target state before resuming an archive", async () => {
    const { state, sourcePath, receipt } = await makeReceipt();
    receipt.targetTable = "auth_profile_state";
    fs.mkdirSync(path.dirname(receipt.targetDatabasePath), { recursive: true });
    const target = new DatabaseSync(receipt.targetDatabasePath);
    target.exec(
      "CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    const persistedState = {
      version: 1,
      order: { openai: ["openai:default"] },
      lastGood: { openai: "openai:default" },
    };
    target
      .prepare("INSERT INTO auth_profile_state VALUES ('primary', ?, 1)")
      .run(JSON.stringify(persistedState));
    receipt.expectedStateSha256 = digestAuthProfileMigrationValue(persistedState);
    recordAuthProfileMigrationImported(receipt);
    target.prepare("DELETE FROM auth_profile_state").run();
    target.close();

    expect(() => resumePendingAuthProfileMigrationArchives(state.env)).toThrow(
      "auth profile migration target verification failed",
    );
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("does not replace a pending receipt owned by another doctor", async () => {
    const { receipt } = await makeReceipt();
    recordAuthProfileMigrationImported(receipt);
    const competing = { ...receipt, runId: `${receipt.sourceKey}:competing` };

    expect(() => recordAuthProfileMigrationImported(competing)).toThrow(
      "auth profile migration source already owned by imported receipt",
    );
  });

  it("does not replace a terminal receipt with a replay run", async () => {
    const { receipt } = await makeReceipt();
    recordAuthProfileMigrationImported(receipt);
    recordAuthProfileMigrationCompleted(receipt);
    const replay = { ...receipt, runId: `${receipt.sourceKey}:replay` };

    expect(() => recordAuthProfileMigrationImported(replay)).toThrow(
      "auth profile migration source already owned by completed receipt",
    );
  });

  it("preserves archived-unparsed status when resuming after rename", async () => {
    const { state, receipt } = await makeReceipt();
    receipt.completionStatus = "archived-unparsed";
    recordAuthProfileMigrationImported(receipt);
    archiveAuthProfileMigrationSource(receipt);

    resumePendingAuthProfileMigrationArchives(state.env);
    const row = openOpenClawStateDatabase({ env: state.env })
      .db.prepare("SELECT status FROM migration_sources WHERE source_key = ?")
      .get(receipt.sourceKey);
    expect(row).toEqual({ status: "archived-unparsed" });
  });
});
