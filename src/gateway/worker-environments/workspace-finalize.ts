import type {
  WorkerWorkspaceQuiescence,
  WorkerWorkspaceReconcileResult,
} from "./tunnel-contract.js";

/** Rechecks both owners after renewing the remote quiescence lease. */
export async function verifyReconciledWorkspaceFinal(
  reconciliation: WorkerWorkspaceReconcileResult,
  quiescence: WorkerWorkspaceQuiescence,
): Promise<void> {
  await reconciliation.verifyStable();
  await reconciliation.verifyLocalStable();
  await quiescence.assertActive();
  await reconciliation.verifyStable();
  await reconciliation.verifyLocalStable();
}
