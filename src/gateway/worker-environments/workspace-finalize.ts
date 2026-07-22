import type {
  WorkerWorkspaceQuiescence,
  WorkerWorkspaceReconcileResult,
} from "./tunnel-contract.js";
import type { WorkerWorkspaceApplyResult } from "./workspace-reconcile.js";

export class WorkerWorkspaceFinalFenceError extends Error {
  readonly retryableForReclaim: boolean;

  constructor(cause: unknown, options: { retryableForReclaim: boolean }) {
    super(cause instanceof Error ? cause.message : "Worker workspace quiescence failed", { cause });
    this.name = "WorkerWorkspaceFinalFenceError";
    this.retryableForReclaim = options.retryableForReclaim;
  }
}

async function runFinalFenceStep(
  operation: () => Promise<void>,
  options: { retryableForReclaim: boolean },
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    throw new WorkerWorkspaceFinalFenceError(error, options);
  }
}

/** Rechecks both owners after renewing the remote quiescence lease. */
export async function verifyReconciledWorkspaceFinal(
  reconciliation: WorkerWorkspaceReconcileResult,
  quiescence: WorkerWorkspaceQuiescence,
): Promise<WorkerWorkspaceApplyResult | undefined> {
  if (reconciliation.applyPreparedStagedResult && reconciliation.publishStagedResult) {
    try {
      // Fence the prepared remote capture before quiescence renewal can enroll late writers.
      await runFinalFenceStep(async () => await reconciliation.verifyStable(), {
        retryableForReclaim: true,
      });
      // Renew quiescence and freeze any writers that appeared after the prepared capture.
      await runFinalFenceStep(async () => await quiescence.assertActive(), {
        retryableForReclaim: true,
      });
      // Recheck remote stability after renewal closes the late-writer race.
      await runFinalFenceStep(async () => await reconciliation.verifyStable(), {
        retryableForReclaim: true,
      });
      await reconciliation.applyPreparedStagedResult();
      await reconciliation.verifyLocalStable();
      // Renew after apply so lease expiry cannot race the final publish gate.
      await runFinalFenceStep(async () => await quiescence.assertActive(), {
        retryableForReclaim: false,
      });
      // Recheck the remote owner after apply before publishing the prepared result.
      await runFinalFenceStep(async () => await reconciliation.verifyStable(), {
        retryableForReclaim: false,
      });
      await runFinalFenceStep(async () => await reconciliation.verifyLocalStable(), {
        retryableForReclaim: false,
      });
      await reconciliation.publishStagedResult();
      return reconciliation.getAppliedWorkspaceResult?.();
    } catch (error) {
      await reconciliation.discardPreparedStagedResult?.().catch(() => undefined);
      throw error;
    }
  }
  const retryableForReclaim = !reconciliation.changed;
  await runFinalFenceStep(async () => await reconciliation.verifyStable(), { retryableForReclaim });
  await runFinalFenceStep(async () => await reconciliation.verifyLocalStable(), {
    retryableForReclaim,
  });
  await runFinalFenceStep(async () => await quiescence.assertActive(), { retryableForReclaim });
  await runFinalFenceStep(async () => await reconciliation.verifyStable(), { retryableForReclaim });
  await runFinalFenceStep(async () => await reconciliation.verifyLocalStable(), {
    retryableForReclaim,
  });
  return reconciliation.getAppliedWorkspaceResult?.();
}
