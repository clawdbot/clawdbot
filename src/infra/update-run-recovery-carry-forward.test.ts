import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import { isUpdateRecoveryMachineStateKey } from "./update-run-recovery-keys.js";
import { validateUpdateRecoveryPublicationDatabaseAtPath } from "./update-run-recovery-publication.js";
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
  await createVerifiedSqliteSnapshot({
    sourcePath: file,
    targetPath: stageFile,
    preserveRowIds: true,
  });
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
  it.each(["symbolic link", "hard link"])(
    "rejects a source alias through a %s before opening a write transaction",
    async (aliasKind) => {
      const f = await fixture();
      f.sourceDb.close();
      f.stagedDb.close();
      const alias = path.join(f.root, "source-alias.sqlite");
      if (aliasKind === "hard link") {
        fs.linkSync(f.file, alias);
      } else {
        fs.symlinkSync(f.file, alias);
      }
      const sourceDb = open(f.file);
      // An alias is not a disposable stage. Detection must precede even BEGIN,
      // independently of whether this second handle permits writes.
      const stagedDb = open(alias, true);
      const before = readUpdateRecoveryDatabaseBinding(sourceDb, f.expected);
      expect(() => prepareUpdateRecoveryCarryForward({ ...f.params, sourceDb, stagedDb })).toThrow(
        "Recovery carry-forward requires separate idle source and staged databases",
      );
      expect(sourceDb.isTransaction).toBe(false);
      expect(stagedDb.isTransaction).toBe(false);
      expect(readUpdateRecoveryDatabaseBinding(sourceDb, f.expected)).toEqual(before);
    },
  );

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

  it("rejects a rewritten displaced publication record after live progress", async () => {
    const f = await fixture();
    const published = prepareUpdateRecoveryCarryForward({
      ...f.params,
      nextProgress: { ...f.nextProgress, phase: "intent", planSha256: "a".repeat(64) },
    });
    f.sourceDb.close();
    f.stagedDb.close();
    const current = recordUpdateRecoveryRestoreProgress(
      published.record,
      { ...published.record.restore!, phase: "observed" },
      fence,
      { ...f.options, path: f.stageFile },
    );
    closeOpenClawStateDatabaseForTest();
    const displaced = open(f.file);
    const rewritten = {
      ...published.record,
      primaryFailure: { code: "rewritten", effectId: null },
    };
    displaced
      .prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
      .run(JSON.stringify(rewritten), "update.recovery." + f.run.runId);
    displaced.close();
    expect(() =>
      validateUpdateRecoveryPublicationDatabaseAtPath(
        { ...published, expected: current, role: "displaced" },
        f.options,
      ),
    ).toThrow(UpdateRecoveryConflictError);
  });

  it("validates exact publication roles across reopen, progress, and claim rotation", async () => {
    const f = await fixture();
    const published = prepareUpdateRecoveryCarryForward({
      ...f.params,
      nextProgress: { ...f.nextProgress, phase: "intent", planSha256: "a".repeat(64) },
    });
    f.sourceDb.close();
    f.stagedDb.close();
    const stageOptions = { ...f.options, path: f.stageFile };
    for (const role of ["live-source", "displaced", "staged", "live-restored"] as const) {
      validateUpdateRecoveryPublicationDatabaseAtPath(
        { ...published, expected: published.record, role },
        role === "live-source" || role === "displaced" ? f.options : stageOptions,
      );
    }
    const observed = recordUpdateRecoveryRestoreProgress(
      published.record,
      { ...published.record.restore!, phase: "observed" },
      fence,
      stageOptions,
    );
    const claimed = claimUpdateRecovery(observed, fence, stageOptions);
    closeOpenClawStateDatabaseForTest();
    const current = loadUpdateRecovery(f.run.runId, stageOptions)!;
    expect(current).toEqual(claimed);
    expect(current.publication).toEqual(published.record.publication);
    const before = [digest(f.file), digest(f.stageFile), fs.readdirSync(f.root).toSorted()];
    validateUpdateRecoveryPublicationDatabaseAtPath(
      { ...published, expected: current, role: "live-restored" },
      stageOptions,
    );
    validateUpdateRecoveryPublicationDatabaseAtPath(
      { ...published, expected: current, role: "displaced" },
      f.options,
    );
    for (const role of ["live-source", "staged"] as const) {
      expect(() =>
        validateUpdateRecoveryPublicationDatabaseAtPath(
          { ...published, expected: current, role },
          role === "live-source" ? f.options : stageOptions,
        ),
      ).toThrow(UpdateRecoveryConflictError);
    }
    expect([digest(f.file), digest(f.stageFile), fs.readdirSync(f.root).toSorted()]).toEqual(
      before,
    );
  });

  it.each(["timestamp", "claim", "history", "operator", "rowid", "commitment"])(
    "rejects changed displaced %s despite an admissible old revision",
    async (change) => {
      const f = await fixture();
      // A real sparse implicit rowid is part of the logical identity.
      f.sourceDb.exec(
        "CREATE TABLE fixture_sparse(value TEXT); INSERT INTO fixture_sparse(rowid,value) VALUES (71,'kept')",
      );
      const published = prepareUpdateRecoveryCarryForward({
        ...f.params,
        nextProgress: { ...f.nextProgress, phase: "intent", planSha256: "a".repeat(64) },
      });
      const prior = structuredClone(published.record);
      if (change === "claim" || change === "commitment") {
        if (change === "claim") {
          prior.claimId = randomUUID();
        } else {
          prior.publication!.sha256 = "b".repeat(64);
        }
        f.sourceDb
          .prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
          .run(JSON.stringify(prior), "update.recovery." + f.run.runId);
      } else if (change === "timestamp") {
        f.sourceDb
          .prepare(
            "UPDATE config_machine_state SET updated_at_ms = updated_at_ms + 1 WHERE state_key = ?",
          )
          .run("update.recovery." + f.run.runId);
      } else if (change === "history") {
        f.sourceDb
          .prepare("UPDATE update_runs SET reason = 'changed' WHERE run_id = ?")
          .run(f.later.runId);
      } else if (change === "operator") {
        f.sourceDb
          .prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
          .run('"changed"', "fixture.user");
      } else {
        f.sourceDb.exec("UPDATE fixture_sparse SET rowid = 1");
      }
      f.sourceDb.close();
      f.stagedDb.close();
      expect(() =>
        validateUpdateRecoveryPublicationDatabaseAtPath(
          { ...published, expected: published.record, role: "displaced" },
          f.options,
        ),
      ).toThrow(UpdateRecoveryConflictError);
    },
  );

  it("refuses legacy publication without an exact prior-row commitment", async () => {
    const f = await fixture();
    const prepared = prepareUpdateRecoveryCarryForward(f.params);
    f.sourceDb.close();
    f.stagedDb.close();
    expect(() =>
      validateUpdateRecoveryPublicationDatabaseAtPath(
        { ...prepared, expected: prepared.record, role: "displaced" },
        f.options,
      ),
    ).toThrow(UpdateRecoveryConflictError);
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
  it("selects exactly the carry-forward namespace while retaining operator and plugin rows", async () => {
    const f = await fixture();
    const nonRecoveryKeys = [
      "UPDATE.RECOVERY.operator",
      "update.recovery/operator",
      "update.recovery",
      "update.recoveryx.plugin",
      " update.recovery.operator",
      "plugin.fixture",
    ];
    for (const [db, value] of [
      [f.sourceDb, '"current"'],
      [f.stagedDb, '"preserved"'],
    ] as const) {
      for (const key of nonRecoveryKeys) {
        db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(key, value, 9);
      }
    }
    const other = { ...f.expected, runId: randomUUID(), transactionId: randomUUID() };
    f.sourceDb
      .prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)")
      .run("update.recovery." + other.runId, JSON.stringify(other), other.updatedAtMs);
    const obsoleteKey = "update.recovery." + randomUUID();
    f.stagedDb
      .prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)")
      .run(obsoleteKey, "{}", 1);
    const rows = (db: typeof f.sourceDb) =>
      db
        .prepare(
          "SELECT state_key, value_json, updated_at_ms FROM config_machine_state ORDER BY state_key",
        )
        .all();
    const projection = (db: typeof f.sourceDb) =>
      rows(db).filter((row) => isUpdateRecoveryMachineStateKey(row.state_key));
    expect(
      projection(f.sourceDb)
        .map((row) => String(row.state_key))
        .toSorted(),
    ).toEqual(["update.recovery." + f.expected.runId, "update.recovery." + other.runId].toSorted());
    const preserved = rows(f.stagedDb).filter(
      (row) => !isUpdateRecoveryMachineStateKey(row.state_key),
    );
    const result = prepareUpdateRecoveryCarryForward(f.params);
    expect(projection(f.stagedDb)).toEqual(projection(f.sourceDb));
    expect(rows(f.stagedDb).some((row) => row.state_key === obsoleteKey)).toBe(false);
    expect(
      rows(f.stagedDb).filter((row) => !isUpdateRecoveryMachineStateKey(row.state_key)),
    ).toEqual(preserved);
    expect(() =>
      validateUpdateRecoveryDatabaseBinding(f.stagedDb, result.record, result.stagedBinding),
    ).not.toThrow();
  });

  it.each(["update.recovery.", "update.recovery.invalid"])(
    "keeps malformed owned key %s out of generic merging but rejects its carry-forward",
    async (key) => {
      const f = await fixture();
      f.sourceDb.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(key, "{}", 1);
      expect(isUpdateRecoveryMachineStateKey(key)).toBe(true);
      const before = readUpdateRecoveryDatabaseBinding(f.sourceDb, f.expected);
      const stageRows = () =>
        f.stagedDb.prepare("SELECT * FROM config_machine_state ORDER BY state_key").all();
      const stagedBefore = stageRows();
      expect(() => prepareUpdateRecoveryCarryForward(f.params)).toThrow();
      expect(readUpdateRecoveryDatabaseBinding(f.sourceDb, f.expected)).toEqual(before);
      expect(stageRows()).toEqual(stagedBefore);
    },
  );

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
