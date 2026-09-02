import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  markLegacyMigrationSourceRemoved,
  readLegacyMigrationReceipt,
  recordLegacyMigrationReceipt,
  recordLegacyMigrationRun,
  recordLegacyMigrationSource,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";

describe("shared legacy migration receipts", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  function createFixture() {
    const stateDir = tempDirs.make("openclaw-migration-receipts-");
    const sourcePath = path.join(stateDir, "legacy.json");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const receipt = {
      sourceKey: resolveLegacyMigrationSourceKey("test-json", sourcePath),
      migrationKind: "legacy-test-json",
      sourcePath,
      targetTable: "device_identities",
      sourceSha256: "a".repeat(64),
      sourceSizeBytes: 12,
      sourceRecordCount: 1,
      runId: "legacy-test-run",
      now: 123,
      reportJson: '{"preserved":true}',
    };
    return { env, receipt };
  }

  it("preserves persisted source-key hashing with optional ownership scope", () => {
    const sourcePath = path.join("fixtures", "legacy.json");
    const resolvedPath = path.resolve(sourcePath);
    const digest = createHash("sha256").update(resolvedPath).digest("hex");
    const scopedDigest = createHash("sha256")
      .update("workspace-a")
      .update("\0")
      .update(resolvedPath)
      .digest("hex");

    expect(resolveLegacyMigrationSourceKey("test-json", sourcePath)).toBe(`test-json:${digest}`);
    expect(resolveLegacyMigrationSourceKey("test-json", sourcePath, "workspace-a")).toBe(
      `test-json:${scopedDigest}`,
    );
    expect(resolveLegacyMigrationSourceKey("test-json", sourcePath, "workspace-b")).not.toBe(
      `test-json:${scopedDigest}`,
    );
  });

  it("records one typed receipt, rejects duplicates, and marks verified source removal", () => {
    const { env, receipt } = createFixture();
    runOpenClawStateWriteTransaction(({ db }) => recordLegacyMigrationReceipt(db, receipt), {
      env,
    });

    expect(readLegacyMigrationReceipt(receipt.sourceKey, env)).toEqual({
      sourceKey: receipt.sourceKey,
      sourceSha256: receipt.sourceSha256,
      removedSource: false,
      reportJson: receipt.reportJson,
    });
    expect(() =>
      runOpenClawStateWriteTransaction(({ db }) => recordLegacyMigrationReceipt(db, receipt), {
        env,
      }),
    ).toThrow();

    markLegacyMigrationSourceRemoved(receipt.sourceKey, env, "test migration cleanup");

    expect(readLegacyMigrationReceipt(receipt.sourceKey, env)?.removedSource).toBe(true);
    const { db } = openOpenClawStateDatabase({ env });
    expect(
      db
        .prepare(
          "SELECT migration_kind, target_table, source_size_bytes, source_record_count, status, removed_source FROM migration_sources WHERE source_key = ?",
        )
        .get(receipt.sourceKey),
    ).toEqual({
      migration_kind: receipt.migrationKind,
      target_table: receipt.targetTable,
      source_size_bytes: receipt.sourceSizeBytes,
      source_record_count: receipt.sourceRecordCount,
      status: "completed",
      removed_source: 1,
    });
  });

  it("upserts resumed runs and sources without replacing a preserved receipt report", () => {
    const { env, receipt } = createFixture();
    runOpenClawStateWriteTransaction(({ db }) => recordLegacyMigrationReceipt(db, receipt), {
      env,
    });
    markLegacyMigrationSourceRemoved(receipt.sourceKey, env);

    runOpenClawStateWriteTransaction(
      ({ db }) => {
        recordLegacyMigrationRun(db, {
          runId: receipt.runId,
          startedAt: receipt.now + 1,
          finishedAt: receipt.now + 2,
          status: "archived",
          reportJson: '{"resumed":true}',
          upsert: true,
        });
        recordLegacyMigrationSource(db, {
          ...receipt,
          sourceSha256: "b".repeat(64),
          sourceSizeBytes: 24,
          sourceRecordCount: 2,
          status: "archived",
          importedAt: receipt.now + 2,
          reportJson: '{"preserved":false}',
          upsert: true,
          updateReportOnConflict: false,
        });
      },
      { env },
    );

    const { db } = openOpenClawStateDatabase({ env });
    expect(
      db
        .prepare(
          "SELECT started_at, finished_at, status, report_json FROM migration_runs WHERE id = ?",
        )
        .get(receipt.runId),
    ).toEqual({
      started_at: receipt.now,
      finished_at: receipt.now + 2,
      status: "archived",
      report_json: '{"resumed":true}',
    });
    expect(readLegacyMigrationReceipt(receipt.sourceKey, env)).toEqual({
      sourceKey: receipt.sourceKey,
      sourceSha256: "b".repeat(64),
      removedSource: false,
      reportJson: receipt.reportJson,
    });
    expect(
      db
        .prepare(
          "SELECT source_size_bytes, source_record_count FROM migration_sources WHERE source_key = ?",
        )
        .get(receipt.sourceKey),
    ).toEqual({ source_size_bytes: 24, source_record_count: 2 });
  });
});
