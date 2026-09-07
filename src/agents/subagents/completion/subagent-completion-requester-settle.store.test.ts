import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { recoverPendingSessionDeliveries } from "../../../infra/session-delivery-queue-recovery.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { ensureTaskRegistryReady, getTaskById } from "../../../tasks/runtime-internal.js";
import { publishTaskRecordAfterAtomicStore } from "../../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-runtime.test-helpers.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry.store.sqlite.js";
import {
  admitSubagentCompletionDelivery,
  blockSubagentCompletionDelivery,
  settleSubagentCompletionDelivery,
} from "./subagent-completion-admission.store.js";
import {
  armRequesterWake,
  failedRecords,
  records,
  requesterWakeDriver,
} from "./subagent-completion-admission.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("atomic rejected requester-settle storage", () => {
  let tempDir: string;
  let database: OpenClawStateDatabase;

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-requester-settle-", resolvePreferredOpenClawTmpDir());
    database = openOpenClawStateDatabase({ path: path.join(tempDir, "state.sqlite") });
  });

  afterEach(() => {
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  function persistOwner(input = records()) {
    settleSubagentCompletionDelivery({
      subagent: input.subagent,
      task: input.task,
      databaseOptions: { database },
    });
    subagentRuns.set(input.subagent.runId, input.subagent);
    ensureTaskRegistryReady();
    publishTaskRecordAfterAtomicStore(input.task);
    return input;
  }

  function useDefaultDatabase(): void {
    closeOpenClawStateDatabaseForTest();
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    database = openOpenClawStateDatabase();
  }

  function reopenOwners(): void {
    closeOpenClawStateDatabaseForTest();
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    database = openOpenClawStateDatabase();
    for (const [runId, entry] of loadSubagentRegistryFromSqlite()) {
      subagentRuns.set(runId, entry);
    }
    ensureTaskRegistryReady();
  }

  it("preserves an already-delivered cancelled task while closing its stale wake", async () => {
    useDefaultDatabase();
    const input = failedRecords("cancelled", { status: "error" });
    input.task.deliveryStatus = "delivered";
    persistOwner(input);
    const driver = requesterWakeDriver([input]);
    try {
      await driver.run();
      expect(driver.warn).not.toHaveBeenCalledWith(
        "failed to persist requester settle wake rejection",
        expect.any(Object),
      );

      reopenOwners();
      expect(subagentRuns.get(input.subagent.runId)).toMatchObject({
        delivery: { status: "failed", lastError: "requester unavailable" },
        suppressCompletionDelivery: true,
      });
      expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
      expect(getTaskById(input.task.taskId)).toMatchObject({
        status: "cancelled",
        deliveryStatus: "delivered",
        error: "original child failure",
      });
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it("preserves an already-delivered succeeded task without a blocked alert", async () => {
    useDefaultDatabase();
    const input = armRequesterWake(records());
    input.task.deliveryStatus = "delivered";
    persistOwner(input);
    const driver = requesterWakeDriver([input]);
    try {
      await driver.run();

      reopenOwners();
      expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
      expect(getTaskById(input.task.taskId)).toMatchObject({
        status: "succeeded",
        deliveryStatus: "delivered",
        terminalOutcome: "succeeded",
      });
      expect(getTaskById(input.task.taskId)?.error).toBeUndefined();
      expect(
        database.db.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
      ).toEqual({ count: 0 });
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it("settles a historical succeeded task whose subagent outcome is missing", async () => {
    useDefaultDatabase();
    const input = armRequesterWake(records());
    delete input.subagent.execution.outcome;
    input.subagent.pauseReason = "sessions_yield";
    const originalExecution = structuredClone(input.subagent.execution);
    persistOwner(input);
    const driver = requesterWakeDriver([input]);
    try {
      await driver.run();
      expect(driver.warn).not.toHaveBeenCalledWith(
        "failed to persist requester settle wake rejection",
        expect.any(Object),
      );

      reopenOwners();
      expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
      expect(subagentRuns.get(input.subagent.runId)?.execution).toEqual(originalExecution);
      expect(getTaskById(input.task.taskId)).toMatchObject({
        status: "succeeded",
        deliveryStatus: "failed",
        terminalOutcome: "blocked",
        error: "requester unavailable",
      });
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it("clears a rejected wake without a completion-message delivery owner", async () => {
    useDefaultDatabase();
    const input = armRequesterWake(records());
    input.subagent.expectsCompletionMessage = false;
    input.subagent.delivery = { status: "not_required" };
    persistOwner(input);
    const driver = requesterWakeDriver([input]);
    try {
      await driver.run();
      expect(driver.warn).not.toHaveBeenCalledWith(
        "failed to persist requester settle wake rejection",
        expect.any(Object),
      );

      reopenOwners();
      expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
      expect(getTaskById(input.task.taskId)).toMatchObject({
        status: "succeeded",
        deliveryStatus: "session_queued",
        terminalOutcome: "succeeded",
      });
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it("rolls delivery settlement back when clearing the durable wake fails", async () => {
    useDefaultDatabase();
    const input = persistOwner(failedRecords("cancelled", { status: "error" }));
    const before = structuredClone(input);
    database.db.exec(`
      CREATE TEMP TRIGGER reject_requester_wake_clear
      BEFORE UPDATE ON subagent_runs
      WHEN json_extract(OLD.payload_json, '$.requesterSettleWake.status') IS NOT NULL
        AND json_extract(NEW.payload_json, '$.requesterSettleWake') IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'cut:requester-wake-clear');
      END;
    `);
    const driver = requesterWakeDriver([input]);
    try {
      await driver.run();
      expect(driver.warn).toHaveBeenCalledWith(
        "failed to persist requester settle wake rejection",
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining("cut:requester-wake-clear"),
          }),
        }),
      );

      database.db.exec("DROP TRIGGER reject_requester_wake_clear");
      reopenOwners();
      expect(subagentRuns.get(input.subagent.runId)).toEqual(before.subagent);
      expect(getTaskById(input.task.taskId)).toMatchObject(before.task);
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it("terminalizes the owned physical queue with the rejected wake", async () => {
    useDefaultDatabase();
    const input = failedRecords("failed", { status: "error" });
    admitSubagentCompletionDelivery({
      ...input,
      databaseOptions: { database },
    });
    subagentRuns.set(input.subagent.runId, input.subagent);
    ensureTaskRegistryReady();
    publishTaskRecordAfterAtomicStore(input.task);
    const driver = requesterWakeDriver([input]);
    try {
      await driver.run();
      expect(driver.warn).not.toHaveBeenCalledWith(
        "failed to persist requester settle wake rejection",
        expect.any(Object),
      );
      expect(
        database.db
          .prepare(
            "SELECT status, recovery_state FROM delivery_queue_entries WHERE queue_name = 'session' AND id = ?",
          )
          .get(input.queueEntry.id),
      ).toEqual({ status: "failed", recovery_state: "completed_permanent" });

      const deliver = vi.fn(async () => {});
      await expect(
        recoverPendingSessionDeliveries({
          deliver,
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }),
      ).resolves.toMatchObject({ recovered: 0, failed: 0 });
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it("reconciles a legacy failed delivery whose physical queue is still pending", async () => {
    useDefaultDatabase();
    const input = failedRecords("failed", { status: "error" });
    admitSubagentCompletionDelivery({
      ...input,
      databaseOptions: { database },
    });
    subagentRuns.set(input.subagent.runId, input.subagent);
    ensureTaskRegistryReady();
    publishTaskRecordAfterAtomicStore(input.task);
    expect(
      blockSubagentCompletionDelivery({
        subagent: input.subagent,
        taskId: input.task.taskId,
        reason: "legacy partial settlement",
        databaseOptions: { database },
      }),
    ).toBe(true);
    expect(input.subagent).toMatchObject({
      delivery: { status: "failed" },
      requesterSettleWake: { status: "pending" },
    });

    const driver = requesterWakeDriver([input]);
    try {
      await driver.run();
      expect(
        database.db
          .prepare(
            "SELECT status, recovery_state FROM delivery_queue_entries WHERE queue_name = 'session' AND id = ?",
          )
          .get(input.queueEntry.id),
      ).toEqual({ status: "failed", recovery_state: "completed_permanent" });
      reopenOwners();
      expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it("does not enqueue a second blocked alert for a legacy successful settlement", async () => {
    useDefaultDatabase();
    const input = armRequesterWake(records());
    admitSubagentCompletionDelivery({
      ...input,
      databaseOptions: { database },
    });
    subagentRuns.set(input.subagent.runId, input.subagent);
    ensureTaskRegistryReady();
    publishTaskRecordAfterAtomicStore(input.task);
    expect(
      blockSubagentCompletionDelivery({
        subagent: input.subagent,
        taskId: input.task.taskId,
        reason: "legacy partial settlement",
        databaseOptions: { database },
      }),
    ).toBe(true);
    const blockedAlertCount = () =>
      database.db
        .prepare(
          "SELECT COUNT(*) AS count FROM delivery_queue_entries WHERE queue_name = 'session' AND entry_kind = 'systemEvent'",
        )
        .get();
    expect(blockedAlertCount()).toEqual({ count: 1 });

    const driver = requesterWakeDriver([input]);
    try {
      await driver.run();
      expect(blockedAlertCount()).toEqual({ count: 1 });
      reopenOwners();
      expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
      expect(getTaskById(input.task.taskId)).toMatchObject({
        status: "succeeded",
        deliveryStatus: "failed",
        terminalOutcome: "blocked",
        error: "legacy partial settlement",
      });
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it("rolls the whole rejected batch back when a later generation changed", async () => {
    useDefaultDatabase();
    const first = failedRecords("failed", { status: "error" });
    const second = failedRecords("timed_out", { status: "timeout" });
    second.task.taskId = "task-completion-second";
    second.task.runId = "task-run-second";
    second.subagent.runId = "completion-run-second";
    second.subagent.taskRunId = second.task.runId;
    const batchRunIds = [first.subagent.runId, second.subagent.runId];
    armRequesterWake(first, batchRunIds);
    armRequesterWake(second, batchRunIds);
    persistOwner(first);
    persistOwner(second);
    const firstBefore = structuredClone(first);
    const durableSecond = structuredClone(second);
    durableSecond.subagent.delivery!.generation = 2;
    settleSubagentCompletionDelivery({
      subagent: durableSecond.subagent,
      task: durableSecond.task,
      databaseOptions: { database },
    });

    const driver = requesterWakeDriver([first, second]);
    try {
      await driver.run();
      expect(driver.warn).toHaveBeenCalledWith(
        "failed to persist requester settle wake rejection",
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining(second.subagent.runId),
          }),
        }),
      );

      reopenOwners();
      expect(subagentRuns.get(first.subagent.runId)).toEqual(firstBefore.subagent);
      expect(getTaskById(first.task.taskId)).toMatchObject(firstBefore.task);
      expect(subagentRuns.get(second.subagent.runId)).toEqual(durableSecond.subagent);
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });
});
