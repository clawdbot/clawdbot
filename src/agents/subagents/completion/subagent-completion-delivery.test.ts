import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { getTaskById } from "../../../tasks/runtime-internal.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-runtime.test-helpers.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { SubagentLifecycleController } from "../registry/subagent-registry-lifecycle.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { settleSubagentCompletionDelivery } from "./subagent-completion-admission.store.js";
import {
  dismissSubagentCompletionDelivery,
  retrySubagentCompletionDelivery,
} from "./subagent-completion-delivery.js";

const resumeSubagentRun = vi.hoisted(() => vi.fn());
vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("subagent completion recovery identity", () => {
  let database: OpenClawStateDatabase;

  beforeEach(() => {
    const tempDir = tempDirs.make(
      "openclaw-completion-recovery-",
      resolvePreferredOpenClawTmpDir(),
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    database = openOpenClawStateDatabase();
    resumeSubagentRun.mockClear();
  });

  afterEach(() => {
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  function persistCompletion(
    name: "old" | "current",
    deliveryStatus: "suspended" | "delivered" = "suspended",
    remappedRun = false,
  ) {
    const now = Date.now();
    const task: TaskRecord = {
      taskId: `task-${name}`,
      runId: `run-${name}`,
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:shared",
      task: `finish ${name} work`,
      status: "succeeded",
      deliveryStatus: deliveryStatus === "suspended" ? "failed" : "delivered",
      terminalOutcome: deliveryStatus === "suspended" ? "blocked" : "succeeded",
      progressSummary: `${name} result`,
      notifyPolicy: "done_only",
      createdAt: now - (name === "old" ? 20_000 : 10_000),
      endedAt: now - 1_000,
      lastEventAt: now,
      cleanupAfter: now + 7 * 24 * 60 * 60_000,
    };
    const subagent = createSubagentRunRecord({
      runId: remappedRun ? `completion-${name}` : task.runId!,
      taskRunId: remappedRun ? task.runId : undefined,
      childSessionKey: task.childSessionKey,
      task: task.task,
      createdAt: task.createdAt,
      endedAt: task.endedAt,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      completion: { required: true, resultText: `${name} result`, capturedAt: now },
      delivery: {
        status: deliveryStatus,
        disposition: deliveryStatus === "suspended" ? "permanent_failure" : "delivered",
        generation: 1,
        ...(deliveryStatus === "suspended"
          ? { suspendedAt: now, suspendedReason: "expiry", lastError: "requester unavailable" }
          : { deliveredAt: now }),
      },
    });
    settleSubagentCompletionDelivery({ subagent, task, databaseOptions: { database } });
    subagentRuns.set(subagent.runId, subagent);
    return { task, subagent };
  }

  function storedPair(pair: ReturnType<typeof persistCompletion>) {
    const row = database.db
      .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
      .get(pair.subagent.runId) as { payload_json: string } | undefined;
    return {
      task: database.db.prepare("SELECT * FROM task_runs WHERE task_id = ?").get(pair.task.taskId),
      subagent: row ? (JSON.parse(row.payload_json) as unknown) : undefined,
    };
  }

  function dismiss(taskId: string) {
    return dismissSubagentCompletionDelivery(taskId, {
      discardTerminalDelivery: SubagentLifecycleController.discardTerminalDelivery,
      databaseOptions: { database },
    });
  }

  it.each([false, true])(
    "dismisses only the selected result (remapped run: %s)",
    async (remapped) => {
      // Retained completions precede follow-up runs on the same reusable child session.
      const old = persistCompletion("old");
      const current = persistCompletion("current", "suspended", remapped);
      const oldRows = storedPair(old);
      const oldLive = structuredClone(old.subagent);

      await expect.soft(dismiss("task-current")).resolves.toMatchObject({
        ok: true,
        task: {
          taskId: "task-current",
          deliveryStatus: "dismissed",
          progressSummary: "current result",
        },
      });
      expect.soft(storedPair(current).task).toMatchObject({
        delivery_status: "dismissed",
        progress_summary: "current result",
        terminal_outcome: "blocked",
      });
      expect.soft(storedPair(current).subagent).toMatchObject({
        delivery: {
          status: "discarded",
          disposition: "intentional_non_delivery",
        },
      });
      expect.soft(storedPair(old)).toEqual(oldRows);
      expect.soft(subagentRuns.get(old.subagent.runId)).toEqual(oldLive);
      expect(resumeSubagentRun).not.toHaveBeenCalled();
    },
  );

  it.each(["delivered", "suspended"] as const)(
    "retries the selected completion with an older %s run on its session",
    async (oldStatus) => {
      const old = persistCompletion("old", oldStatus);
      const current = persistCompletion("current", "suspended", true);
      const oldRows = storedPair(old);
      const oldLive = structuredClone(old.subagent);

      await expect
        .soft(retrySubagentCompletionDelivery("task-current", { database }))
        .resolves.toMatchObject({
          ok: true,
          duplicateRisk: true,
          task: {
            taskId: "task-current",
            deliveryStatus: "pending",
            progressSummary: "current result",
          },
        });
      expect.soft(resumeSubagentRun.mock.calls).toEqual([[current.subagent.runId]]);
      expect.soft(storedPair(current).task).toMatchObject({
        delivery_status: "pending",
        progress_summary: "current result",
        terminal_outcome: "succeeded",
      });
      expect.soft(storedPair(current).subagent).toMatchObject({
        delivery: {
          status: "pending",
          generation: 2,
        },
      });
      expect.soft(storedPair(old)).toEqual(oldRows);
      expect.soft(subagentRuns.get(old.subagent.runId)).toEqual(oldLive);
    },
  );

  it.each(["dismiss", "retry"] as const)(
    "%s fails closed when only a sibling completion owner remains",
    async (action) => {
      const old = persistCompletion("old");
      const current = persistCompletion("current");
      subagentRuns.delete(current.subagent.runId);
      database.db.prepare("DELETE FROM subagent_runs WHERE run_id = ?").run(current.subagent.runId);
      const oldRows = storedPair(old);
      const currentRows = storedPair(current);
      const oldLive = structuredClone(old.subagent);
      const currentTask = getTaskById("task-current");

      const result = await (action === "dismiss"
        ? dismiss("task-current")
        : retrySubagentCompletionDelivery("task-current", { database }));

      expect(result).toEqual({
        ok: false,
        reason:
          action === "dismiss"
            ? "completion delivery is not blocked"
            : "task has no recoverable subagent completion",
      });
      expect(storedPair(old)).toEqual(oldRows);
      expect(storedPair(current)).toEqual(currentRows);
      expect(subagentRuns.get(old.subagent.runId)).toEqual(oldLive);
      expect(getTaskById("task-current")).toEqual(currentTask);
      expect(resumeSubagentRun).not.toHaveBeenCalled();
    },
  );
});
