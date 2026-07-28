import type {
  WorkerWorkspaceQuiescence,
  WorkerWorkspaceReconcileResult,
} from "./tunnel-contract.js";
import type { WorkerWorkspaceApplyResult } from "./workspace-reconcile.js";

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

/** Rechecks both owners after renewing the remote quiescence lease. */
export async function verifyReconciledWorkspaceFinal(
  reconciliation: WorkerWorkspaceReconcileResult,
  quiescence: WorkerWorkspaceQuiescence,
): Promise<WorkerWorkspaceApplyResult | undefined> {
  if (reconciliation.applyPreparedStagedResult && reconciliation.publishStagedResult) {
    try {
      // Fence the prepared remote capture before quiescence renewal can enroll late writers.
      await runRetryableFinalFenceStep(async () => await reconciliation.verifyStable());
      // Renew quiescence and freeze any writers that appeared after the prepared capture.
      await runRetryableFinalFenceStep(async () => await quiescence.assertActive());
      // Keep this fence: a late writer can mutate before renewal enrolls and SIGSTOPs it.
      await runRetryableFinalFenceStep(async () => await reconciliation.verifyStable());
      await reconciliation.applyPreparedStagedResult();
      await reconciliation.verifyLocalStable();
      // Renew after apply so lease expiry cannot race the final publish gate.
      await runResultPreservingFinalFenceStep(async () => await quiescence.assertActive());
      // Recheck the remote owner after apply before publishing the prepared result.
      await runResultPreservingFinalFenceStep(async () => await reconciliation.verifyStable());
      await runResultPreservingFinalFenceStep(async () => await reconciliation.verifyLocalStable());
      await reconciliation.publishStagedResult();
      return reconciliation.getAppliedWorkspaceResult?.();
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
  return reconciliation.getAppliedWorkspaceResult?.();
}
