// Focused proof that manual cron admission binds exact owner-native rows.
import { describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { saveCronStore } from "../store.js";
import { run } from "./ops-run.js";
import { createCronServiceState } from "./state.js";

const fixtures = setupCronRegressionFixtures({
  prefix: "cron-service-execution-binding-",
});

describe("cron run execution binding", () => {
  it("binds the exact admitted execution to the cron receipt and task rows", async () => {
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
        expect(
          beforeAdmissionSettles
            .prepare("SELECT context_id, execution_id FROM cron_run_receipts WHERE job_id = ?")
            .get(job.id),
        ).toEqual({ context_id: null, execution_id: null });
        expect(
          beforeAdmissionSettles
            .prepare(
              "SELECT context_id, execution_id FROM task_runs WHERE source_id = ? AND runtime = 'cron'",
            )
            .get(job.id),
        ).toEqual({ context_id: null, execution_id: null });
        params.executionIdentity?.onPostAdmission?.(admitted);
        expect(
          beforeAdmissionSettles
            .prepare("SELECT context_id, execution_id FROM cron_run_receipts WHERE job_id = ?")
            .get(job.id),
        ).toEqual({ context_id: null, execution_id: null });
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
          "SELECT context_id, execution_id, status, error_text FROM cron_run_receipts WHERE job_id = ?",
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
          "SELECT context_id, execution_id, status FROM task_runs WHERE source_id = ? AND runtime = 'cron'",
        )
        .get(job.id),
    ).toEqual({
      context_id: "context-exact",
      execution_id: "execution-exact",
      status: "succeeded",
    });
  });
});
