import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  WorkerWorkspaceQuiescence,
  WorkerWorkspaceReconcileResult,
} from "./tunnel-contract.js";
import {
  createWorkspaceReconcileMetrics,
  type WorkspaceReconcileMetrics,
} from "./workspace-hash-memo.js";
import type { WorkerWorkspaceApplyResult } from "./workspace-reconcile.js";

const workspaceReconcileLog = createSubsystemLogger("gateway/worker-workspace");

export class WorkerWorkspaceFinalFenceError extends Error {
  readonly reclaimDisposition: "retry" | "preserve-result";

  constructor(cause: unknown, reclaimDisposition: "retry" | "preserve-result") {
    super(cause instanceof Error ? cause.message : "Worker workspace quiescence failed", { cause });
    this.name = "WorkerWorkspaceFinalFenceError";
    this.reclaimDisposition = reclaimDisposition;
  }
}

async function runFinalFenceStep(
  operation: () => Promise<void>,
  reclaimDisposition: WorkerWorkspaceFinalFenceError["reclaimDisposition"],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    throw new WorkerWorkspaceFinalFenceError(error, reclaimDisposition);
  }
}

const runRetryableFinalFenceStep = async (operation: () => Promise<void>): Promise<void> =>
  await runFinalFenceStep(operation, "retry");

const runResultPreservingFinalFenceStep = async (operation: () => Promise<void>): Promise<void> =>
  await runFinalFenceStep(operation, "preserve-result");

type WorkspaceReconcileOutcome = "failed" | "succeeded";

const workspaceReconcileReporters = new WeakMap<
  WorkerWorkspaceReconcileResult,
  (outcome: WorkspaceReconcileOutcome) => void
>();

/** Runs one reconciliation with shared metrics and logs them once the final fence settles. */
export async function runInstrumentedWorkspaceReconcile(
  run: (metrics: WorkspaceReconcileMetrics) => Promise<WorkerWorkspaceReconcileResult>,
): Promise<WorkerWorkspaceReconcileResult> {
  const metrics = createWorkspaceReconcileMetrics();
  const startedAt = performance.now();
  const report = (outcome: WorkspaceReconcileOutcome) => {
    workspaceReconcileLog.debug("worker workspace reconcile completed", {
      outcome,
      durationMs: performance.now() - startedAt,
      ...metrics,
    });
  };
  try {
    const reconciliation = await run(metrics);
    workspaceReconcileReporters.set(reconciliation, report);
    return reconciliation;
  } catch (error) {
    report("failed");
    throw error;
  }
}

function reportWorkspaceReconcile(
  reconciliation: WorkerWorkspaceReconcileResult,
  outcome: WorkspaceReconcileOutcome,
): void {
  const reporter = workspaceReconcileReporters.get(reconciliation);
  workspaceReconcileReporters.delete(reconciliation);
  reporter?.(outcome);
}

/** Rechecks both owners after renewing the remote quiescence lease. */
export async function verifyReconciledWorkspaceFinal(
  reconciliation: WorkerWorkspaceReconcileResult,
  quiescence: WorkerWorkspaceQuiescence,
): Promise<WorkerWorkspaceApplyResult | undefined> {
  let succeeded = false;
  try {
    if (reconciliation.publishStagedResult) {
      try {
        // Fence the prepared remote capture before quiescence renewal can enroll late writers.
        await runRetryableFinalFenceStep(async () => await reconciliation.verifyStable());
        // Renew quiescence and freeze any writers that appeared after the prepared capture.
        await runRetryableFinalFenceStep(async () => await quiescence.assertActive());
        // Keep this fence: a late writer can mutate before renewal enrolls and SIGSTOPs it.
        await runRetryableFinalFenceStep(async () => await reconciliation.verifyStable());
        await reconciliation.applyPreparedStagedResult?.();
        await reconciliation.verifyLocalStable();
        // Renew after apply so lease expiry cannot race the final publish gate.
        await runResultPreservingFinalFenceStep(async () => await quiescence.assertActive());
        // Recheck the remote owner after apply before publishing the prepared result.
        await runResultPreservingFinalFenceStep(async () => await reconciliation.verifyStable());
        await runResultPreservingFinalFenceStep(
          async () => await reconciliation.verifyLocalStable(),
        );
        await reconciliation.publishStagedResult();
        const applied = reconciliation.getAppliedWorkspaceResult?.();
        succeeded = true;
        return applied;
      } catch (error) {
        await reconciliation.discardPreparedStagedResult?.().catch(() => undefined);
        throw error;
      }
    }
    const runFenceStep = reconciliation.changed
      ? runResultPreservingFinalFenceStep
      : runRetryableFinalFenceStep;
    await runFenceStep(async () => await reconciliation.verifyStable());
    await runFenceStep(async () => await reconciliation.verifyLocalStable());
    await runFenceStep(async () => await quiescence.assertActive());
    await runFenceStep(async () => await reconciliation.verifyStable());
    await runFenceStep(async () => await reconciliation.verifyLocalStable());
    const applied = reconciliation.getAppliedWorkspaceResult?.();
    succeeded = true;
    return applied;
  } finally {
    reportWorkspaceReconcile(reconciliation, succeeded ? "succeeded" : "failed");
  }
}
