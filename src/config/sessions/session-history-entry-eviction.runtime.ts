import type {
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
} from "./session-accessor.lifecycle-types.js";
import type { SqliteReclamationWorker } from "./session-accessor.sqlite-reclamation-worker.js";

export async function deleteDiskBudgetArchivedSessionEntry(
  params: DeleteSessionEntryLifecycleParams,
  worker: SqliteReclamationWorker,
): Promise<DeleteSessionEntryLifecycleResult> {
  const { deleteDiskBudgetSessionEntryLifecycle } =
    await import("./session-accessor.sqlite-lifecycle.js");
  return await deleteDiskBudgetSessionEntryLifecycle(params, worker);
}
