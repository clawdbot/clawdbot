import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import {
  beginUpdateRecovery,
  claimUpdateRecovery,
  loadUpdateRecovery,
  prepareUpdateRecoveryCarryForward,
  readUpdateRecoveryDatabaseBinding,
  recordUpdateRecoveryIntent,
  recordUpdateRecoveryRestoreProgress,
  validateUpdateRecoveryDatabaseBinding,
  validateUpdateRecoveryDatabaseBindingAtPath,
  UpdateRecoveryConflictError,
} from "./update-run-recovery.js";

const dirs = createTempDirTracker();
const fence = { assertCurrent() {} }; // Every writer belongs to this disposable test.
const handles: ReturnType<typeof openNodeSqliteDatabase>[] = [];
function open(file: string, readOnly = false) {
  const db = openNodeSqliteDatabase(file, { readOnly });
  handles.push(db);
  return db;
}
async function fixture() {
  const root = dirs.make("update-recovery-carry-");
  const options = { env: { HOME: root, OPENCLAW_STATE_DIR: root } };
  const run = createUpdateRun({ trigger: "cli" }, options);
  const file = path.join(root, "state", "openclaw.sqlite");
  const stageFile = path.join(root, "stage.sqlite");
  closeOpenClawStateDatabaseForTest();
  await createVerifiedSqliteSnapshot({ sourcePath: file, targetPath: stageFile });
  const later = createUpdateRun({ trigger: "cli" }, options);
  finishUpdateRun(later.runId, { status: "failed", reason: "synthetic failure" }, options);
  const identity = { root, nodePath: process.execPath, version: "1.0.0", buildId: null };
  const record = beginUpdateRecovery(
    { runId: run.runId, from: identity, to: identity },
    fence,
    options,
  );
  const checkpointId = randomUUID();
  const expected = recordUpdateRecoveryIntent(
    record,
    {
      effectId: randomUUID(),
      kind: "checkpoint-restore",
      resourceId: checkpointId,
      runtime: "previous",
    },
    fence,
    options,
  );
  closeOpenClawStateDatabaseForTest();
  const sourceDb = open(file);
  const stagedDb = open(stageFile);
  stagedDb
    .prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)")
    .run("fixture.user", '"checkpoint data"', 1);
  sourceDb
    .prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)")
    .run("fixture.user", '"newer user data"', 2);
  const nextProgress = {
    restoreId: randomUUID(),
    checkpointId,
    planPath: path.join(root, "restore.json"),
    planSha256: null,
    resourceCursor: 0,
    phase: "preparing" as const,
  };
  // This fixture's matching-runtime check is a concrete no-version-change check.
  const version = stagedDb.prepare("PRAGMA user_version").get();
  const validateStagedDatabase = (db: typeof stagedDb) => {
    expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
  };
  const params = { sourceDb, stagedDb, expected, nextProgress, fence, validateStagedDatabase };
  return { root, options, run, later, file, stageFile, ...params, params };
}
function digest(file: string) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
afterEach(() => {
  for (const db of handles.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});

describe("recovery carry-forward", () => {
  it.each(["initial observation", "skipped intent", "backward phase", "unsealed next resource"])(
    "rejects %s without changing either durable copy",
    async (change) => {
      const f = await fixture();
      const prepared = prepareUpdateRecoveryCarryForward(f.params);
      const sealed = prepareUpdateRecoveryCarryForward({
        ...f.params,
        expected: prepared.record,
        nextProgress: { ...f.nextProgress, phase: "intent", planSha256: "a".repeat(64) },
      });
      const observed = prepareUpdateRecoveryCarryForward({
        ...f.params,
        expected: sealed.record,
        nextProgress: { ...sealed.record.restore!, phase: "observed" },
      });
      const expected = observed.record;
      let nextProgress: typeof f.nextProgress | NonNullable<typeof expected.restore> = {
        ...expected.restore!,
        phase: "intent",
      };
      if (change === "initial observation") {
        // A separate run still has no plan; observation cannot create one.
        const fresh = await fixture();
        expect(() =>
          prepareUpdateRecoveryCarryForward({
            ...fresh.params,
            nextProgress: { ...fresh.nextProgress, phase: "observed", planSha256: "a".repeat(64) },
          }),
        ).toThrow(UpdateRecoveryConflictError);
        expect(readUpdateRecoveryDatabaseBinding(fresh.sourceDb, fresh.expected)).toBeDefined();
        return;
      }
      if (change === "skipped intent") {
        // Move to the next resource only by durable intent, never observation.
        nextProgress = { ...expected.restore!, resourceCursor: 1, phase: "observed" };
      }
      if (change === "unsealed next resource") {
        nextProgress = { ...expected.restore!, resourceCursor: 1, phase: "preparing" };
      }
      expect(() =>
        prepareUpdateRecoveryCarryForward({
          ...f.params,
          expected,
          nextProgress,
        }),
      ).toThrow(UpdateRecoveryConflictError);
      expect(readUpdateRecoveryDatabaseBinding(f.sourceDb, expected)).toEqual(
        observed.sourceBinding,
      );
      expect(readUpdateRecoveryDatabaseBinding(f.stagedDb, expected)).toEqual(
        observed.stagedBinding,
      );
    },
  );

  it("reopens and advances only the published copy without losing its data binding", async () => {
    const f = await fixture();
    const published = prepareUpdateRecoveryCarryForward({
      ...f.params,
      nextProgress: { ...f.nextProgress, phase: "intent", planSha256: "a".repeat(64) },
    });
    f.sourceDb.close();
    f.stagedDb.close();
    const publishedOptions = { ...f.options, path: f.stageFile };
    // This fixture keeps source/stage paths distinct so an accidental old-copy
    // write is observable; publication itself belongs to checkpoint tests.
    const observed = recordUpdateRecoveryRestoreProgress(
      published.record,
      { ...published.record.restore!, phase: "observed" },
      fence,
      publishedOptions,
    );
    closeOpenClawStateDatabaseForTest();
    expect(loadUpdateRecovery(f.run.runId, publishedOptions)).toEqual(observed);
    expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(published.record);
    expect(() =>
      validateUpdateRecoveryDatabaseBindingAtPath(
        observed,
        published.stagedBinding,
        publishedOptions,
      ),
    ).not.toThrow();
    const intent = recordUpdateRecoveryRestoreProgress(
      observed,
      { ...observed.restore!, resourceCursor: 1, phase: "intent" },
      fence,
      publishedOptions,
    );
    expect(() =>
      recordUpdateRecoveryRestoreProgress(
        observed,
        { ...observed.restore!, resourceCursor: 1, phase: "intent" },
        fence,
        publishedOptions,
      ),
    ).toThrow(UpdateRecoveryConflictError);
    expect(() =>
      recordUpdateRecoveryRestoreProgress(
        intent,
        { ...intent.restore!, resourceCursor: 2, phase: "intent" },
        fence,
        publishedOptions,
      ),
    ).toThrow(UpdateRecoveryConflictError);
    closeOpenClawStateDatabaseForTest();
    expect(loadUpdateRecovery(f.run.runId, publishedOptions)).toEqual(intent);
    expect(() =>
      validateUpdateRecoveryDatabaseBindingAtPath(
        intent,
        published.stagedBinding,
        publishedOptions,
      ),
    ).not.toThrow();
  });

  it("cannot seal a restore plan in just one copy", async () => {
    const f = await fixture();
    const prepared = prepareUpdateRecoveryCarryForward(f.params);
    f.sourceDb.close();
    f.stagedDb.close();
    expect(() =>
      recordUpdateRecoveryRestoreProgress(
        prepared.record,
        { ...f.nextProgress, phase: "intent", planSha256: "a".repeat(64) },
        fence,
        f.options,
      ),
    ).toThrow(UpdateRecoveryConflictError);
    closeOpenClawStateDatabaseForTest();
    expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(prepared.record);
    expect(loadUpdateRecovery(f.run.runId, { path: f.stageFile })).toEqual(prepared.record);
  });

  it("seals plan identity in both copies while retaining the original non-active bindings", async () => {
    const f = await fixture();
    const prepared = prepareUpdateRecoveryCarryForward(f.params);
    const sealed = prepareUpdateRecoveryCarryForward({
      ...f.params,
      expected: prepared.record,
      nextProgress: { ...f.nextProgress, phase: "intent", planSha256: "a".repeat(64) },
    });
    expect(sealed.sourceBinding).toEqual(prepared.sourceBinding);
    expect(sealed.stagedBinding).toEqual(prepared.stagedBinding);
    expect(sealed.record.restore?.planSha256).toBe("a".repeat(64));
    expect(() =>
      prepareUpdateRecoveryCarryForward({
        ...f.params,
        expected: sealed.record,
        nextProgress: { ...f.nextProgress, phase: "intent", planSha256: "b".repeat(64) },
      }),
    ).toThrow(UpdateRecoveryConflictError);
  });

  it("reports loss between commits and leaves source intent authoritative over the partial stage", async () => {
    const f = await fixture();
    const before = readUpdateRecoveryDatabaseBinding(f.sourceDb, f.expected);
    expect(() =>
      prepareUpdateRecoveryCarryForward({
        ...f.params,
        fence: {
          assertCurrent() {
            if (f.sourceDb.isTransaction && !f.stagedDb.isTransaction) {
              throw new Error("lost exclusion after stage commit");
            }
          },
        },
      }),
    ).toThrow("lost exclusion after stage commit");
    expect(readUpdateRecoveryDatabaseBinding(f.sourceDb, f.expected)).toEqual(before);
    expect(() => readUpdateRecoveryDatabaseBinding(f.stagedDb, f.expected)).toThrow(
      UpdateRecoveryConflictError,
    );
  });
  it("does not adopt case-distinct machine-state namespaces", async () => {
    const f = await fixture();
    for (const db of [f.sourceDb, f.stagedDb]) {
      db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
        "UPDATE.RECOVERY.foreign",
        '"not updater state"',
        7,
      );
    }
    const result = prepareUpdateRecoveryCarryForward(f.params);
    expect(
      f.stagedDb
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = 'UPDATE.RECOVERY.foreign'",
        )
        .get()?.value_json,
    ).toBe('"not updater state"');
    expect(() =>
      validateUpdateRecoveryDatabaseBinding(f.stagedDb, result.record, result.stagedBinding),
    ).not.toThrow();
  });
  it("carries all current history and matching intent into an old copy without overwriting unrelated state", async () => {
    const f = await fixture();
    const result = prepareUpdateRecoveryCarryForward(f.params);
    expect(result.record.restore).toEqual(f.nextProgress);
    expect(result.record.revision).toBe(f.expected.revision + 1);
    for (const [db, binding] of [
      [f.sourceDb, result.sourceBinding],
      [f.stagedDb, result.stagedBinding],
    ] as const) {
      expect(() => validateUpdateRecoveryDatabaseBinding(db, result.record, binding)).not.toThrow();
    }
    expect(
      f.stagedDb
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'fixture.user'")
        .get()?.value_json,
    ).toBe('"checkpoint data"');
    f.sourceDb.close();
    f.stagedDb.close();
    expect(loadUpdateRecovery(f.run.runId, { path: f.stageFile })).toEqual(result.record);
    expect(getUpdateRun(f.later.runId, { path: f.stageFile })?.reason).toBe("synthetic failure");
    expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(result.record);
  });

  it("accepts an exact later claim without ignoring any other rows or mutating the read-only family", async () => {
    const f = await fixture();
    const result = prepareUpdateRecoveryCarryForward(f.params);
    f.sourceDb.close();
    f.stagedDb.close();
    const claimed = claimUpdateRecovery(result.record, fence, f.options);
    closeOpenClawStateDatabaseForTest();
    const family = () =>
      ["", "-wal", "-shm"].map((suffix) =>
        fs.existsSync(f.file + suffix) ? digest(f.file + suffix) : null,
      );
    const before = family();
    expect(() =>
      validateUpdateRecoveryDatabaseBindingAtPath(claimed, result.sourceBinding, f.options),
    ).not.toThrow();
    expect(() =>
      validateUpdateRecoveryDatabaseBindingAtPath(result.record, result.sourceBinding, f.options),
    ).toThrow(UpdateRecoveryConflictError);
    expect(family()).toEqual(before);
  });

  it.each([
    "user data",
    "history",
    "schema",
    "other recovery",
    "active payload",
    "active timestamp",
  ])("rejects changed %s even with matching claim and revision", async (change) => {
    const f = await fixture();
    const result = prepareUpdateRecoveryCarryForward(f.params);
    const db = f.stagedDb;
    if (change === "user data") {
      db.exec(
        "UPDATE config_machine_state SET value_json = '\"changed\"' WHERE state_key = 'fixture.user'",
      );
    }
    if (change === "history") {
      db.exec("UPDATE update_runs SET reason = 'changed'");
    }
    if (change === "schema") {
      db.exec("CREATE TABLE unknown_data (id INTEGER PRIMARY KEY)");
    }
    if (change === "other recovery") {
      db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
        "update.recovery." + randomUUID(),
        "{}",
        1,
      );
    }
    if (change === "active payload") {
      const changed = { ...result.record, primaryFailure: { code: "changed", effectId: null } };
      db.prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?").run(
        JSON.stringify(changed),
        "update.recovery." + changed.runId,
      );
    }
    if (change === "active timestamp") {
      db.prepare(
        "UPDATE config_machine_state SET updated_at_ms = updated_at_ms + 1 WHERE state_key = ?",
      ).run("update.recovery." + result.record.runId);
    }
    expect(() =>
      validateUpdateRecoveryDatabaseBinding(db, result.record, result.stagedBinding),
    ).toThrow(UpdateRecoveryConflictError);
  });

  it("rolls back source and stage when matching-runtime validation rejects the carried copy", async () => {
    const f = await fixture();
    const before = readUpdateRecoveryDatabaseBinding(f.sourceDb, f.expected);
    expect(() =>
      prepareUpdateRecoveryCarryForward({
        ...f.params,
        validateStagedDatabase() {
          throw new Error("older runtime rejects");
        },
      }),
    ).toThrow("older runtime rejects");
    expect(readUpdateRecoveryDatabaseBinding(f.sourceDb, f.expected)).toEqual(before);
    expect(
      f.stagedDb.prepare("SELECT 1 FROM update_runs WHERE run_id = ?").get(f.later.runId),
    ).toBeUndefined();
    expect(
      f.stagedDb
        .prepare("SELECT 1 FROM config_machine_state WHERE state_key LIKE 'update.recovery.%'")
        .get(),
    ).toBeUndefined();
  });

  it("refuses a stale source or lost fence before advancing either database", async () => {
    const f = await fixture();
    expect(() =>
      prepareUpdateRecoveryCarryForward({
        ...f.params,
        expected: { ...f.expected, revision: f.expected.revision + 1 },
      }),
    ).toThrow(UpdateRecoveryConflictError);
    expect(() =>
      prepareUpdateRecoveryCarryForward({
        ...f.params,
        fence: {
          assertCurrent() {
            throw new Error("lost exclusion");
          },
        },
      }),
    ).toThrow("lost exclusion");
    expect(() => readUpdateRecoveryDatabaseBinding(f.sourceDb, f.expected)).not.toThrow();
  });
});
