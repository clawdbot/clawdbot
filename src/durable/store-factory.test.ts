import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { openDurableRuntimeStore, openDurableRuntimeStoreReadOnly } from "./store-factory.js";

describe("durable runtime store factory", () => {
  it("opens the SQLite backend by default and satisfies the core store contract", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-factory-"));
    const store = openDurableRuntimeStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const run = store.createRun({
        operationKind: "factory.runtime",
        rootOperationReason: "store_factory_test_fixture",
        idempotencyKey: "request-1",
        status: "queued",
        recoveryState: "runnable",
      });
      const step = store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
      });
      store.appendEvent({
        runtimeRunId: run.runtimeRunId,
        stepId: step.stepId,
        eventType: "factory.runtime.accepted",
      });

      const claimed = store.claimNextRunnableStep({
        operationKind: "factory.runtime",
        workerId: "factory-worker",
        claimTtlMs: 1000,
      });

      expect(claimed).toMatchObject({
        runtimeRunId: run.runtimeRunId,
        stepId: step.stepId,
        claimedBy: expect.stringMatching(/^claim_/),
        recoveryState: "claimed",
      });
      expect(store.getTimeline(run.runtimeRunId)).toHaveLength(1);
      expect(store.getStats()).toMatchObject({
        runs: 1,
        steps: 1,
        events: 1,
        openRuns: 1,
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opens inspection state without changing schema metadata", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-readonly-"));
    const dbPath = path.join(dir, "openclaw.sqlite");
    const writer = openDurableRuntimeStore({ path: dbPath });
    const run = writer.createRun({
      operationKind: "factory.readonly",
      rootOperationReason: "readonly_store_test_fixture",
      status: "succeeded",
      recoveryState: "terminal",
    });
    writer.close();

    const { DatabaseSync } = requireNodeSqlite();
    const readSchemaUpdatedAt = () => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db
          .prepare("SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'")
          .get() as { updated_at: number | bigint };
        return Number(row.updated_at);
      } finally {
        db.close();
      }
    };
    const before = readSchemaUpdatedAt();

    try {
      const reader = openDurableRuntimeStoreReadOnly({ path: dbPath });
      try {
        expect(reader.getRun(run.runtimeRunId)?.status).toBe("succeeded");
        expect(reader.getStats().runs).toBe(1);
      } finally {
        reader.close();
      }
      expect(readSchemaUpdatedAt()).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not create a database when read-only state is not initialized", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-readonly-missing-"));
    const dbPath = path.join(dir, "openclaw.sqlite");
    try {
      expect(() => openDurableRuntimeStoreReadOnly({ path: dbPath })).toThrow(/not initialized/);
      for (const candidate of resolveSqliteDatabaseFilePaths(dbPath)) {
        expect(fs.existsSync(candidate)).toBe(false);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
