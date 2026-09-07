import type {
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
} from "./session-accessor.lifecycle-types.js";
import type { SqliteReclamationWorker } from "./session-accessor.sqlite-reclamation-worker.js";
import type { ResolvedSqliteScope } from "./session-accessor.sqlite-scope.js";

export async function deleteDiskBudgetArchivedSessionEntry(
  params: DeleteSessionEntryLifecycleParams,
  resolved: ResolvedSqliteScope,
  worker: SqliteReclamationWorker,
): Promise<DeleteSessionEntryLifecycleResult> {
  const { deleteDiskBudgetSessionEntryLifecycle } =
    await import("./session-accessor.sqlite-lifecycle.js");
  return await deleteDiskBudgetSessionEntryLifecycle(params, resolved, worker);
}
