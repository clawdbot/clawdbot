import type {
  WorkerWorkspaceQuiescence,
  WorkerWorkspaceReconcileResult,
} from "./tunnel-contract.js";
import type { WorkerWorkspaceApplyResult } from "./workspace-reconcile.js";

/** Rechecks both owners after renewing the remote quiescence lease. */
export async function verifyReconciledWorkspaceFinal(
  reconciliation: WorkerWorkspaceReconcileResult,
  quiescence: WorkerWorkspaceQuiescence,
): Promise<WorkerWorkspaceApplyResult | undefined> {
  if (reconciliation.applyPreparedStagedResult && reconciliation.publishStagedResult) {
    try {
      await reconciliation.verifyStable();
      await quiescence.assertActive();
      await reconciliation.verifyStable();
      await reconciliation.applyPreparedStagedResult();
      await reconciliation.verifyLocalStable();
      // Applying can outlive the lease renewed above. Only publish the candidate
      // after both owners pass a fresh fence, so restart recovery cannot adopt it early.
      await quiescence.assertActive();
      await reconciliation.verifyStable();
      await reconciliation.verifyLocalStable();
      await reconciliation.publishStagedResult();
      return reconciliation.getAppliedWorkspaceResult?.();
    } catch (error) {
      await reconciliation.discardPreparedStagedResult?.().catch(() => undefined);
      throw error;
    }
  }
  await reconciliation.verifyStable();
  await reconciliation.verifyLocalStable();
  await quiescence.assertActive();
  await reconciliation.verifyStable();
  await reconciliation.verifyLocalStable();
  return reconciliation.getAppliedWorkspaceResult?.();
}
