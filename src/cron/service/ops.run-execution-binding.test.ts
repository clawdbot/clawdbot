// Focused proof that manual cron admission binds exact owner-native rows.
import { describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createManagedTaskFlow } from "../../tasks/task-flow-registry.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { saveCronStore } from "../store.js";
import {
  claimCronRunReceiptInDatabase,
  finishCronRunReceipt,
  prepareCronRunReceiptClaim,
} from "../store/run-receipt-store.js";
import { run } from "./ops-run.js";
import { createCronServiceState } from "./state.js";
import {
  createCronOwnerExecutionIdentityAdmission,
  tryCreateCronTaskRunHandle,
} from "./task-runs.js";

const fixtures = setupCronRegressionFixtures({
  prefix: "cron-service-execution-binding-",
});

describe("cron run execution binding", () => {
  it("binds the exact admitted execution to the cron receipt and task rows", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-execution-binding-" },
      async () => {
        resetTaskRegistryForTests();
        resetTaskFlowRegistryForTests();
        const store = fixtures.makeStorePath();
        const dueAt = Date.parse("2026-02-06T10:05:06.525Z");
        const job = createDueIsolatedJob({
          id: "exact-owner-binding",
          nowMs: dueAt,
          nextRunAtMs: dueAt,
        });
        await saveCronStore(store.storePath, { version: 1, jobs: [job] });
        const runIsolatedAgentJob = vi.fn(
          async (params: {
            executionIdentity?: {
              ingress: { kind: string };
              onPostAdmission?: (context: AdmittedRunContext) => void;
              onExecutionStarted?: () => void;
            };
          }) => {
            const admitted = {
              operationalRunInstance: { instanceId: "instance-exact", runId: "run-exact" },
              executionIdentityToken: createExecutionIdentityAdmissionToken("run-exact", {
                contextId: "context-exact",
                executionId: "execution-exact",
                now: dueAt,
              }),
            } satisfies AdmittedRunContext;
            const beforeAdmissionSettles = openOpenClawStateDatabase().db;
            expect(tableExists(beforeAdmissionSettles, "execution_owner_lifecycle_bindings")).toBe(
              false,
            );
            params.executionIdentity?.onPostAdmission?.(admitted);
            expect(tableExists(beforeAdmissionSettles, "execution_owner_lifecycle_bindings")).toBe(
              false,
            );
            params.executionIdentity?.onExecutionStarted?.();
            return { status: "ok" as const };
          },
        );
        const state = createCronServiceState({
          cronEnabled: true,
          storePath: store.storePath,
          log: noopLogger,
          nowMs: () => dueAt,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob,
        });

        await expect(run(state, job.id, "force")).resolves.toEqual({ ok: true, ran: true });
        expect(runIsolatedAgentJob).toHaveBeenCalledWith(
          expect.objectContaining({
            executionIdentity: expect.objectContaining({
              ingress: expect.objectContaining({ kind: "schedule" }),
            }),
          }),
        );
        const db = openOpenClawStateDatabase().db;
        expect(
          db
            .prepare(
              `SELECT binding.context_id, binding.execution_id, receipt.status, receipt.error_text
           FROM cron_run_receipts AS receipt
           JOIN execution_owner_lifecycle_bindings AS binding
             ON binding.owner_kind = 'cron' AND binding.owner_id = receipt.receipt_id
           WHERE receipt.job_id = ?`,
            )
            .get(job.id),
        ).toEqual({
          context_id: "context-exact",
          execution_id: "execution-exact",
          status: "ok",
          error_text: null,
        });
        expect(
          db
            .prepare(
              `SELECT binding.context_id, binding.execution_id, task.status
           FROM task_runs AS task
           JOIN execution_owner_lifecycle_bindings AS binding
             ON binding.owner_kind = 'task' AND binding.owner_id = task.task_id
           WHERE task.source_id = ? AND task.runtime = 'cron'`,
            )
            .get(job.id),
        ).toEqual({
          context_id: "context-exact",
          execution_id: "execution-exact",
          status: "succeeded",
        });
      },
    );
  });

  it("does not partially bind task or flow rows after the cron owner is replaced", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-stale-execution-binding-" },
      async () => {
        resetTaskRegistryForTests();
        resetTaskFlowRegistryForTests();
        const store = fixtures.makeStorePath();
        const dueAt = Date.parse("2026-02-06T10:06:06.525Z");
        const job = {
          ...createDueIsolatedJob({
            id: "stale-owner-binding",
            nowMs: dueAt,
            nextRunAtMs: dueAt,
          }),
          agentId: "main",
        };
        await saveCronStore(store.storePath, { version: 1, jobs: [job] });
        const state = createCronServiceState({
          cronEnabled: true,
          storePath: store.storePath,
          log: noopLogger,
          nowMs: () => dueAt,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(),
        });
        const prepared = prepareCronRunReceiptClaim({
          storePath: store.storePath,
          job,
          agentId: job.agentId!,
          startedAtMs: dueAt,
        });
        const initial = runOpenClawStateWriteTransaction(({ db }) =>
          claimCronRunReceiptInDatabase({
            database: db,
            prepared,
            resolveAgentId: (current) => current.agentId!,
          }),
        );
        const task = tryCreateCronTaskRunHandle({ state, job, startedAt: dueAt });
        expect(task).toBeDefined();
        const flow = createManagedTaskFlow({
          ownerKey: "agent:main:main",
          controllerId: "tests/stale-owner-binding",
          goal: "Reject partial stale-owner provenance",
          status: "running",
        });
        expect(flow).not.toBeNull();
        if (!task || !flow) {
          throw new Error("expected live task and flow owners");
        }
        const executionIdentity = createCronOwnerExecutionIdentityAdmission({
          state,
          runReceipt: initial,
          taskId: task.taskId,
          flowId: flow.flowId,
        });
        const admitted = {
          operationalRunInstance: { instanceId: "instance-stale", runId: "run-stale" },
          executionIdentityToken: createExecutionIdentityAdmissionToken("run-stale", {
            contextId: "context-stale",
            executionId: "execution-stale",
            now: dueAt,
          }),
        } satisfies AdmittedRunContext;
        executionIdentity.onPostAdmission?.(admitted);
        const db = openOpenClawStateDatabase().db;
        db.prepare("UPDATE cron_run_receipts SET owner_pid = ? WHERE receipt_id = ?").run(
          2_147_483_647,
          initial.receiptId,
        );
        const replacementPrepared = prepareCronRunReceiptClaim({
          storePath: store.storePath,
          job,
          agentId: job.agentId!,
          startedAtMs: dueAt + 1,
        });
        const replacement = runOpenClawStateWriteTransaction(({ db: transactionDb }) =>
          claimCronRunReceiptInDatabase({
            database: transactionDb,
            prepared: replacementPrepared,
            resolveAgentId: (current) => current.agentId!,
          }),
        );

        executionIdentity.onExecutionStarted?.();
        expect(
          tableExists(openOpenClawStateDatabase().db, "execution_owner_lifecycle_bindings"),
        ).toBe(false);
        finishCronRunReceipt({
          handle: replacement,
          status: "skipped",
          finishedAtMs: dueAt + 2,
        });
      },
    );
  });
});
