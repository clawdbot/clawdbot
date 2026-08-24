import { markPendingDelegateSpawnAccepted } from "./delegate-store.js";
import type { PendingContinuationDelegate } from "./types.js";

export async function commitPendingDelegateSpawnAcceptance(
  delegate: Pick<PendingContinuationDelegate, "flowId" | "expectedRevision" | "task">,
  childSessionKey: string,
  requireWriteSuccess: boolean,
  rollbackAccepted?: () => Promise<void>,
): Promise<void> {
  try {
    const committed = markPendingDelegateSpawnAccepted(
      delegate,
      childSessionKey,
      requireWriteSuccess ? { requireWriteSuccess: true } : {},
    );
    if (!committed) {
      throw new Error("Continuation delegate source acceptance became stale.");
    }
  } catch (error) {
    await rollbackAccepted?.();
    throw error;
  }
}
