import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createSubagentRunRecord,
  expectRecord,
} from "../agents/subagent-test-fixtures.test-helpers.js";
import { settleSubagentCompletionDelivery } from "../agents/subagents/completion/subagent-completion-admission.store.js";
import {
  dismissSubagentCompletionDelivery,
  retrySubagentCompletionDelivery,
} from "../agents/subagents/completion/subagent-completion-delivery.js";
import { SubagentLifecycleController } from "../agents/subagents/registry/subagent-registry-lifecycle.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryChangesToSqlite,
} from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { upsertTaskRegistryRecordToSqlite } from "../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import {
  collectSubagentCompletionBindingFindings,
  maybeMigrateSubagentCompletionBindings,
} from "./doctor-subagent-completion-migration.js";

const resumeSubagentRun = vi.hoisted(() => vi.fn());
vi.mock("../agents/subagents/registry/subagent-registry.js", () => ({ resumeSubagentRun }));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("doctor legacy subagent completion bindings", () => {
  beforeEach(() => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-completion-migration-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  function persistLegacy(name = "current") {
    const now = Date.now();
    const task: TaskRecord = {
      taskId: `task-${name}`,
      runId: `run-${name}`,
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: `agent:main:subagent:${name}`,
      task: `finish ${name}`,
      status: "succeeded",
      deliveryStatus: "failed",
      terminalOutcome: "blocked",
      progressSummary: `${name} result`,
      notifyPolicy: "done_only",
      createdAt: now - 10_000,
      endedAt: now - 1_000,
      lastEventAt: now,
      cleanupAfter: now + 7 * 24 * 60 * 60_000,
    };
    // Stable v2026.6.34 replaced runId/createdAt but retained sessionStartedAt.
    const subagent = createSubagentRunRecord({
      runId: `completion-${name}`,
      childSessionKey: task.childSessionKey,
      createdAt: task.createdAt + 1_000,
      sessionStartedAt: task.createdAt,
      generation: 2,
      endedAt: task.endedAt,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      completion: { required: true, resultText: `${name} result`, capturedAt: now },
      delivery: {
        status: "suspended",
        generation: 1,
        disposition: "permanent_failure",
        suspendedAt: now,
        suspendedReason: "expiry",
        lastError: "requester unavailable",
      },
    });
    settleSubagentCompletionDelivery({ task, subagent });
    return { task, subagent };
  }

  function reopen() {
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    for (const [id, run] of loadSubagentRegistryFromSqlite()) {
      subagentRuns.set(id, run);
    }
  }

  function snapshot() {
    const { db } = openOpenClawStateDatabase();
    return {
      tasks: db.prepare("SELECT * FROM task_runs ORDER BY task_id").all(),
      runs: db.prepare("SELECT * FROM subagent_runs ORDER BY run_id").all(),
      version: db.prepare("PRAGMA user_version").get(),
    };
  }

  function recover(action: "dismiss" | "retry") {
    return action === "retry"
      ? retrySubagentCompletionDelivery("task-current")
      : dismissSubagentCompletionDelivery("task-current", {
          discardTerminalDelivery: SubagentLifecycleController.discardTerminalDelivery,
        });
  }

  it.each(["dismiss", "retry"] as const)(
    "%s recovers a persisted legacy replacement only after doctor, with idempotent readback",
    async (action) => {
      const { task, subagent } = persistLegacy();
      reopen();
      const before = snapshot();
      expect(subagentRuns.get(subagent.runId)?.taskRunId).toBeUndefined();
      await expect(recover(action)).resolves.toMatchObject({
        ok: false,
        reason: expect.any(String),
      });
      expect(snapshot()).toEqual(before);
      expect(collectSubagentCompletionBindingFindings()).toMatchObject([
        {
          message: expect.stringContaining(
            "would-backfill=1, left-ambiguous=0, already-canonical=0",
          ),
        },
      ]);
      await maybeMigrateSubagentCompletionBindings({ shouldRepair: false });
      expect(snapshot()).toEqual(before);
      await maybeMigrateSubagentCompletionBindings({ shouldRepair: true });
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining("backfilled=1, left-ambiguous=0, already-canonical=0"),
        "Subagent completion bindings",
      );
      reopen();
      const after = snapshot();
      expect(after.tasks).toEqual(before.tasks);
      expect(after.version).toEqual(before.version);
      expect(subagentRuns.get(subagent.runId)).toMatchObject({
        taskRunId: task.runId,
      });
      const previousRow = expectRecord(before.runs[0]);
      const previousPayload = expectRecord(JSON.parse(String(previousRow.payload_json)));
      expect(after.runs).toEqual([
        {
          ...previousRow,
          payload_json: JSON.stringify({ ...previousPayload, taskRunId: task.runId }),
        },
      ]);
      await maybeMigrateSubagentCompletionBindings({ shouldRepair: true });
      expect(snapshot()).toEqual(after);
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining("backfilled=0, left-ambiguous=0, already-canonical=1"),
        "Subagent completion bindings",
      );
      expect(collectSubagentCompletionBindingFindings()).toEqual([]);
      await expect(recover(action)).resolves.toMatchObject({
        ok: true,
        task: { taskId: task.taskId, progressSummary: "current result" },
      });
      expect(resumeSubagentRun.mock.calls).toEqual(action === "retry" ? [[subagent.runId]] : []);
    },
  );

  it.each(["suspended", "delivered", "running"] as const)(
    "leaves two candidate runs unbound even when the sibling is %s",
    async (state) => {
      const { subagent } = persistLegacy();
      const sibling = {
        ...subagent,
        runId: "completion-sibling",
        delivery: {
          ...subagent.delivery!,
          status: state === "running" ? ("pending" as const) : state,
        },
      };
      if (state === "running") {
        sibling.execution = { status: "running" };
      }
      saveSubagentRegistryChangesToSqlite(new Map([[sibling.runId, sibling]]), [sibling.runId]);
      reopen();
      const before = snapshot();
      await maybeMigrateSubagentCompletionBindings({ shouldRepair: true });
      await maybeMigrateSubagentCompletionBindings({ shouldRepair: true });
      expect(snapshot()).toEqual(before);
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining(`backfilled=0, left-ambiguous=${state === "running" ? 1 : 2}`),
        "Subagent completion bindings",
      );
      reopen();
      for (const action of ["dismiss", "retry"] as const) {
        await expect(recover(action)).resolves.toMatchObject({
          ok: false,
          reason: expect.any(String),
        });
      }
      expect(snapshot()).toEqual(before);
      expect([...subagentRuns.values()].every((run) => run.taskRunId === undefined)).toBe(true);
      expect(resumeSubagentRun).not.toHaveBeenCalled();
    },
  );

  it("does not choose the newest of two tasks for an adopted older session", async () => {
    const { task } = persistLegacy();
    upsertTaskRegistryRecordToSqlite({
      ...task,
      taskId: "task-sibling",
      runId: "run-sibling",
      createdAt: task.createdAt + 500,
    });
    const before = snapshot();
    await maybeMigrateSubagentCompletionBindings({ shouldRepair: true });
    expect(snapshot()).toEqual(before);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("left-ambiguous=1"),
      "Subagent completion bindings",
    );
  });

  it.each([false, true])("preserves an already canonical owner (remapped=%s)", async (remapped) => {
    const { task, subagent } = persistLegacy();
    if (remapped) {
      subagent.taskRunId = task.runId;
    } else {
      task.runId = subagent.runId;
    }
    settleSubagentCompletionDelivery({ task, subagent });
    reopen();
    const before = snapshot();
    await maybeMigrateSubagentCompletionBindings({ shouldRepair: true });
    expect(snapshot()).toEqual(before);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("backfilled=0, left-ambiguous=0, already-canonical=1"),
      "Subagent completion bindings",
    );
    await expect(recover("dismiss")).resolves.toMatchObject({ ok: true });
  });

  it("does not hide an unreadable competing run", async () => {
    const { subagent } = persistLegacy();
    const { db } = openOpenClawStateDatabase();
    db.prepare(
      "INSERT INTO subagent_runs (run_id, child_session_key, requester_session_key, created_at, payload_json) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "unreadable",
      subagent.childSessionKey,
      subagent.requesterSessionKey,
      subagent.createdAt,
      "null",
    );
    const before = snapshot();
    await maybeMigrateSubagentCompletionBindings({ shouldRepair: true });
    expect(snapshot()).toEqual(before);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("invalid subagent state"),
      "Doctor warnings",
    );
  });

  it.each(["task", "completion"] as const)(
    "refuses a competing %s binding outside the child session",
    async (collision) => {
      const current = persistLegacy();
      const sibling = persistLegacy("sibling");
      if (collision === "task") {
        upsertTaskRegistryRecordToSqlite({ ...sibling.task, runId: current.task.runId });
      } else {
        sibling.subagent.taskRunId = current.task.runId;
        saveSubagentRegistryChangesToSqlite(new Map([[sibling.subagent.runId, sibling.subagent]]), [
          sibling.subagent.runId,
        ]);
      }
      const before = snapshot();
      await maybeMigrateSubagentCompletionBindings({ shouldRepair: true });
      expect(snapshot()).toEqual(before);
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining("left-ambiguous="),
        "Subagent completion bindings",
      );
    },
  );

  it.each(["requester", "before-start", "after-replacement", "missing-run-id"] as const)(
    "leaves unmatched %s state unchanged",
    async (condition) => {
      const { task, subagent } = persistLegacy();
      if (condition === "requester") {
        task.requesterSessionKey = "agent:other:main";
      }
      if (condition === "before-start") {
        task.createdAt -= 1;
      }
      if (condition === "after-replacement") {
        task.createdAt = subagent.createdAt + 1;
      }
      if (condition === "missing-run-id") {
        task.runId = undefined;
      }
      upsertTaskRegistryRecordToSqlite(task);
      const before = snapshot();
      await maybeMigrateSubagentCompletionBindings({ shouldRepair: true });
      expect(snapshot()).toEqual(before);
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining("left-unbound=1"),
        "Subagent completion bindings",
      );
    },
  );

  it("rolls back every binding when persisted readback does not match", async () => {
    persistLegacy();
    persistLegacy("sibling");
    const { db } = openOpenClawStateDatabase();
    db.exec(`CREATE TEMP TRIGGER reject_completion_binding AFTER UPDATE OF payload_json ON subagent_runs
      WHEN NEW.run_id = 'completion-sibling'
      BEGIN UPDATE subagent_runs SET payload_json = OLD.payload_json WHERE run_id = NEW.run_id; END;`);
    const before = snapshot();
    await maybeMigrateSubagentCompletionBindings({ shouldRepair: true });
    expect(snapshot()).toEqual(before);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("verification failed"),
      "Doctor warnings",
    );
    db.exec("DROP TRIGGER reject_completion_binding");
    reopen();
    expect(snapshot()).toEqual(before);
  });

  it("does not race another state owner", async () => {
    persistLegacy();
    const before = snapshot();
    const lock = await acquireGatewayLock({ allowInTests: true, role: "sqlite-maintenance" });
    expect(lock).not.toBeNull();
    try {
      await maybeMigrateSubagentCompletionBindings({ shouldRepair: true });
      expect(snapshot()).toEqual(before);
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining("Stop the Gateway and retry"),
        "Doctor warnings",
      );
    } finally {
      await lock?.release();
    }
  });

  it("does not create state when no database exists", async () => {
    const before = fs.readdirSync(process.env.OPENCLAW_STATE_DIR!);
    expect(collectSubagentCompletionBindingFindings()).toEqual([]);
    await maybeMigrateSubagentCompletionBindings({ shouldRepair: true });
    expect(fs.readdirSync(process.env.OPENCLAW_STATE_DIR!)).toEqual(before);
  });
});
