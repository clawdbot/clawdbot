import type {
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
} from "./session-accessor.lifecycle-types.js";

export async function deleteDiskBudgetArchivedSessionEntry(
  params: DeleteSessionEntryLifecycleParams,
): Promise<DeleteSessionEntryLifecycleResult> {
  const { deleteDiskBudgetSessionEntryLifecycle } =
    await import("./session-accessor.sqlite-lifecycle.js");
  return await deleteDiskBudgetSessionEntryLifecycle(params);
}
