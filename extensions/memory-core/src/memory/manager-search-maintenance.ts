// Memory Core owns detached search-time index maintenance lifecycle.
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";

type MemorySearchMaintenanceManager = {
  sync(params: { reason: string; force: true }): Promise<void>;
  status(): { dirty?: boolean };
  close(): Promise<void>;
};

export async function runMemorySearchMaintenance<DirtyGeneration>(params: {
  reason: string;
  takeDirtyGeneration: () => DirtyGeneration;
  restoreDirtyGeneration: (generation: DirtyGeneration) => void;
  acquireManager: () => Promise<MemorySearchMaintenanceManager | null>;
}): Promise<void> {
  const dirtyGeneration = params.takeDirtyGeneration();
  let manager: MemorySearchMaintenanceManager | null;
  try {
    manager = await params.acquireManager();
  } catch (err) {
    params.restoreDirtyGeneration(dirtyGeneration);
    throw toErrorObject(err, "Memory search maintenance manager acquisition failed");
  }
  if (!manager) {
    params.restoreDirtyGeneration(dirtyGeneration);
    return;
  }

  let maintenanceError: Error | undefined;
  try {
    // The transient manager has no watcher state. Force every source represented
    // by the handed-off generation while the default manager serves published reads.
    await manager.sync({ reason: params.reason, force: true });
    if (manager.status().dirty === true) {
      // A provider fallback may deliberately resolve in keyword-only mode while
      // retaining retry state. Return that incomplete generation to its serving owner.
      params.restoreDirtyGeneration(dirtyGeneration);
    }
  } catch (err) {
    params.restoreDirtyGeneration(dirtyGeneration);
    maintenanceError = toErrorObject(err, "Memory search maintenance failed");
  }
  try {
    await manager.close();
  } catch (err) {
    maintenanceError ??= toErrorObject(err, "Memory search maintenance close failed");
  }
  if (maintenanceError) {
    throw maintenanceError;
  }
}
